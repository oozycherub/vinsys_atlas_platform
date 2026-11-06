import { Inject, Injectable, Optional } from '@nestjs/common';
import { type Logger } from 'pino';
import { NotificationDeliveryFailed } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  type Tx,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { defaultTemplate } from '../domain/default-templates';
import {
  emailRetryDelayMs,
  MAX_EMAIL_ATTEMPTS,
  nextSendTime,
  nextUnderCap,
} from '../domain/scheduling';
import { renderEmail, UnsafeOutputError } from '../domain/templates';
import { isNotificationType, type NotificationType } from '../domain/types';
import {
  type Claimed,
  type NotificationRow,
  type NotificationStore,
  NOTIFICATION_STORE,
} from './store';
import { Dispatcher } from './dispatcher';
import {
  EMAIL_SENDER,
  EmailSendError,
  type EmailSender,
  NOTIFICATION_LOGGER,
  NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type OutgoingEmail,
} from './ports';

type Prepared = { kind: 'send'; message: OutgoingEmail; n: NotificationRow } | { kind: 'skip' };

/**
 * Sends queued email (Component Prompt 13 §2, ADR-0010 §3). Each pass leases a batch across
 * tenants, prepares each message in its tenant's context, sends outside any transaction and
 * records the outcome. A link URL is used here and nowhere else; it is never logged.
 */
