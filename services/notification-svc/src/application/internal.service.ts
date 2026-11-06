import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  hashRequest,
  isUuid,
  type Principal,
  runIdempotent,
  setTenantContext,
  ValidationError,
} from '@atlas/platform';
import { isHttpsUrl } from '../domain/templates';
import { allowedPlaceholders, type NotificationType, specOf } from '../domain/types';
import { type NotificationStore, NOTIFICATION_STORE } from './store';
import { tenantOf } from './access';
import { Dispatcher } from './dispatcher';

export interface LinkMessageInput {
  kind: 'invitation' | 'magic_link';
  tenant_id: string;
  email: string;
  url: string;
  expires_at: string;
}

export interface MessageInput {
  type: 'candidate_assessment_invitation';
  tenant_id: string;
  email: string;
  subject_id: string | null;
  url: string | null;
  expires_at: string | null;
  values: Record<string, string>;
}

export interface Accepted {
  status: 'accepted';
  notification_ids: string[];
}

/**
 * Service-to-service sends (Component Prompt 13 §4). The bodies carry addresses and bearer links:
 * the idempotency record keeps only a hash of them, and they are never logged.
 */
@Injectable()
export class InternalService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
    private readonly dispatcher: Dispatcher,
  ) {}

  /** identity-svc's invitation and magic-link emails; identity reuses one key across retries. */
  async linkMessage(p: Principal, input: LinkMessageInput, key: string) {
    const tenantId = tenantOf(p, input.tenant_id);
    this.checkLink(input.url, input.expires_at);
    return this.send(p, key, 'POST /v1/internal/link-messages', input, tenantId, {
      type: input.kind,
      email: input.email,
      subjectId: null,
      url: input.url,
      expiresAt: input.expires_at,
      values: {},
    });
  }

  /** Messages to people who are not users, e.g. a candidate's assessment invitation. */
  async message(p: Principal, input: MessageInput, key: string) {
    const tenantId = tenantOf(p, input.tenant_id);
    const spec = specOf(input.type);
    if (spec.secretLink && (!input.url || !input.expires_at))
      throw new ValidationError('This message type needs url and expires_at.', [
        { path: 'url', message: 'Required' },
      ]);
    if (input.url && input.expires_at) this.checkLink(input.url, input.expires_at);
    const allowed = new Set(allowedPlaceholders(input.type));
    for (const k of Object.keys(input.values))
      if (!allowed.has(k) || k === 'URL' || k === 'Expires_At')
        throw new ValidationError('Unknown placeholder value.', [
          { path: `values.${k}`, message: 'not allowed for this type' },
        ]);
    return this.send(p, key, 'POST /v1/internal/messages', input, tenantId, {
      type: input.type,
      email: input.email,
      subjectId: input.subject_id,
      url: input.url,
      expiresAt: input.expires_at,
      values: input.values,
    });
  }

  private checkLink(url: string, expiresAt: string): void {
    if (!isHttpsUrl(url))
      throw new ValidationError('url must be https.', [{ path: 'url', message: 'must be https' }]);
    if (new Date(expiresAt) <= this.clock.now())
      throw new ValidationError('The link has already expired.', [
        { path: 'expires_at', message: 'in the past' },
      ]);
  }

  private async send(
    p: Principal,
    key: string,
    route: string,
    body: unknown,
    tenantId: string,
    m: {
      type: NotificationType;
      email: string;
      subjectId: string | null;
      url: string | null;
      expiresAt: string | null;
      values: Record<string, string>;
    },
  ) {
    let after: (() => Promise<void>) | undefined;
    const result = await runIdempotent<Accepted>(
      this.db,
      {
        scope: `notification-svc:${tenantId}:${p.subject}`,
        key,
        requestHash: hashRequest('POST', route, body),
      },
      async (tx) => {
        await setTenantContext(tx, tenantId);
        const out = await this.dispatcher.dispatch(tx, {
          tenantId,
          type: m.type,
          to: { email: m.email, subjectId: m.subjectId },
          values: m.values,
          link: m.url && m.expiresAt ? { url: m.url, expiresAt: new Date(m.expiresAt) } : null,
          dedupeKey: `request:${p.subject}:${key}`,
        });
        after = out.after;
        return { status: 202, body: { status: 'accepted', notification_ids: out.notificationIds } };
      },
    );
    await after?.();
    return result;
  }

  /** Directory updates from other services (HRBP tags, locale, time zone, display name). */
  async upsertRecipient(
    p: Principal,
    userId: string,
    input: {
      tenant_id: string;
      email?: string | null | undefined;
      display_name?: string | null | undefined;
      roles?: string[] | undefined;
      tags?: string[] | undefined;
      locale?: string | undefined;
      time_zone?: string | null | undefined;
      active?: boolean | undefined;
    },
  ) {
    const tenantId = tenantOf(p, input.tenant_id);
    if (!isUuid(tenantId)) throw new ValidationError('tenant_id must be a uuid.', []);
    await this.db.transaction(async (tx) => {
      await setTenantContext(tx, tenantId);
      await this.store.upsertRecipient(
        tx,
        tenantId,
        userId,
        {
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
          ...(input.roles ? { roles: input.roles } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.locale ? { locale: input.locale } : {}),
          ...(input.time_zone !== undefined ? { timeZone: input.time_zone } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        },
        this.clock.now(),
      );
    });
    return { user_id: userId, tenant_id: tenantId, status: 'saved' };
  }
}
