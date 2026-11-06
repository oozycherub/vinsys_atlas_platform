import { Inject, Injectable } from '@nestjs/common';
import { type AfterCommit, CLOCK, type Clock, newId, type Tx } from '@atlas/platform';
import { defaultTemplate } from '../domain/default-templates';
import { renderText } from '../domain/templates';
import { type Channel, type NotificationType, specOf } from '../domain/types';
import {
  type NotificationStore,
  NOTIFICATION_STORE,
  type PreferenceRow,
  type Recipient,
} from './store';
import { INBOX_HUB, type InboxHub } from './ports';

export interface Addressee {
  /** A user in the directory (email looked up there; in-app needs it). */
  userId?: string | null;
  /** An explicit address, for people who are not users (internal messages). */
  email?: string | null;
  /** Candidate the message is about, for erasure. */
  subjectId?: string | null;
}

export interface Dispatch {
  tenantId: string;
  type: NotificationType;
  to: Addressee;
  values: Record<string, string>;
  /** A bearer link (`{URL}`); stored until the email is sent or `linkExpiresAt` passes. */
  link?: { url: string; expiresAt: Date } | null;
  /** Unique per tenant: an event id plus recipient, an Idempotency-Key, a reminder id. */
  dedupeKey: string;
}

export interface Dispatched {
  notificationIds: string[];
  suppressed: Channel[];
}

/**
 * Turns "notify X about Y" into rows of the send outbox, after the tenant's toggles and the user's
 * own opt-outs (Component Prompt 13 §2). In-app items are complete on insert; email waits for the
 * worker, which applies quiet hours and the daily cap.
 */
@Injectable()
export class Dispatcher {
  constructor(
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INBOX_HUB) private readonly hub: InboxHub,
  ) {}

  async channelsFor(tx: Tx, type: NotificationType, userId: string | null): Promise<Channel[]> {
    const spec = specOf(type);
    if (spec.transactional) return [...spec.channels];
    const prefs = await this.store.preferences(tx, type, userId);
    const tenant = prefs.find((p) => p.userId === '*');
    const own = userId ? prefs.find((p) => p.userId === userId) : undefined;
    const allow = (p: PreferenceRow | undefined, c: Channel) =>
      !p || (p.enabled && (c === 'email' ? p.email : p.inApp));
    return spec.channels.filter((c) => allow(tenant, c) && allow(own, c));
  }

  async dispatch(tx: Tx, d: Dispatch): Promise<Dispatched & { after: AfterCommit | undefined }> {
    const now = this.clock.now();
    const spec = specOf(d.type);
    const recipient: Recipient | null = d.to.userId
      ? await this.store.recipient(tx, d.to.userId)
      : null;
    if (d.to.userId && recipient && !recipient.active)
      return { notificationIds: [], suppressed: [...spec.channels], after: undefined };
    const channels = await this.channelsFor(tx, d.type, d.to.userId ?? null);
    const suppressed = spec.channels.filter((c) => !channels.includes(c));
    const values = { Recipient_Name: recipient?.displayName ?? '', ...d.values };
    const ids: string[] = [];
    let wake = false;

    for (const channel of channels) {
      const id = newId();
      if (channel === 'in_app') {
        if (!d.to.userId) continue;
        const t =
          (await this.store.templateFor(tx, d.type, 'in_app', recipient?.locale ?? 'en')) ??
          defaultTemplate(d.type, 'in_app');
        if (!t) continue;
        const inserted = await this.store.insertNotification(tx, {
          tenantId: d.tenantId,
          notificationId: id,
          type: d.type,
          channel,
          recipientUserId: d.to.userId,
          toEmail: null,
          subjectId: d.to.subjectId ?? null,
          data: {
            title: renderText(t.subject, values),
            body: renderText(t.source, values),
            path: d.values['Link_Path'] ?? null,
          },
          linkUrl: null,
          linkExpiresAt: null,
          transactional: spec.transactional,
          status: 'sent',
          availableAt: now,
          sentAt: now,
          dedupeKey: `${d.dedupeKey}:in_app`,
        });
        if (inserted) {
          ids.push(id);
          wake = true;
        }
      } else {
        const email = d.to.email ?? recipient?.email ?? null;
        if (!email) {
          suppressed.push('email');
          continue;
        }
        const inserted = await this.store.insertNotification(tx, {
          tenantId: d.tenantId,
          notificationId: id,
          type: d.type,
          channel,
          recipientUserId: d.to.userId ?? null,
          toEmail: d.to.userId ? null : email, // users' addresses are read from the directory at send
          subjectId: d.to.subjectId ?? null,
          data: { values: d.values },
          linkUrl: d.link?.url ?? null,
          linkExpiresAt: d.link?.expiresAt ?? null,
          transactional: spec.transactional,
          status: 'queued',
          availableAt: now,
          sentAt: null,
          dedupeKey: `${d.dedupeKey}:email`,
        });
        if (inserted) ids.push(id);
      }
    }
    const userId = d.to.userId;
    return {
      notificationIds: ids,
      suppressed,
      after:
        wake && userId
          ? () => {
              this.hub.publish(d.tenantId, userId);
              return Promise.resolve();
            }
          : undefined,
    };
  }
}

/** Runs several AfterCommit callbacks in order. */
export function chainAfter(callbacks: (AfterCommit | undefined)[]): AfterCommit | undefined {
  const list = callbacks.filter((c): c is AfterCommit => c !== undefined);
  if (list.length === 0) return undefined;
  return async () => {
    for (const c of list) await c();
  };
}