@Injectable()
export class EmailWorker {
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(NOTIFICATION_SETTINGS) private readonly settings: NotificationSettings,
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
    private readonly dispatcher: Dispatcher,
    @Optional() @Inject(NOTIFICATION_LOGGER) private readonly logger: Logger | null,
  ) {}

  /** One pass: due reminders become notifications, then due email is sent. */
  async runOnce(): Promise<number> {
    const reminders = await this.runReminders();
    const now = this.clock.now();
    const claimed = await withSystemTx(this.db, (tx) =>
      this.store.claimEmails(
        tx,
        now,
        new Date(now.getTime() + this.settings.leaseMs),
        this.settings.batchSize,
      ),
    );
    for (const c of claimed) await this.process(c);
    return reminders + claimed.length;
  }

  async runForever(idleMs = 2000): Promise<void> {
    while (!this.stopped) {
      try {
        if ((await this.runOnce()) === 0) await new Promise((r) => setTimeout(r, idleMs));
      } catch (error) {
        this.logger?.error({ err: error }, 'email worker pass failed');
        await new Promise((r) => setTimeout(r, idleMs));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async runReminders(): Promise<number> {
    const now = this.clock.now();
    const due = await withSystemTx(this.db, (tx) =>
      this.store.dueReminders(tx, now, this.settings.batchSize),
    );
    for (const r of due) {
      const after = await withTenantTx(this.db, r.tenantId, async (tx) => {
        const reminder = await this.store.reminder(tx, r.id);
        if (!reminder || !isNotificationType(reminder.type)) return undefined;
        // The conditional update makes concurrent workers dispatch a reminder once.
        if (!(await this.store.setReminderStatus(tx, r.id, 'scheduled', 'sent'))) return undefined;
        const out = await this.dispatcher.dispatch(tx, {
          tenantId: r.tenantId,
          type: reminder.type,
          to: { userId: reminder.recipientUserId },
          values: { Due_Date: reminder.dueAt.toISOString().slice(0, 10), ...reminder.data },
          dedupeKey: `reminder:${reminder.reminderId}`,
        });
        return out.after;
      });
      await after?.();
    }
    return due.length;
  }

  private async process(c: Claimed): Promise<void> {
    const now = this.clock.now();
    const prepared = await withTenantTx(this.db, c.tenantId, (tx) => this.prepare(tx, c, now));
    if (prepared.kind === 'skip') return;
    const { n, message } = prepared;
    try {
      const { messageId } = await this.sender.send(message);
      await withTenantTx(this.db, c.tenantId, (tx) =>
        this.store.markSent(tx, n.notificationId, messageId, this.clock.now()),
      );
      this.logger?.info(
        { notification_id: n.notificationId, type: n.type, tenant_id: c.tenantId },
        'email sent',
      );
    } catch (error) {
      const permanent = error instanceof EmailSendError && error.permanent;
      const reason = error instanceof EmailSendError ? error.message : (error as Error).name;
      if (permanent || c.attempts >= MAX_EMAIL_ATTEMPTS) {
        await withTenantTx(this.db, c.tenantId, (tx) =>
          this.fail(tx, c.tenantId, n, reason, permanent ? 'permanent' : 'retries_exhausted', c),
        );
      } else {
        await withTenantTx(this.db, c.tenantId, (tx) =>
          this.store.retryLater(
            tx,
            n.notificationId,
            new Date(now.getTime() + emailRetryDelayMs(c.attempts)),
            reason,
          ),
        );
      }
      this.logger?.warn(
        { notification_id: n.notificationId, type: n.type, attempts: c.attempts, reason },
        'email send failed',
      );
    }
  }

  private async prepare(tx: Tx, c: Claimed, now: Date): Promise<Prepared> {
    const n = await this.store.notification(tx, c.id);
    if (!n || n.status !== 'queued' || !isNotificationType(n.type)) return { kind: 'skip' };
    const type: NotificationType = n.type;
    if (n.linkExpiresAt && n.linkExpiresAt <= now) {
      await this.fail(
        tx,
        c.tenantId,
        n,
        'link expired before it could be sent',
        'retries_exhausted',
        c,
      );
      return { kind: 'skip' };
    }
    const recipient = n.recipientUserId ? await this.store.recipient(tx, n.recipientUserId) : null;
    const to = n.toEmail ?? recipient?.email ?? null;
    if (!to || (recipient && !recipient.active)) {
      await this.store.markSuppressed(
        tx,
        n.notificationId,
        to ? 'recipient inactive' : 'no address',
      );
      return { kind: 'skip' };
    }
    const tenant = await this.store.settings(tx);
    if (!n.transactional) {
      // Switched off since it was queued: not sent.
      if (!(await this.dispatcher.channelsFor(tx, type, n.recipientUserId)).includes('email')) {
        await this.store.markSuppressed(tx, n.notificationId, 'disabled');
        return { kind: 'skip' };
      }
      const quiet =
        tenant.quietStartMin !== null && tenant.quietEndMin !== null
          ? {
              startMin: tenant.quietStartMin,
              endMin: tenant.quietEndMin,
              timeZone: recipient?.timeZone ?? tenant.timeZone,
            }
          : null;
      let at = nextSendTime(now, quiet);
      if (n.recipientUserId) {
        const sent = await this.store.recentCappedSends(
          tx,
          n.recipientUserId,
          new Date(now.getTime() - 86_400_000),
        );
        const capped = nextUnderCap(now, sent, tenant.maxPerDay);
        if (capped > at) at = nextSendTime(capped, quiet);
      }
      if (at > now) {
        await this.store.defer(tx, n.notificationId, at);
        return { kind: 'skip' };
      }
    }
    const template =
      (await this.store.templateFor(tx, type, 'email', recipient?.locale ?? 'en')) ??
      defaultTemplate(type, 'email');
    if (!template) {
      await this.fail(tx, c.tenantId, n, 'no template', 'permanent', c);
      return { kind: 'skip' };
    }
    const stored = (n.data['values'] as Record<string, string> | undefined) ?? {};
    const values: Record<string, string> = {
      Recipient_Name: recipient?.displayName ?? '',
      ...stored,
      ...(n.linkUrl ? { URL: n.linkUrl } : {}),
      ...(n.linkExpiresAt ? { Expires_At: n.linkExpiresAt.toISOString() } : {}),
    };
    let rendered;
    try {
      rendered = await renderEmail(template.subject, template.source, values);
    } catch (error) {
      const reason = error instanceof UnsafeOutputError ? error.message : 'template render failed';
      await this.fail(tx, c.tenantId, n, reason, 'permanent', c);
      return { kind: 'skip' };
    }
    const domain = await this.store.verifiedDomain(tx);
    const from = domain
      ? `${(tenant.fromName ?? 'Atlas').replace(/[<>"\r\n]/g, '')} <no-reply@${domain}>`
      : this.settings.defaultFrom;
    return {
      kind: 'send',
      n,
      message: {
        from,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: {
          'X-Atlas-Notification-Id': n.notificationId,
          ...(n.transactional ? {} : { 'Auto-Submitted': 'auto-generated' }),
        },
      },
    };
  }

  private async fail(
    tx: Tx,
    tenantId: string,
    n: NotificationRow,
    error: string,
    reason: 'permanent' | 'retries_exhausted',
    c: Claimed,
  ): Promise<void> {
    await this.store.markFailed(tx, n.notificationId, error);
    await appendOutbox(
      tx,
      NotificationDeliveryFailed.build({
        tenantId,
        aggregateId: n.notificationId,
        payload: {
          tenant_id: tenantId,
          notification_id: n.notificationId,
          channel: 'email',
          type: n.type,
          recipient_user_id: n.recipientUserId,
          endpoint_id: null,
          reason,
          attempts: Math.max(1, c.attempts),
          occurred_at: this.clock.now().toISOString(),
        },
      }),
    );
  }
}
