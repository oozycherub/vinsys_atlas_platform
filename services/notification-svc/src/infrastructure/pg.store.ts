import { Injectable } from '@nestjs/common';
import { type Tx } from '@atlas/platform';
import {
  type Recipient,
  type TenantSettings,
  type TemplateRow,
  type PreferenceRow,
  type NotificationRow,
  type NewNotification,
  type EndpointRow,
  type DeliveryRow,
  type DomainRow,
  type ReminderRow,
  type Claimed,
  type NotificationStore,
} from '../application/store';
import { type Channel } from '../domain/types';

/** SQL for notification-svc (ADR-0004: SQL first). Every method runs in the caller's transaction. */

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  quietStartMin: null,
  quietEndMin: null,
  timeZone: 'UTC',
  maxPerDay: 5,
  fromName: null,
};

type Row = Record<string, unknown>;
const d = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string);

const toRecipient = (r: Row): Recipient => ({
  userId: r['user_id'] as string,
  email: (r['email'] as string | null) ?? null,
  displayName: (r['display_name'] as string | null) ?? null,
  roles: (r['roles'] as string[]) ?? [],
  tags: (r['tags'] as string[]) ?? [],
  locale: r['locale'] as string,
  timeZone: (r['time_zone'] as string | null) ?? null,
  active: r['active'] as boolean,
});

const toNotification = (r: Row): NotificationRow => ({
  notificationId: r['notification_id'] as string,
  type: r['type'] as string,
  channel: r['channel'] as Channel,
  recipientUserId: (r['recipient_user_id'] as string | null) ?? null,
  toEmail: (r['to_email'] as string | null) ?? null,
  data: (r['data'] as Record<string, unknown>) ?? {},
  linkUrl: (r['link_url'] as string | null) ?? null,
  linkExpiresAt: d(r['link_expires_at']),
  transactional: r['transactional'] as boolean,
  status: r['status'] as string,
  attempts: r['attempts'] as number,
  sentAt: d(r['sent_at']),
  readAt: d(r['read_at']),
  createdAt: d(r['created_at']) as Date,
});

const toEndpoint = (r: Row): EndpointRow => ({
  endpointId: r['endpoint_id'] as string,
  url: r['url'] as string,
  description: (r['description'] as string | null) ?? null,
  eventTypes: r['event_types'] as string[],
  secretSealed: Buffer.from(r['secret_sealed'] as Uint8Array),
  enabled: r['enabled'] as boolean,
  consecutiveFailures: r['consecutive_failures'] as number,
  disabledAt: d(r['disabled_at']),
  disabledReason: (r['disabled_reason'] as string | null) ?? null,
  createdAt: d(r['created_at']) as Date,
});

const toDelivery = (r: Row): DeliveryRow => ({
  deliveryId: r['delivery_id'] as string,
  endpointId: r['endpoint_id'] as string,
  eventType: r['event_type'] as string,
  eventId: r['event_id'] as string,
  payload: r['payload'] as Record<string, unknown>,
  status: r['status'] as string,
  attempts: r['attempts'] as number,
  availableAt: d(r['available_at']) as Date,
  lastStatus: (r['last_status'] as number | null) ?? null,
  lastError: (r['last_error'] as string | null) ?? null,
  deliveredAt: d(r['delivered_at']),
  createdAt: d(r['created_at']) as Date,
});

const toDomain = (r: Row): DomainRow => ({
  domainId: r['domain_id'] as string,
  domain: r['domain'] as string,
  verificationToken: r['verification_token'] as string,
  dkimSelector: r['dkim_selector'] as string,
  spfVerified: r['spf_verified'] as boolean,
  dkimVerified: r['dkim_verified'] as boolean,
  status: r['status'] as string,
  checkedAt: d(r['checked_at']),
  createdAt: d(r['created_at']) as Date,
});

