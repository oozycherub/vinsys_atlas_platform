import { Inject, Injectable } from '@nestjs/common';
import { UserDeactivated, UserInvited, UserRolesChanged } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  DomainRuleError,
  isUuid,
  newId,
  NotFoundError,
  type Principal,
  randomToken,
  sha256,
  type Tx,
  ValidationError,
  withTenantTx,
} from '@atlas/platform';
import { IdentityDomainError } from '../domain/errors';
import {
  assertVersion,
  deactivateUser,
  INVITATION_TTL_MS,
  inviteUser,
  patchUser,
  rolesChanged,
  type User,
  type UserPatch,
} from '../domain/user';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepository,
  IDENTITY_SETTINGS,
  type IdentitySettings,
  LINK_DELIVERY,
  type LinkDelivery,
  TENANT_ACCESS_REPOSITORY,
  type TenantAccessRepository,
  USER_REPOSITORY,
  type UserRepository,
} from './ports';
import { actingTenant, actorOf } from './tenant-scope';
import { translate } from './translate';
import { toUserView, type UserPage, type UserView } from './views';

export interface InviteCommand {
  tenantId?: string;
  email: string;
  displayName: string;
  roles: readonly string[];
  businessUnitIds?: readonly string[];
}

const UNIQUE_VIOLATION = '23505';

/** Invitation link sent after commit. Kept out of events and logs (it is a bearer secret). */
export interface PendingLink {
  tenantId: string;
  email: string;
  url: string;
  expiresAt: Date;
}

export function linkUrl(template: string, slug: string, path: string, token: string): string {
  return `${template.replace('{slug}', slug)}${path}?token=${encodeURIComponent(token)}`;
}

