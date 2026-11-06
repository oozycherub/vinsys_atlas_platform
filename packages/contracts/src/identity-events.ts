import { z } from 'zod';
import { defineEvent } from './event';
import { TENANT_ROLES } from './roles';

/** identity-svc events (docs/prompts/02-identity-svc.md §5). No secrets or tokens, ever. */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

const userRef = { tenant_id: uuid, user_id: uuid };

export const UserInvited = defineEvent(
  'identity.user.invited.v1',
  'user',
  z.object({
    ...userRef,
    email: z.string().email(),
    roles: z.array(z.enum(TENANT_ROLES)),
    invited_by: z.string(),
    expires_at: isoTime,
    occurred_at: isoTime,
  }),
);

export const UserActivated = defineEvent(
  'identity.user.activated.v1',
  'user',
  z.object({ ...userRef, occurred_at: isoTime }),
);

export const UserDeactivated = defineEvent(
  'identity.user.deactivated.v1',
  'user',
  z.object({ ...userRef, actor: z.string(), occurred_at: isoTime }),
);

export const UserRolesChanged = defineEvent(
  'identity.user.roles_changed.v1',
  'user',
  z.object({
    ...userRef,
    roles: z.array(z.enum(TENANT_ROLES)),
    previous_roles: z.array(z.enum(TENANT_ROLES)),
    actor: z.string(),
    occurred_at: isoTime,
  }),
);

/** Security alert: a rotated refresh token was presented again; the whole family was revoked. */
export const RefreshReuseDetected = defineEvent(
  'identity.session.refresh_reuse_detected.v1',
  'session',
  z.object({
    ...userRef,
    family_id: uuid,
    revoked_tokens: z.number().int().min(0),
    occurred_at: isoTime,
  }),
);

/** Audit: a successful sign-in (not token refreshes). tenant_id is null for platform staff. */
export const LoginSucceeded = defineEvent(
  'identity.session.login_succeeded.v1',
  'session',
  z.object({
    tenant_id: uuid.nullable(),
    subject_id: uuid,
    subject_kind: z.enum(['user', 'staff']),
    method: z.enum(['invitation', 'magic_link', 'sso']),
    amr: z.array(z.string()),
    occurred_at: isoTime,
  }),
);
