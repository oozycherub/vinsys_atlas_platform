/**
 * The persistence port of notification-svc (MASTER_ORCHESTRATION_PROMPT §4.1: dependencies point inward).
 * PostgreSQL implementation: ../infrastructure/pg.store.ts.
 */
import { type Channel } from '../domain/types';
import { type Tx } from '@atlas/platform';

export interface Recipient {
  userId: string;
  email: string | null;
  displayName: string | null;
  roles: string[];
  tags: string[];
  locale: string;
  timeZone: string | null;
  active: boolean;
}

export interface TenantSettings {
  quietStartMin: number | null;
  quietEndMin: number | null;
  timeZone: string;
  maxPerDay: number;
  fromName: string | null;
}

export interface TemplateRow {
  templateId: string;
  type: string;
  channel: Channel;
  locale: string;
  subject: string;
  source: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface PreferenceRow {
  type: string;
  userId: string;
  enabled: boolean;
  email: boolean;
  inApp: boolean;
}

export interface NotificationRow {
  notificationId: string;
  type: string;
  channel: Channel;
  recipientUserId: string | null;
  toEmail: string | null;
  data: Record<string, unknown>;
  linkUrl: string | null;
  linkExpiresAt: Date | null;
  transactional: boolean;
  status: string;
  attempts: number;
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NewNotification {
  tenantId: string;
  notificationId: string;
  type: string;
  channel: Channel;
  recipientUserId: string | null;
  toEmail: string | null;
  subjectId: string | null;
  data: Record<string, unknown>;
  linkUrl: string | null;
  linkExpiresAt: Date | null;
  transactional: boolean;
  status: 'queued' | 'sent';
  availableAt: Date;
  sentAt: Date | null;
  dedupeKey: string;
}

export interface EndpointRow {
  endpointId: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  secretSealed: Buffer;
  enabled: boolean;
  consecutiveFailures: number;
  disabledAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
}

export interface DeliveryRow {
  deliveryId: string;
  endpointId: string;
  eventType: string;
  eventId: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  availableAt: Date;
  lastStatus: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface DomainRow {
  domainId: string;
  domain: string;
  verificationToken: string;
  dkimSelector: string;
  spfVerified: boolean;
  dkimVerified: boolean;
  status: string;
  checkedAt: Date | null;
  createdAt: Date;
}

export interface ReminderRow {
  reminderId: string;
  type: string;
  recipientUserId: string;
  dueAt: Date;
  data: Record<string, string>;
  status: string;
  createdBy: string;
  createdAt: Date;
}

export interface Claimed {
  tenantId: string;
  id: string;
  attempts: number;
}

export const NOTIFICATION_STORE = Symbol('NOTIFICATION_STORE');

export interface NotificationStore {
  upsertRecipient(
    tx: Tx,
    tenantId: string,
    userId: string,
    patch: Partial<Omit<Recipient, 'userId'>>,
    now: Date,
  ): Promise<void>;
  recipient(tx: Tx, userId: string): Promise<Recipient | null>;
  recipientsWith(tx: Tx, roles: string[], tags: string[]): Promise<Recipient[]>;
  settings(tx: Tx): Promise<TenantSettings>;
  saveSettings(tx: Tx, tenantId: string, s: TenantSettings, now: Date): Promise<void>;
  preferences(tx: Tx, type: string | null, userId: string | null): Promise<PreferenceRow[]>;
  savePreference(tx: Tx, tenantId: string, p: PreferenceRow, now: Date): Promise<void>;
  templates(tx: Tx): Promise<TemplateRow[]>;
  template(tx: Tx, id: string): Promise<TemplateRow | null>;
  /** The tenant's template for a type and channel: the locale, else English. */
  templateFor(tx: Tx, type: string, channel: Channel, locale: string): Promise<TemplateRow | null>;
  insertTemplate(tx: Tx, tenantId: string, t: TemplateRow): Promise<boolean>;
  updateTemplate(
    tx: Tx,
    id: string,
    subject: string,
    source: string,
    by: string,
    now: Date,
  ): Promise<TemplateRow | null>;
  deleteTemplate(tx: Tx, id: string): Promise<boolean>;
  /** Inserts unless the dedupe key exists (event replays, idempotent requests). */
  insertNotification(tx: Tx, n: NewNotification): Promise<boolean>;
  notification(tx: Tx, id: string): Promise<NotificationRow | null>;
  /** Leases due email sends across tenants (system context). */
  claimEmails(tx: Tx, now: Date, leaseUntil: Date, limit: number): Promise<Claimed[]>;
  defer(tx: Tx, id: string, until: Date): Promise<void>;
  markSent(tx: Tx, id: string, messageId: string, now: Date): Promise<void>;
  retryLater(tx: Tx, id: string, until: Date, error: string): Promise<void>;
  markFailed(tx: Tx, id: string, error: string): Promise<void>;
  markSuppressed(tx: Tx, id: string, reason: string): Promise<void>;
  /** Send times of the recipient's capped (non-transactional) email in the last 24 h. */
  recentCappedSends(tx: Tx, userId: string, since: Date): Promise<Date[]>;
  inbox(
    tx: Tx,
    userId: string,
    after: {
      createdAt: Date;
      id: string;
    } | null,
    before: {
      createdAt: Date;
      id: string;
    } | null,
    limit: number,
    unreadOnly: boolean,
  ): Promise<NotificationRow[]>;
  unreadCount(tx: Tx, userId: string): Promise<number>;
  markRead(tx: Tx, userId: string, id: string, now: Date): Promise<boolean>;
  markAllRead(tx: Tx, userId: string, now: Date): Promise<number>;
  /** Erasure: messages about a candidate (internal messages carry their address). */
  eraseSubject(tx: Tx, subjectId: string): Promise<number>;
  purgeTenant(tx: Tx): Promise<void>;
  insertReminder(tx: Tx, tenantId: string, r: ReminderRow): Promise<void>;
  reminders(tx: Tx, status: string | null, limit: number): Promise<ReminderRow[]>;
  reminder(tx: Tx, id: string): Promise<ReminderRow | null>;
  setReminderStatus(tx: Tx, id: string, from: string, to: string): Promise<boolean>;
  dueReminders(tx: Tx, now: Date, limit: number): Promise<Claimed[]>;
  insertDomain(tx: Tx, tenantId: string, row: DomainRow): Promise<boolean>;
  domains(tx: Tx): Promise<DomainRow[]>;
  domain(tx: Tx, id: string): Promise<DomainRow | null>;
  verifiedDomain(tx: Tx): Promise<string | null>;
  saveDomainCheck(
    tx: Tx,
    id: string,
    spf: boolean,
    dkim: boolean,
    status: string,
    now: Date,
  ): Promise<DomainRow | null>;
  deleteDomain(tx: Tx, id: string): Promise<boolean>;
  insertEndpoint(
    tx: Tx,
    tenantId: string,
    e: Omit<EndpointRow, 'consecutiveFailures' | 'disabledAt' | 'disabledReason' | 'enabled'>,
    by: string,
  ): Promise<void>;
  endpoints(tx: Tx): Promise<EndpointRow[]>;
  endpoint(tx: Tx, id: string, lock?: boolean): Promise<EndpointRow | null>;
  subscribedEndpoints(tx: Tx, eventType: string): Promise<EndpointRow[]>;
  updateEndpoint(
    tx: Tx,
    id: string,
    patch: {
      url?: string;
      description?: string | null;
      eventTypes?: string[];
    },
  ): Promise<EndpointRow | null>;
  setEndpointEnabled(
    tx: Tx,
    id: string,
    enabled: boolean,
    now: Date,
    reason: string | null,
  ): Promise<void>;
  /** Records an attempt's outcome on the endpoint; returns the new consecutive-failure count. */
  recordEndpointOutcome(tx: Tx, id: string, ok: boolean): Promise<number>;
  deleteEndpoint(tx: Tx, id: string): Promise<boolean>;
  insertDelivery(
    tx: Tx,
    tenantId: string,
    d: Pick<DeliveryRow, 'deliveryId' | 'endpointId' | 'eventType' | 'eventId' | 'payload'>,
    now: Date,
  ): Promise<boolean>;
  deliveries(
    tx: Tx,
    endpointId: string,
    status: string | null,
    limit: number,
  ): Promise<DeliveryRow[]>;
  delivery(tx: Tx, id: string): Promise<DeliveryRow | null>;
  /** Leases due deliveries of enabled endpoints across tenants (system context). */
  claimDeliveries(tx: Tx, now: Date, leaseUntil: Date, limit: number): Promise<Claimed[]>;
  finishDelivery(
    tx: Tx,
    id: string,
    outcome:
      | {
          status: 'delivered';
          httpStatus: number;
          at: Date;
        }
      | {
          status: 'pending';
          httpStatus: number | null;
          error: string;
          until: Date;
        }
      | {
          status: 'dead';
          httpStatus: number | null;
          error: string;
        },
  ): Promise<void>;
  redeliver(tx: Tx, id: string, now: Date): Promise<boolean>;
}