/** Tenant user management. Every method is one tenant-scoped (RLS) transaction. */
@Injectable()
export class UserService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
    @Inject(TENANT_ACCESS_REPOSITORY) private readonly tenants: TenantAccessRepository,
    @Inject(LINK_DELIVERY) private readonly delivery: LinkDelivery,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
  ) {}

  async invite(principal: Principal, command: InviteCommand): Promise<UserView> {
    const tenantId = actingTenant(principal, command.tenantId);
    const { view, link } = await withTenantTx(this.db, tenantId, (tx) =>
      translate(async () => {
        const access = await this.tenants.findById(tx, tenantId);
        if (!access || !['provisioning', 'active'].includes(access.status)) {
          throw new DomainRuleError(
            'TENANT_NOT_ACTIVE',
            'Users can only be invited to provisioning or active tenants.',
          );
        }
        const { user, expiresAt } = inviteUser({
          id: newId(),
          tenantId,
          email: command.email,
          displayName: command.displayName,
          roles: command.roles,
          ...(command.businessUnitIds ? { businessUnitIds: command.businessUnitIds } : {}),
          actor: actorOf(principal),
          now: this.clock.now(),
        });
        const link = await this.createInvitation(
          tx,
          user,
          access.slug,
          expiresAt,
          principal.subject,
        );
        return { view: toUserView(user), link };
      }),
    );
    await this.delivery.send({ kind: 'invitation', ...link });
    return view;
  }

  /**
   * Inserts the invited user, its single-use invitation and the event, in the caller's
   * transaction. Also used by the tenant-provisioned consumer for the bootstrap admin.
   */
  async createInvitation(
    tx: Tx,
    user: User,
    slug: string,
    expiresAt: Date,
    invitedBy: string,
  ): Promise<PendingLink> {
    if (await this.users.findByEmail(tx, user.email)) throw emailTaken();
    try {
      await this.users.insert(tx, user);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw emailTaken();
      throw error;
    }
    return this.issueInvitation(tx, user, slug, expiresAt, invitedBy);
  }

  /**
   * Sends a fresh invitation to a user who has not accepted yet; earlier links stop working.
   * Delivery happens after commit and can fail, so admins need this to recover.
   */
  async resendInvitation(
    principal: Principal,
    userId: string,
    tenantHint?: string,
  ): Promise<UserView> {
    const tenantId = actingTenant(principal, tenantHint);
    const { view, link } = await withTenantTx(this.db, tenantId, async (tx) => {
      const user = await this.load(tx, userId, true);
      if (user.status !== 'invited') {
        throw new DomainRuleError('USER_NOT_INVITED', 'Only invited users can be re-invited.');
      }
      const access = await this.tenants.findById(tx, tenantId);
      if (!access || !['provisioning', 'active'].includes(access.status)) {
        throw new DomainRuleError('TENANT_NOT_ACTIVE', 'The tenant is not active.');
      }
      const now = this.clock.now();
      await this.credentials.supersedeInvitations(tx, user.id, now);
      const link = await this.issueInvitation(
        tx,
        user,
        access.slug,
        new Date(now.getTime() + INVITATION_TTL_MS),
        principal.subject,
      );
      return { view: toUserView(user), link };
    });
    await this.delivery.send({ kind: 'invitation', ...link });
    return view;
  }

  private async issueInvitation(
    tx: Tx,
    user: User,
    slug: string,
    expiresAt: Date,
    invitedBy: string,
  ): Promise<PendingLink> {
    const token = randomToken();
    await this.credentials.insertInvitation(tx, {
      id: newId(),
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash: sha256(token),
      invitedBy,
      expiresAt,
    });
    await appendOutbox(
      tx,
      UserInvited.build({
        tenantId: user.tenantId,
        aggregateId: user.id,
        payload: {
          tenant_id: user.tenantId,
          user_id: user.id,
          email: user.email,
          roles: [...user.roles],
          invited_by: invitedBy,
          expires_at: expiresAt.toISOString(),
          occurred_at: this.clock.now().toISOString(),
        },
      }),
    );
    return {
      tenantId: user.tenantId,
      email: user.email,
      url: linkUrl(this.settings.appBaseUrl, slug, '/invite', token),
      expiresAt,
    };
  }

  async list(
    principal: Principal,
    query: { tenantId?: string; limit: number; cursor?: string },
  ): Promise<UserPage> {
    const tenantId = actingTenant(principal, query.tenantId);
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      this.users.list(tx, { limit: query.limit + 1, ...(after ? { after } : {}) }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toUserView),
      next_cursor: rows.length > query.limit && last ? encodeCursor(last) : null,
    };
  }

  async get(principal: Principal, userId: string, tenantHint?: string): Promise<UserView> {
    const tenantId = actingTenant(principal, tenantHint);
    return withTenantTx(this.db, tenantId, async (tx) => toUserView(await this.load(tx, userId)));
  }

  async patch(
    principal: Principal,
    userId: string,
    patch: UserPatch,
    ifMatch: number,
    tenantHint?: string,
  ): Promise<UserView> {
    const tenantId = actingTenant(principal, tenantHint);
    return withTenantTx(this.db, tenantId, (tx) =>
      translate(async () => {
        const current = await this.load(tx, userId, true);
        assertVersion(current, ifMatch);
        const now = this.clock.now();
        const next = patchUser(current, patch, actorOf(principal), now);
        await this.save(tx, next, current.version);
        if (rolesChanged(current, next)) {
          await appendOutbox(
            tx,
            UserRolesChanged.build({
              tenantId,
              aggregateId: next.id,
              payload: {
                tenant_id: tenantId,
                user_id: next.id,
                roles: [...next.roles],
                previous_roles: [...current.roles],
                actor: principal.subject,
                occurred_at: now.toISOString(),
              },
            }),
          );
        }
        return toUserView(next);
      }),
    );
  }

  /** Deactivation also revokes every refresh token, so the user is out within one access-token TTL. */
  async deactivate(
    principal: Principal,
    userId: string,
    ifMatch: number | undefined,
    tenantHint?: string,
  ): Promise<UserView> {
    const tenantId = actingTenant(principal, tenantHint);
    return withTenantTx(this.db, tenantId, (tx) =>
      translate(async () => {
        const current = await this.load(tx, userId, true);
        if (ifMatch !== undefined) assertVersion(current, ifMatch);
        const now = this.clock.now();
        const next = deactivateUser(current, actorOf(principal), now);
        await this.save(tx, next, current.version);
        await this.credentials.revokeAllForUser(tx, next.id, now);
        await appendOutbox(
          tx,
          UserDeactivated.build({
            tenantId,
            aggregateId: next.id,
            payload: {
              tenant_id: tenantId,
              user_id: next.id,
              actor: principal.subject,
              occurred_at: now.toISOString(),
            },
          }),
        );
        return toUserView(next);
      }),
    );
  }

  private async load(tx: Tx, userId: string, forUpdate = false): Promise<User> {
    const user = isUuid(userId) ? await this.users.findById(tx, userId, { forUpdate }) : null;
    if (!user) throw new NotFoundError('USER_NOT_FOUND', 'User not found.');
    return user;
  }

  private async save(tx: Tx, user: User, expectedVersion: number): Promise<void> {
    if (!(await this.users.update(tx, user, expectedVersion))) {
      throw new IdentityDomainError(
        'precondition_failed',
        'VERSION_MISMATCH',
        'The user was modified concurrently. Re-read and retry.',
      );
    }
  }
}

function emailTaken(): ConflictError {
  return new ConflictError('USER_EMAIL_TAKEN', 'A user with this email already exists.');
}

function encodeCursor(user: User): string {
  return Buffer.from(JSON.stringify([user.createdAt.toISOString(), user.id])).toString('base64url');
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
