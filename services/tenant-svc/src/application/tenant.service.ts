import { Inject, Injectable } from '@nestjs/common';
import {
  TenantActivated,
  TenantDataKeyRotated,
  TenantOffboardingStarted,
  TenantProvisioned,
  TenantPurged,
  TenantReactivated,
  TenantSettingsUpdated,
  TenantSuspended,
  type IsolationTier,
  type TenantStatus,
} from '@atlas/contracts';
import {
  type AppError,
  appendOutbox,
  BadRequestError,
  canAccessTenant,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  DomainRuleError,
  ForbiddenError,
  hashRequest,
  isSuperAdmin,
  isUuid,
  newId,
  NotFoundError,
  PreconditionFailedError,
  type Principal,
  runIdempotent,
  setTenantContext,
  type Tx,
  ValidationError,
  withSystemTx,
} from '@atlas/platform';
import { placeTenant } from '../domain/cell-placement';
import { TenantDomainError } from '../domain/errors';
import {
  assertMayChangeSettings,
  changedKeys,
  type RetentionPolicy,
  type TenantSettings,
} from '../domain/settings';
import { assertValidSlug } from '../domain/slug';
import {
  applyLifecycle,
  assertCanRotateDataKey,
  assertVersion,
  createTenant,
  type LifecycleAction,
  rename,
  replaceRetentionPolicy,
  replaceSettings,
  rotateDataKey,
  shredsDataKeys,
  type StatusChange,
  type Tenant,
} from '../domain/tenant';
import {
  KEY_MANAGEMENT,
  type KeyManagementPort,
  TENANT_REPOSITORY,
  TENANT_SERVICE_SETTINGS,
  type TenantRepository,
  type TenantServiceSettings,
} from './ports';
import { type DirectoryEntry, type TenantPage, type TenantView, toView } from './tenant-view';

export interface CreateTenantCommand {
  slug: string;
  displayName: string;
  dataRegion: string;
  isolationTier: IsolationTier;
  /** Passed through to identity-svc in the provisioned event; never stored by tenant-svc. */
  bootstrapAdminEmail?: string;
}

export interface ListTenantsQuery {
  status?: TenantStatus;
  dataRegion?: string;
  limit: number;
  cursor?: string;
}

const STATUS_EVENTS = {
  activate: TenantActivated,
  suspend: TenantSuspended,
  reactivate: TenantReactivated,
  purge: TenantPurged,
} as const;

