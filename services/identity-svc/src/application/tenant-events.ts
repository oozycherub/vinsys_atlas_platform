import { Inject, Injectable } from '@nestjs/common';
import {
  TenantActivated,
  TenantOffboardingStarted,
  TenantProvisioned,
  TenantPurged,
  TenantReactivated,
  TenantSuspended,
  type TenantStatus,
} from '@atlas/contracts';
import {
  CLOCK,
  type Clock,
  type ConsumedEvent,
  type EventHandler,
  newId,
  setTenantContext,
  type Tx,
} from '@atlas/platform';
import { bootstrapAdmin } from '../domain/user';
import {
  LINK_DELIVERY,
  type LinkDelivery,
  SSO_REPOSITORY,
  type SsoRepository,
  TENANT_ACCESS_REPOSITORY,
  type TenantAccessRepository,
  USER_REPOSITORY,
  type UserRepository,
} from './ports';
import { UserService } from './user.service';

export const IDENTITY_CONSUMER = 'identity-svc.tenant-lifecycle';

/**
 * Keeps identity-svc's view of tenant status current (docs/prompts/02-identity-svc.md §5).
 * Suspension needs no token revocation: every token exchange re-checks this projection.
 */
@Injectable()
export class TenantEventHandlers {
  constructor(
    @Inject(TENANT_ACCESS_REPOSITORY) private readonly tenants: TenantAccessRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SSO_REPOSITORY) private readonly sso: SsoRepository,
    @Inject(LINK_DELIVERY) private readonly delivery: LinkDelivery,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly userService: UserService,
  ) {}

  handlers(): Record<string, EventHandler> {
    const status =
      (to: TenantStatus): EventHandler =>
      (tx, event) =>
        this.setStatus(tx, event, to);
    return {
      [TenantProvisioned.topic]: (tx, event) => this.provisioned(tx, event),
      [TenantActivated.topic]: status('active'),
      [TenantSuspended.topic]: status('suspended'),
      [TenantReactivated.topic]: status('active'),
      [TenantOffboardingStarted.topic]: status('offboarding'),
      [TenantPurged.topic]: (tx, event) => this.purged(tx, event),
    };
  }

  private async provisioned(tx: Tx, event: ConsumedEvent): Promise<() => Promise<void>> {
    const payload = event.payload as {
      tenant_id: string;
      slug: string;
      bootstrap_admin_email?: string;
    };
    await this.tenants.upsert(tx, {
      tenantId: payload.tenant_id,
      slug: payload.slug,
      status: 'provisioning',
    });
    if (!payload.bootstrap_admin_email) return noop;
    await setTenantContext(tx, payload.tenant_id);
    const { user, expiresAt } = bootstrapAdmin({
      id: newId(),
      tenantId: payload.tenant_id,
      email: payload.bootstrap_admin_email,
      now: this.clock.now(),
    });
    const link = await this.userService.createInvitation(
      tx,
      user,
      payload.slug,
      expiresAt,
      'tenant-svc',
    );
    return () => this.delivery.send({ kind: 'invitation', ...link });
  }

  private async setStatus(tx: Tx, event: ConsumedEvent, status: TenantStatus): Promise<undefined> {
    const tenantId = (event.payload as { tenant_id: string }).tenant_id;
    const current = await this.tenants.findById(tx, tenantId);
    // Events for one tenant arrive in order (same Kafka key), so this only skips unknown tenants.
    if (current) await this.tenants.upsert(tx, { ...current, status });
    return undefined;
  }

  /** Purge: hard-delete every user (links and tokens cascade) and the SSO config. */
  private async purged(tx: Tx, event: ConsumedEvent): Promise<undefined> {
    const tenantId = (event.payload as { tenant_id: string }).tenant_id;
    await this.setStatus(tx, event, 'purged');
    await setTenantContext(tx, tenantId);
    await this.users.deleteAll(tx);
    await this.sso.deleteForTenant(tx);
    return undefined;
  }
}

const noop = (): Promise<void> => Promise.resolve();