const toReminder = (r: Row): ReminderRow => ({
  reminderId: r['reminder_id'] as string,
  type: r['type'] as string,
  recipientUserId: r['recipient_user_id'] as string,
  dueAt: d(r['due_at']) as Date,
  data: (r['data'] as Record<string, string>) ?? {},
  status: r['status'] as string,
  createdBy: r['created_by'] as string,
  createdAt: d(r['created_at']) as Date,
});

const toTemplate = (r: Row): TemplateRow => ({
  templateId: r['template_id'] as string,
  type: r['type'] as string,
  channel: r['channel'] as Channel,
  locale: r['locale'] as string,
  subject: r['subject'] as string,
  source: r['source'] as string,
  version: r['version'] as number,
  updatedBy: r['updated_by'] as string,
  updatedAt: (d(r['updated_at']) as Date).toISOString(),
});

@Injectable()
export class PgNotificationStore implements NotificationStore {
  // --- Recipients ---------------------------------------------------------------------------

  async upsertRecipient(
    tx: Tx,
    tenantId: string,
    userId: string,
    patch: Partial<Omit<Recipient, 'userId'>>,
    now: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO notification_recipients
         (tenant_id, user_id, email, display_name, roles, tags, locale, time_zone, active, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, '{}'::text[]), COALESCE($6, '{}'::text[]), COALESCE($7, 'en'), $8,
               COALESCE($9, true), $10)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET
         email = COALESCE($3, notification_recipients.email),
         display_name = COALESCE($4, notification_recipients.display_name),
         roles = COALESCE($5, notification_recipients.roles),
         tags = COALESCE($6, notification_recipients.tags),
         locale = COALESCE($7, notification_recipients.locale),
         time_zone = COALESCE($8, notification_recipients.time_zone),
         active = COALESCE($9, notification_recipients.active),
         updated_at = $10`,
      [
        tenantId,
        userId,
        patch.email ?? null,
        patch.displayName ?? null,
        patch.roles ?? null,
        patch.tags ?? null,
        patch.locale ?? null,
        patch.timeZone ?? null,
        patch.active ?? null,
        now,
      ],
    );
  }

  async recipient(tx: Tx, userId: string): Promise<Recipient | null> {
    const r = await tx.query(`SELECT * FROM notification_recipients WHERE user_id = $1`, [userId]);
    return r.rows[0] ? toRecipient(r.rows[0]) : null;
  }

  async recipientsWith(tx: Tx, roles: string[], tags: string[]): Promise<Recipient[]> {
    const r = await tx.query(
      `SELECT * FROM notification_recipients
       WHERE active AND (roles && $1::text[] OR tags && $2::text[]) ORDER BY user_id`,
      [roles, tags],
    );
    return r.rows.map(toRecipient);
  }

  // --- Settings, preferences, templates -----------------------------------------------------

  async settings(tx: Tx): Promise<TenantSettings> {
    const r = await tx.query(`SELECT * FROM notification_settings`);
    const row = r.rows[0];
    if (!row) return DEFAULT_TENANT_SETTINGS;
    return {
      quietStartMin: (row['quiet_start_min'] as number | null) ?? null,
      quietEndMin: (row['quiet_end_min'] as number | null) ?? null,
      timeZone: row['time_zone'] as string,
      maxPerDay: row['max_per_day'] as number,
      fromName: (row['from_name'] as string | null) ?? null,
    };
  }

  async saveSettings(tx: Tx, tenantId: string, s: TenantSettings, now: Date): Promise<void> {
    await tx.query(
      `INSERT INTO notification_settings (tenant_id, quiet_start_min, quiet_end_min, time_zone, max_per_day, from_name, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id) DO UPDATE SET quiet_start_min = $2, quiet_end_min = $3, time_zone = $4,
         max_per_day = $5, from_name = $6, updated_at = $7`,
      [tenantId, s.quietStartMin, s.quietEndMin, s.timeZone, s.maxPerDay, s.fromName, now],
    );
  }

  async preferences(tx: Tx, type: string | null, userId: string | null): Promise<PreferenceRow[]> {
    const r = await tx.query(
      `SELECT * FROM notification_preferences
       WHERE ($1::text IS NULL OR type = $1) AND (user_id = '*' OR user_id = $2) ORDER BY type, user_id`,
      [type, userId ?? '*'],
    );
    return r.rows.map((row) => ({
      type: row['type'] as string,
      userId: row['user_id'] as string,
      enabled: row['enabled'] as boolean,
      email: row['email'] as boolean,
      inApp: row['in_app'] as boolean,
    }));
  }

  async savePreference(tx: Tx, tenantId: string, p: PreferenceRow, now: Date): Promise<void> {
    await tx.query(
      `INSERT INTO notification_preferences (tenant_id, type, user_id, enabled, email, in_app, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, type, user_id) DO UPDATE SET enabled = $4, email = $5, in_app = $6, updated_at = $7`,
      [tenantId, p.type, p.userId, p.enabled, p.email, p.inApp, now],
    );
  }

  async templates(tx: Tx): Promise<TemplateRow[]> {
    const r = await tx.query(`SELECT * FROM notification_templates ORDER BY type, channel, locale`);
    return r.rows.map(toTemplate);
  }

  async template(tx: Tx, id: string): Promise<TemplateRow | null> {
    const r = await tx.query(`SELECT * FROM notification_templates WHERE template_id = $1`, [id]);
    return r.rows[0] ? toTemplate(r.rows[0]) : null;
  }

  /** The tenant's template for a type and channel: the locale, else English. */
  async templateFor(
    tx: Tx,
    type: string,
    channel: Channel,
    locale: string,
  ): Promise<TemplateRow | null> {
    const r = await tx.query(
      `SELECT * FROM notification_templates WHERE type = $1 AND channel = $2 AND locale IN ($3, 'en')
       ORDER BY (locale = $3) DESC LIMIT 1`,
      [type, channel, locale],
    );
    return r.rows[0] ? toTemplate(r.rows[0]) : null;
  }

  async insertTemplate(tx: Tx, tenantId: string, t: TemplateRow): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO notification_templates (tenant_id, template_id, type, channel, locale, subject, source, version, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)
       ON CONFLICT (tenant_id, type, channel, locale) DO NOTHING RETURNING template_id`,
      [
        tenantId,
        t.templateId,
        t.type,
        t.channel,
        t.locale,
        t.subject,
        t.source,
        t.updatedBy,
        t.updatedAt,
      ],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async updateTemplate(
    tx: Tx,
    id: string,
    subject: string,
    source: string,
    by: string,
    now: Date,
  ): Promise<TemplateRow | null> {
    const r = await tx.query(
      `UPDATE notification_templates SET subject = $2, source = $3, version = version + 1, updated_by = $4, updated_at = $5
       WHERE template_id = $1 RETURNING *`,
      [id, subject, source, by, now],
    );
    return r.rows[0] ? toTemplate(r.rows[0]) : null;
  }