/** Use cases for the tenant directory. Each public method is one transaction. */
@Injectable()
export class TenantService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(TENANT_REPOSITORY) private readonly tenants: TenantRepository,
    @Inject(KEY_MANAGEMENT) private readonly kms: KeyManagementPort,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TENANT_SERVICE_SETTINGS) private readonly settings: TenantServiceSettings,
  ) {}

  async create(
    actor: Principal,
    command: CreateTenantCommand,
    idempotencyKey: string,
  ): Promise<{ status: number; body: TenantView; replayed: boolean }> {
    const request = {
      scope: `tenant-svc:platform:${actor.subject}`,
      key: idempotencyKey,
      requestHash: hashRequest('POST', '/v1/tenants', command),
    };
    return runIdempotent(this.db, request, (tx) =>
      translate(async () => {
        const slug = assertValidSlug(command.slug);
        if (await this.tenants.findBySlug(tx, slug)) {
          throw new TenantDomainError(
            'conflict',
            'TENANT_SLUG_TAKEN',
            `The slug "${slug}" is already in use.`,
          );
        }
        const id = newId();
        const cellId = placeTenant(this.settings.cells, {
          tenantId: id,
          slug,
          region: command.dataRegion,
          tier: command.isolationTier,
        });
        const { wrappedKey } = await this.kms.generateDataKey(this.settings.kmsKeyRef);
        const now = this.clock.now();
        const { tenant, change, dataKey } = createTenant({
          id,
          slug,
          displayName: command.displayName,
          isolationTier: command.isolationTier,
          dataRegion: command.dataRegion,
          cellId,
          kmsKeyRef: this.settings.kmsKeyRef,
          wrappedDek: wrappedKey,
          actor: actor.subject,
          now,
        });
        await this.tenants.insert(tx, tenant);
        await this.tenants.insertDataKey(tx, dataKey);
        await this.tenants.appendHistory(tx, change);
        await this.emit(
          tx,
          tenant.id,
          TenantProvisioned.build({
            tenantId: tenant.id,
            aggregateId: tenant.id,
            payload: {
              tenant_id: tenant.id,
              slug: tenant.slug,
              cell_id: tenant.cellId,
              data_region: tenant.dataRegion,
              isolation_tier: tenant.isolationTier,
              display_name: tenant.displayName,
              ...(command.bootstrapAdminEmail
                ? { bootstrap_admin_email: command.bootstrapAdminEmail }
                : {}),
              occurred_at: now.toISOString(),
            },
          }),
        );
        return { status: 201, body: toView(tenant) };
      }),
    );
  }

  async get(actor: Principal, tenantId: string): Promise<TenantView> {
    return withSystemTx(this.db, async (tx) => toView(await this.loadVisible(tx, actor, tenantId)));
  }

  async list(query: ListTenantsQuery): Promise<TenantPage> {
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await withSystemTx(this.db, (tx) =>
      this.tenants.list(tx, {
        limit: query.limit + 1,
        ...(query.status ? { status: query.status } : {}),
        ...(query.dataRegion ? { dataRegion: query.dataRegion } : {}),
        ...(after ? { after } : {}),
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toView),
      next_cursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  async rename(
    actor: Principal,
    tenantId: string,
    displayName: string,
    ifMatch: number,
  ): Promise<TenantView> {
    return this.mutate(actor, tenantId, ifMatch, (tenant, now) => rename(tenant, displayName, now));
  }

  async replaceSettings(
    actor: Principal,
    tenantId: string,
    settings: TenantSettings,
    ifMatch: number,
  ): Promise<TenantView> {
    return this.mutate(
      actor,
      tenantId,
      ifMatch,
      (tenant, now) => {
        assertMayChangeSettings(tenant.settings, settings, isSuperAdmin(actor));
        return replaceSettings(tenant, settings, now);
      },
      async (tx, before, after, now) => {
        await this.emit(
          tx,
          after.id,
          TenantSettingsUpdated.build({
            tenantId: after.id,
            aggregateId: after.id,
            payload: {
              tenant_id: after.id,
              version: after.version,
              changed_keys: changedKeys(before.settings, after.settings),
              actor: actor.subject,
              occurred_at: now.toISOString(),
            },
          }),
        );
      },
    );
  }

  async replaceRetentionPolicy(
    actor: Principal,
    tenantId: string,
    policy: RetentionPolicy,
    ifMatch: number,
  ): Promise<TenantView> {
    return this.mutate(
      actor,
      tenantId,
      ifMatch,
      (tenant, now) => replaceRetentionPolicy(tenant, policy, now),
      // Services that erase on a schedule (proctoring frames, interview audio) re-read it.
      async (tx, before, after, now) => {
        const changed = (Object.keys(after.retentionPolicy) as (keyof RetentionPolicy)[])
          .filter((k) => before.retentionPolicy[k] !== after.retentionPolicy[k])
          .map((k) => `retention_policy.${k}`);
        if (changed.length === 0) return;
        await this.emit(
          tx,
          after.id,
          TenantSettingsUpdated.build({
            tenantId: after.id,
            aggregateId: after.id,
            payload: {
              tenant_id: after.id,
              version: after.version,
              changed_keys: changed,
              actor: actor.subject,
              occurred_at: now.toISOString(),
            },
          }),
        );
      },
    );
  }

  async changeLifecycle(
    actor: Principal,
    tenantId: string,
    action: LifecycleAction,
    reason: string | null,
    ifMatch?: number,
  ): Promise<TenantView> {
    return withSystemTx(this.db, (tx) =>
      translate(async () => {
        const current = await this.loadVisible(tx, actor, tenantId, true);
        if (ifMatch !== undefined) assertVersion(current, ifMatch);
        const now = this.clock.now();
        const { tenant, change } = applyLifecycle(current, action, {
          actor: actor.subject,
          now,
          reason,
          purgeGraceDays: this.settings.purgeGraceDays,
        });
        await this.save(tx, tenant, current.version);
        if (shredsDataKeys(tenant)) await this.tenants.destroyDataKeys(tx, tenant.id, now);
        await this.tenants.appendHistory(tx, change);
        await this.emit(tx, tenant.id, this.lifecycleEvent(action, tenant, change));
        return toView(tenant);
      }),
    );
  }

  /**
   * Adds a new key version and retires the old one. Old versions are kept so existing ciphertext
   * stays readable. Send If-Match so a retried request cannot rotate twice.
   */
  async rotateDataKey(actor: Principal, tenantId: string, ifMatch?: number): Promise<TenantView> {
    return withSystemTx(this.db, (tx) =>
      translate(async () => {
        const current = await this.loadVisible(tx, actor, tenantId, true);
        if (ifMatch !== undefined) assertVersion(current, ifMatch);
        assertCanRotateDataKey(current);
        const { wrappedKey } = await this.kms.generateDataKey(current.kmsKeyRef);
        const now = this.clock.now();
        const { tenant, dataKey, retiredVersion } = rotateDataKey(current, wrappedKey, now);
        await this.save(tx, tenant, current.version);
        // Retire first: at most one active key per tenant (ux_tenant_data_keys_active).
        await this.tenants.retireDataKey(tx, tenant.id, retiredVersion, now);
        await this.tenants.insertDataKey(tx, dataKey);
        await this.emit(
          tx,
          tenant.id,
          TenantDataKeyRotated.build({
            tenantId: tenant.id,
            aggregateId: tenant.id,
            payload: {
              tenant_id: tenant.id,
              dek_version: tenant.dekVersion,
              actor: actor.subject,
              occurred_at: now.toISOString(),
            },
          }),
        );
        return toView(tenant);
      }),
    );
  }

  /**
   * Wrapped data keys for services that encrypt tenant data (profile-svc and later bricks). The
   * plaintext never leaves the KMS boundary here: callers unwrap with their own KMS access.
   * Purged tenants have no keys (crypto-shredded) and answer 404.
   */
  /** Settings for platform services (matching weights, limits); never for purged tenants. */
  async settingsFor(tenantId: string): Promise<{
    tenant_id: string;
    version: number;
    settings: TenantSettings;
    retention_policy: RetentionPolicy;
  }> {
    return withSystemTx(this.db, async (tx) => {
      const tenant = await this.tenants.findById(tx, tenantId);
      if (!tenant || tenant.status === 'purged') {
        throw new NotFoundError('TENANT_NOT_FOUND', 'Tenant not found.');
      }
      return {
        tenant_id: tenantId,
        version: tenant.version,
        settings: tenant.settings,
        retention_policy: tenant.retentionPolicy,
      };
    });
  }

  async dataKeys(tenantId: string): Promise<{
    tenant_id: string;
    keys: { dek_version: number; kms_key_ref: string; wrapped_key: string; active: boolean }[];
  }> {
    return withSystemTx(this.db, async (tx) => {
      const tenant = await this.tenants.findById(tx, tenantId);
      const keys =
        tenant && tenant.status !== 'purged' ? await this.tenants.listDataKeys(tx, tenantId) : [];
      if (keys.length === 0) throw new NotFoundError('TENANT_NOT_FOUND', 'Tenant not found.');
      return {
        tenant_id: tenantId,
        keys: keys.map((k) => ({
          dek_version: k.version,
          kms_key_ref: k.kmsKeyRef,
          wrapped_key: Buffer.from(k.wrappedKey).toString('base64'),
          active: k.retiredAt === null,
        })),
      };
    });
  }

  /** Gateway lookup by subdomain. Purged tenants are not resolvable. */
  async resolve(slug: string): Promise<DirectoryEntry> {
    const tenant = await withSystemTx(this.db, (tx) => this.tenants.findBySlug(tx, slug));
    if (!tenant || tenant.status === 'purged') {
      throw new NotFoundError('TENANT_NOT_FOUND', `No tenant is registered for "${slug}".`);
    }
    return {
      tenant_id: tenant.id,
      cell_id: tenant.cellId,
      data_region: tenant.dataRegion,
      isolation_tier: tenant.isolationTier,
      status: tenant.status,
    };
  }

  /**
   * Loads a tenant the caller may see. Callers from another tenant get 404, not 403, so tenant
   * ids cannot be probed (docs/prompts/01-tenant-svc.md, acceptance test 6).
   */
  private async loadVisible(
    tx: Tx,
    actor: Principal,
    tenantId: string,
    forUpdate = false,
  ): Promise<Tenant> {
    const tenant = canAccessTenant(actor, tenantId)
      ? await this.tenants.findById(tx, tenantId, { forUpdate })
      : null;
    if (!tenant) throw new NotFoundError('TENANT_NOT_FOUND', 'Tenant not found.');
    return tenant;
  }

  private async mutate(
    actor: Principal,
    tenantId: string,
    ifMatch: number,
    change: (tenant: Tenant, now: Date) => Tenant,
    afterSave?: (tx: Tx, before: Tenant, after: Tenant, now: Date) => Promise<void>,
  ): Promise<TenantView> {
    return withSystemTx(this.db, (tx) =>
      translate(async () => {
        const current = await this.loadVisible(tx, actor, tenantId, true);
        assertVersion(current, ifMatch);
        const now = this.clock.now();
        const next = change(current, now);
        await this.save(tx, next, current.version);
        await afterSave?.(tx, current, next, now);
        return toView(next);
      }),
    );
  }

  private async save(tx: Tx, tenant: Tenant, expectedVersion: number): Promise<void> {
    if (!(await this.tenants.update(tx, tenant, expectedVersion))) {
      throw new TenantDomainError(
        'precondition_failed',
        'VERSION_MISMATCH',
        'The tenant was modified concurrently. Re-read and retry.',
      );
    }
  }

  /** Tenant-scoped events need the tenant context so the outbox RLS policy accepts them. */
  private async emit(
    tx: Tx,
    tenantId: string,
    event: Parameters<typeof appendOutbox>[1],
  ): Promise<void> {
    await setTenantContext(tx, tenantId);
    await appendOutbox(tx, event);
  }

  private lifecycleEvent(
    action: LifecycleAction,
    tenant: Tenant,
    change: StatusChange,
  ): Parameters<typeof appendOutbox>[1] {
    const base = {
      tenant_id: tenant.id,
      from_status: change.from ?? 'provisioning',
      to_status: change.to,
      reason: change.reason,
      actor: change.actor,
      occurred_at: change.occurredAt.toISOString(),
    } as const;
    if (action === 'offboard') {
      if (!tenant.purgeNotBefore)
        throw new Error('Invariant: offboarding tenants have purge_not_before.');
      return TenantOffboardingStarted.build({
        tenantId: tenant.id,
        aggregateId: tenant.id,
        payload: { ...base, purge_not_before: tenant.purgeNotBefore.toISOString() },
      });
    }
    return STATUS_EVENTS[action].build({
      tenantId: tenant.id,
      aggregateId: tenant.id,
      payload: base,
    });
  }
}

/** Maps framework-free domain errors to HTTP-aware platform errors at the application boundary. */
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof TenantDomainError)) throw error;
    const mapped: AppError = {
      validation: () => new BadRequestError(error.code, error.message),
      forbidden: () => new ForbiddenError(error.message, error.code),
      not_found: () => new NotFoundError(error.code, error.message),
      conflict: () => new ConflictError(error.code, error.message),
      rule: () => new DomainRuleError(error.code, error.message),
      precondition_failed: () => new PreconditionFailedError(error.code, error.message),
    }[error.kind]();
    throw mapped;
  }
}

function encodeCursor(tenant: Tenant): string {
  return Buffer.from(JSON.stringify([tenant.createdAt.toISOString(), tenant.id])).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime()) || typeof id !== 'string' || !isUuid(id)) {
      throw new Error('bad cursor');
    }
    return { createdAt: date, id };
  } catch {
    throw new ValidationError('The cursor is invalid.', [
      { path: 'query.cursor', message: 'Malformed cursor' },
    ]);
  }
}