  async deleteTemplate(tx: Tx, id: string): Promise<boolean> {
    const r = await tx.query(`DELETE FROM notification_templates WHERE template_id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  // --- Notifications ------------------------------------------------------------------------

  /** Inserts unless the dedupe key exists (event replays, idempotent requests). */
  async insertNotification(tx: Tx, n: NewNotification): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO notifications (tenant_id, notification_id, type, channel, recipient_user_id, to_email, subject_id,
         data, link_url, link_expires_at, transactional, status, available_at, sent_at, dedupe_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $13)
       ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING notification_id`,
      [
        n.tenantId,
        n.notificationId,
        n.type,
        n.channel,
        n.recipientUserId,
        n.toEmail,
        n.subjectId,
        JSON.stringify(n.data),
        n.linkUrl,
        n.linkExpiresAt,
        n.transactional,
        n.status,
        n.availableAt,
        n.sentAt,
        n.dedupeKey,
      ],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async notification(tx: Tx, id: string): Promise<NotificationRow | null> {
    const r = await tx.query(`SELECT * FROM notifications WHERE notification_id = $1`, [id]);
    return r.rows[0] ? toNotification(r.rows[0]) : null;
  }

  /** Leases due email sends across tenants (system context). */
  async claimEmails(tx: Tx, now: Date, leaseUntil: Date, limit: number): Promise<Claimed[]> {
    const r = await tx.query(
      `UPDATE notifications n SET available_at = $2, attempts = n.attempts + 1
       FROM (SELECT tenant_id, notification_id FROM notifications
             WHERE status = 'queued' AND channel = 'email' AND available_at <= $1
             ORDER BY available_at LIMIT $3 FOR UPDATE SKIP LOCKED) due
       WHERE n.tenant_id = due.tenant_id AND n.notification_id = due.notification_id
       RETURNING n.tenant_id, n.notification_id, n.attempts`,
      [now, leaseUntil, limit],
    );
    return r.rows.map((row) => ({
      tenantId: row['tenant_id'] as string,
      id: row['notification_id'] as string,
      attempts: row['attempts'] as number,
    }));
  }

  async defer(tx: Tx, id: string, until: Date): Promise<void> {
    // A deferral (quiet hours, cap) is not a failed attempt.
    await tx.query(
      `UPDATE notifications SET available_at = $2, attempts = greatest(attempts - 1, 0) WHERE notification_id = $1`,
      [id, until],
    );
  }

  async markSent(tx: Tx, id: string, messageId: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE notifications SET status = 'sent', sent_at = $3, provider_message_id = $2, link_url = NULL,
         last_error = NULL WHERE notification_id = $1`,
      [id, messageId, now],
    );
  }

  async retryLater(tx: Tx, id: string, until: Date, error: string): Promise<void> {
    await tx.query(
      `UPDATE notifications SET available_at = $2, last_error = $3 WHERE notification_id = $1`,
      [id, until, error.slice(0, 500)],
    );
  }

  async markFailed(tx: Tx, id: string, error: string): Promise<void> {
    await tx.query(
      `UPDATE notifications SET status = 'failed', link_url = NULL, last_error = $2 WHERE notification_id = $1`,
      [id, error.slice(0, 500)],
    );
  }

  async markSuppressed(tx: Tx, id: string, reason: string): Promise<void> {
    await tx.query(
      `UPDATE notifications SET status = 'suppressed', link_url = NULL, last_error = $2 WHERE notification_id = $1`,
      [id, reason],
    );
  }

  /** Send times of the recipient's capped (non-transactional) email in the last 24 h. */
  async recentCappedSends(tx: Tx, userId: string, since: Date): Promise<Date[]> {
    const r = await tx.query(
      `SELECT sent_at FROM notifications WHERE channel = 'email' AND NOT transactional AND status = 'sent'
         AND recipient_user_id = $1 AND sent_at > $2`,
      [userId, since],
    );
    return r.rows.map((row) => new Date(row['sent_at'] as string));
  }

  async inbox(
    tx: Tx,
    userId: string,
    after: { createdAt: Date; id: string } | null,
    before: { createdAt: Date; id: string } | null,
    limit: number,
    unreadOnly: boolean,
  ): Promise<NotificationRow[]> {
    const r = await tx.query(
      `SELECT * FROM notifications WHERE channel = 'in_app' AND recipient_user_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, notification_id) > ($2, $3::uuid))
         AND ($4::timestamptz IS NULL OR (created_at, notification_id) < ($4, $5::uuid))
         AND (NOT $7 OR read_at IS NULL)
       ORDER BY created_at ${after ? 'ASC' : 'DESC'}, notification_id ${after ? 'ASC' : 'DESC'} LIMIT $6`,
      [
        userId,
        after?.createdAt ?? null,
        after?.id ?? null,
        before?.createdAt ?? null,
        before?.id ?? null,
        limit,
        unreadOnly,
      ],
    );
    return r.rows.map(toNotification);
  }

  async unreadCount(tx: Tx, userId: string): Promise<number> {
    const r = await tx.query(
      `SELECT count(*)::int AS n FROM notifications WHERE channel = 'in_app' AND recipient_user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return (r.rows[0]?.['n'] as number) ?? 0;
  }

  async markRead(tx: Tx, userId: string, id: string, now: Date): Promise<boolean> {
    const r = await tx.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, $3)
       WHERE channel = 'in_app' AND recipient_user_id = $1 AND notification_id = $2`,
      [userId, id, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markAllRead(tx: Tx, userId: string, now: Date): Promise<number> {
    const r = await tx.query(
      `UPDATE notifications SET read_at = $2
       WHERE channel = 'in_app' AND recipient_user_id = $1 AND read_at IS NULL`,
      [userId, now],
    );
    return r.rowCount ?? 0;
  }

  /** Erasure: messages about a candidate (internal messages carry their address). */
  async eraseSubject(tx: Tx, subjectId: string): Promise<number> {
    const r = await tx.query(`DELETE FROM notifications WHERE subject_id = $1`, [subjectId]);
    return r.rowCount ?? 0;
  }

  async purgeTenant(tx: Tx): Promise<void> {
    for (const t of [
      'webhook_deliveries',
      'webhook_endpoints',
      'notifications',
      'notification_reminders',
      'notification_templates',
      'notification_preferences',
      'notification_settings',
      'notification_recipients',
      'sending_domains',
    ])
      await tx.query(`DELETE FROM ${t}`);
  }

  // --- Reminders ----------------------------------------------------------------------------

  async insertReminder(tx: Tx, tenantId: string, r: ReminderRow): Promise<void> {
    await tx.query(
      `INSERT INTO notification_reminders (tenant_id, reminder_id, type, recipient_user_id, due_at, data, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'scheduled', $7, $8)`,
      [
        tenantId,
        r.reminderId,
        r.type,
        r.recipientUserId,
        r.dueAt,
        JSON.stringify(r.data),
        r.createdBy,
        r.createdAt,
      ],
    );
  }

  async reminders(tx: Tx, status: string | null, limit: number): Promise<ReminderRow[]> {
    const r = await tx.query(
      `SELECT * FROM notification_reminders WHERE ($1::text IS NULL OR status = $1)
       ORDER BY due_at, reminder_id LIMIT $2`,
      [status, limit],
    );
    return r.rows.map(toReminder);
  }

  async reminder(tx: Tx, id: string): Promise<ReminderRow | null> {
    const r = await tx.query(`SELECT * FROM notification_reminders WHERE reminder_id = $1`, [id]);
    return r.rows[0] ? toReminder(r.rows[0]) : null;
  }

  async setReminderStatus(tx: Tx, id: string, from: string, to: string): Promise<boolean> {
    const r = await tx.query(
      `UPDATE notification_reminders SET status = $3 WHERE reminder_id = $1 AND status = $2`,
      [id, from, to],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async dueReminders(tx: Tx, now: Date, limit: number): Promise<Claimed[]> {
    const r = await tx.query(
      `SELECT tenant_id, reminder_id FROM notification_reminders
       WHERE status = 'scheduled' AND due_at <= $1 ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return r.rows.map((row) => ({
      tenantId: row['tenant_id'] as string,
      id: row['reminder_id'] as string,
      attempts: 0,
    }));
  }

  // --- Sending domains ----------------------------------------------------------------------

  async insertDomain(tx: Tx, tenantId: string, row: DomainRow): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO sending_domains (tenant_id, domain_id, domain, verification_token, dkim_selector, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, domain) DO NOTHING RETURNING domain_id`,
      [tenantId, row.domainId, row.domain, row.verificationToken, row.dkimSelector, row.createdAt],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async domains(tx: Tx): Promise<DomainRow[]> {
    const r = await tx.query(`SELECT * FROM sending_domains ORDER BY domain`);
    return r.rows.map(toDomain);
  }

  async domain(tx: Tx, id: string): Promise<DomainRow | null> {
    const r = await tx.query(`SELECT * FROM sending_domains WHERE domain_id = $1`, [id]);
    return r.rows[0] ? toDomain(r.rows[0]) : null;
  }

  async verifiedDomain(tx: Tx): Promise<string | null> {
    const r = await tx.query(
      `SELECT domain FROM sending_domains WHERE status = 'verified' ORDER BY created_at, domain LIMIT 1`,
    );
    return (r.rows[0]?.['domain'] as string | undefined) ?? null;
  }

  async saveDomainCheck(
    tx: Tx,
    id: string,
    spf: boolean,
    dkim: boolean,
    status: string,
    now: Date,
  ): Promise<DomainRow | null> {
    const r = await tx.query(
      `UPDATE sending_domains SET spf_verified = $2, dkim_verified = $3, status = $4, checked_at = $5
       WHERE domain_id = $1 RETURNING *`,
      [id, spf, dkim, status, now],
    );
    return r.rows[0] ? toDomain(r.rows[0]) : null;
  }

  async deleteDomain(tx: Tx, id: string): Promise<boolean> {
    const r = await tx.query(`DELETE FROM sending_domains WHERE domain_id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  // --- Webhooks -----------------------------------------------------------------------------

  async insertEndpoint(
    tx: Tx,
    tenantId: string,
    e: Omit<EndpointRow, 'consecutiveFailures' | 'disabledAt' | 'disabledReason' | 'enabled'>,
    by: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO webhook_endpoints (tenant_id, endpoint_id, url, description, event_types, secret_sealed, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, e.endpointId, e.url, e.description, e.eventTypes, e.secretSealed, by, e.createdAt],
    );
  }

  async endpoints(tx: Tx): Promise<EndpointRow[]> {
    const r = await tx.query(`SELECT * FROM webhook_endpoints ORDER BY created_at, endpoint_id`);
    return r.rows.map(toEndpoint);
  }

  async endpoint(tx: Tx, id: string, lock = false): Promise<EndpointRow | null> {
    const r = await tx.query(
      `SELECT * FROM webhook_endpoints WHERE endpoint_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return r.rows[0] ? toEndpoint(r.rows[0]) : null;
  }

  async subscribedEndpoints(tx: Tx, eventType: string): Promise<EndpointRow[]> {
    const r = await tx.query(
      `SELECT * FROM webhook_endpoints WHERE enabled AND $1 = ANY(event_types) ORDER BY endpoint_id`,
      [eventType],
    );
    return r.rows.map(toEndpoint);
  }

  async updateEndpoint(
    tx: Tx,
    id: string,
    patch: { url?: string; description?: string | null; eventTypes?: string[] },
  ): Promise<EndpointRow | null> {
    const r = await tx.query(
      `UPDATE webhook_endpoints SET url = COALESCE($2, url),
         description = CASE WHEN $5 THEN $3 ELSE description END,
         event_types = COALESCE($4, event_types)
       WHERE endpoint_id = $1 RETURNING *`,
      [
        id,
        patch.url ?? null,
        patch.description ?? null,
        patch.eventTypes ?? null,
        'description' in patch,
      ],
    );
    return r.rows[0] ? toEndpoint(r.rows[0]) : null;
  }

  async setEndpointEnabled(
    tx: Tx,
    id: string,
    enabled: boolean,
    now: Date,
    reason: string | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE webhook_endpoints SET enabled = $2,
         disabled_at = CASE WHEN $2 THEN NULL ELSE $3::timestamptz END,
         disabled_reason = CASE WHEN $2 THEN NULL ELSE $4 END,
         consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures END
       WHERE endpoint_id = $1`,
      [id, enabled, now, reason],
    );
  }

  /** Records an attempt's outcome on the endpoint; returns the new consecutive-failure count. */
  async recordEndpointOutcome(tx: Tx, id: string, ok: boolean): Promise<number> {
    const r = await tx.query(
      `UPDATE webhook_endpoints SET consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures + 1 END
       WHERE endpoint_id = $1 RETURNING consecutive_failures`,
      [id, ok],
    );
    return (r.rows[0]?.['consecutive_failures'] as number | undefined) ?? 0;
  }

  async deleteEndpoint(tx: Tx, id: string): Promise<boolean> {
    const r = await tx.query(`DELETE FROM webhook_endpoints WHERE endpoint_id = $1`, [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async insertDelivery(
    tx: Tx,
    tenantId: string,
    d: Pick<DeliveryRow, 'deliveryId' | 'endpointId' | 'eventType' | 'eventId' | 'payload'>,
    now: Date,
  ): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO webhook_deliveries (tenant_id, delivery_id, endpoint_id, event_type, event_id, payload, available_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
       ON CONFLICT (tenant_id, endpoint_id, event_id) DO NOTHING RETURNING delivery_id`,
      [
        tenantId,
        d.deliveryId,
        d.endpointId,
        d.eventType,
        d.eventId,
        JSON.stringify(d.payload),
        now,
      ],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async deliveries(
    tx: Tx,
    endpointId: string,
    status: string | null,
    limit: number,
  ): Promise<DeliveryRow[]> {
    const r = await tx.query(
      `SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, delivery_id LIMIT $3`,
      [endpointId, status, limit],
    );
    return r.rows.map(toDelivery);
  }

  async delivery(tx: Tx, id: string): Promise<DeliveryRow | null> {
    const r = await tx.query(`SELECT * FROM webhook_deliveries WHERE delivery_id = $1`, [id]);
    return r.rows[0] ? toDelivery(r.rows[0]) : null;
  }

  /** Leases due deliveries of enabled endpoints across tenants (system context). */
  async claimDeliveries(tx: Tx, now: Date, leaseUntil: Date, limit: number): Promise<Claimed[]> {
    const r = await tx.query(
      `UPDATE webhook_deliveries w SET available_at = $2, attempts = w.attempts + 1
       FROM (SELECT d.tenant_id, d.delivery_id FROM webhook_deliveries d
             WHERE d.status = 'pending' AND d.available_at <= $1
               AND EXISTS (SELECT 1 FROM webhook_endpoints e
                           WHERE e.tenant_id = d.tenant_id AND e.endpoint_id = d.endpoint_id AND e.enabled)
             ORDER BY d.available_at LIMIT $3 FOR UPDATE OF d SKIP LOCKED) due
       WHERE w.tenant_id = due.tenant_id AND w.delivery_id = due.delivery_id
       RETURNING w.tenant_id, w.delivery_id, w.attempts`,
      [now, leaseUntil, limit],
    );
    return r.rows.map((row) => ({
      tenantId: row['tenant_id'] as string,
      id: row['delivery_id'] as string,
      attempts: row['attempts'] as number,
    }));
  }

  async finishDelivery(
    tx: Tx,
    id: string,
    outcome:
      | { status: 'delivered'; httpStatus: number; at: Date }
      | { status: 'pending'; httpStatus: number | null; error: string; until: Date }
      | { status: 'dead'; httpStatus: number | null; error: string },
  ): Promise<void> {
    await tx.query(
      `UPDATE webhook_deliveries SET status = $2, last_status = $3, last_error = $4,
         delivered_at = $5, available_at = COALESCE($6, available_at)
       WHERE delivery_id = $1`,
      [
        id,
        outcome.status,
        outcome.httpStatus,
        outcome.status === 'delivered' ? null : outcome.error.slice(0, 500),
        outcome.status === 'delivered' ? outcome.at : null,
        outcome.status === 'pending' ? outcome.until : null,
      ],
    );
  }

  async redeliver(tx: Tx, id: string, now: Date): Promise<boolean> {
    const r = await tx.query(
      `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, available_at = $2, last_error = NULL
       WHERE delivery_id = $1 AND status = 'dead'`,
      [id, now],
    );
    return (r.rowCount ?? 0) > 0;
  }
}
