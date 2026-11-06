import { Inject, Injectable, Optional } from '@nestjs/common';
import { type Logger } from 'pino';
import { type z } from 'zod';
import {
  AssessmentSessionEvaluated,
  AttritionAlertRaised,
  ErasureAcknowledged,
  ErasureRequested,
  type EventDefinition,
  InterviewCompleted,
  ProctoringSessionFinalized,
  ReportArtifactReady,
  SessionSubmitted,
  SessionTerminated,
  TenantPurged,
  UserDeactivated,
  UserInvited,
  UserRolesChanged,
} from '@atlas/contracts';
import {
  type AfterCommit,
  appendOutbox,
  CLOCK,
  type Clock,
  type ConsumedEvent,
  type EventHandler,
  setTenantContext,
  type Tx,
} from '@atlas/platform';
import { type NotificationType } from '../domain/types';
import { webhookTypeOf } from '../domain/webhooks';
import { type NotificationStore, NOTIFICATION_STORE } from './store';
import { chainAfter, Dispatcher } from './dispatcher';
import { NOTIFICATION_LOGGER } from './ports';
import { WebhooksService } from './webhooks.service';

export const NOTIFICATION_CONSUMER = 'notification-svc';
type Payload<T extends EventDefinition<z.ZodTypeAny>> = z.output<T['schema']>;

const REVIEWERS = ['reviewer', 'recruiter'];
const RECRUITERS = ['recruiter', 'tenant_admin'];

/** Consumed topics (Component Prompt 13 §5): the directory, in-app/email fan-out and webhooks. */
@Injectable()
export class NotificationEventHandlers {
  constructor(
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
    private readonly dispatcher: Dispatcher,
    private readonly webhooks: WebhooksService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(NOTIFICATION_LOGGER) private readonly logger: Logger | null,
  ) {}

  handlers(): Record<string, EventHandler> {
    return {
      [UserInvited.topic]: (tx, e) => this.invited(tx, e),
      [UserRolesChanged.topic]: (tx, e) => this.rolesChanged(tx, e),
      [UserDeactivated.topic]: (tx, e) => this.deactivated(tx, e),
      [SessionSubmitted.topic]: (tx, e) => this.submitted(tx, e),
      [SessionTerminated.topic]: (tx, e) => this.terminated(tx, e),
      [AssessmentSessionEvaluated.topic]: (tx, e) => this.webhookOnly(tx, e),
      [ProctoringSessionFinalized.topic]: (tx, e) => this.proctoring(tx, e),
      [InterviewCompleted.topic]: (tx, e) => this.interview(tx, e),
      [AttritionAlertRaised.topic]: (tx, e) => this.attrition(tx, e),
      [ReportArtifactReady.topic]: (tx, e) => this.reportReady(tx, e),
      [ErasureRequested.topic]: (tx, e) => this.erasure(tx, e),
      [TenantPurged.topic]: (tx, e) => this.purged(tx, e),
    };
  }

  private async begin(tx: Tx, tenantId: string): Promise<void> {
    await setTenantContext(tx, tenantId);
  }

  private async toRoles(
    tx: Tx,
    e: ConsumedEvent,
    tenantId: string,
    type: NotificationType,
    roles: string[],
    values: Record<string, string>,
    key: string,
  ): Promise<AfterCommit | undefined> {
    const callbacks: (AfterCommit | undefined)[] = [];
    for (const r of await this.store.recipientsWith(tx, roles, [])) {
      const out = await this.dispatcher.dispatch(tx, {
        tenantId,
        type,
        to: { userId: r.userId },
        values,
        dedupeKey: `${key}:${r.userId}`,
      });
      callbacks.push(out.after);
    }
    await this.fanOut(tx, e, tenantId);
    return chainAfter(callbacks);
  }

  private async fanOut(tx: Tx, e: ConsumedEvent, tenantId: string): Promise<void> {
    const type = webhookTypeOf(e.topic);
    if (type) await this.webhooks.fanOut(tx, tenantId, type, e.eventId, e.payload);
  }

  private async invited(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof UserInvited>;
    await this.begin(tx, p.tenant_id);
    await this.store.upsertRecipient(
      tx,
      p.tenant_id,
      p.user_id,
      { email: p.email, roles: p.roles, active: true },
      this.clock.now(),
    );
    return undefined;
  }

  private async rolesChanged(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof UserRolesChanged>;
    await this.begin(tx, p.tenant_id);
    await this.store.upsertRecipient(
      tx,
      p.tenant_id,
      p.user_id,
      { roles: p.roles },
      this.clock.now(),
    );
    return undefined;
  }

  private async deactivated(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof UserDeactivated>;
    await this.begin(tx, p.tenant_id);
    await this.store.upsertRecipient(
      tx,
      p.tenant_id,
      p.user_id,
      { active: false },
      this.clock.now(),
    );
    return undefined;
  }

  private async submitted(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof SessionSubmitted>;
    await this.begin(tx, p.tenant_id);
    return this.toRoles(
      tx,
      e,
      p.tenant_id,
      'assessment_submitted',
      RECRUITERS,
      {
        Session_Id: p.session_id,
        Assessment_Id: p.assessment_id,
        Outcome: p.outcome,
        Link_Path: `/recruiter/sessions/${p.session_id}`,
      },
      `submitted:${p.session_id}`,
    );
  }

  private async terminated(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof SessionTerminated>;
    await this.begin(tx, p.tenant_id);
    return this.toRoles(
      tx,
      e,
      p.tenant_id,
      'assessment_terminated',
      RECRUITERS,
      {
        Session_Id: p.session_id,
        Assessment_Id: p.assessment_id,
        Reason: p.reason,
        Link_Path: `/recruiter/sessions/${p.session_id}`,
      },
      `terminated:${p.session_id}`,
    );
  }

  private async webhookOnly(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const tenantId = (e.payload as { tenant_id: string }).tenant_id;
    await this.begin(tx, tenantId);
    await this.fanOut(tx, e, tenantId);
    return undefined;
  }

  private async proctoring(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof ProctoringSessionFinalized>;
    await this.begin(tx, p.tenant_id);
    if (!p.review_required) {
      await this.fanOut(tx, e, p.tenant_id);
      return undefined;
    }
    return this.toRoles(
      tx,
      e,
      p.tenant_id,
      'proctoring_review_required',
      REVIEWERS,
      {
        Session_Id: p.session_id,
        Trust_Score: String(p.trust_score),
        Band: p.band,
        Link_Path: `/recruiter/reviews/proctoring/${p.session_id}`,
      },
      `proctoring:${p.session_id}:${p.revision}`,
    );
  }

  private async interview(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof InterviewCompleted>;
    await this.begin(tx, p.tenant_id);
    if (!p.needs_review) {
      await this.fanOut(tx, e, p.tenant_id);
      return undefined;
    }
    return this.toRoles(
      tx,
      e,
      p.tenant_id,
      'interview_review_required',
      ['reviewer'],
      {
        Session_Id: p.session_id,
        Link_Path: `/recruiter/reviews/interviews/${p.session_id}`,
      },
      `interview:${p.session_id}:${p.question_id}`,
    );
  }

  /** HRBPs (directory tag `hrbp`) and the manager; never the employee, never the probability. */
  private async attrition(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof AttritionAlertRaised>;
    await this.begin(tx, p.tenant_id);
    const users = new Set<string>();
    if (p.recipients.includes('hrbp'))
      for (const r of await this.store.recipientsWith(tx, [], ['hrbp'])) users.add(r.userId);
    if (p.recipients.includes('manager') && p.manager_user_id) users.add(p.manager_user_id);
    const callbacks: (AfterCommit | undefined)[] = [];
    for (const userId of users) {
      const out = await this.dispatcher.dispatch(tx, {
        tenantId: p.tenant_id,
        type: 'attrition_alert',
        to: { userId },
        values: {
          Employee_Id: p.employee_id,
          Drivers: p.drivers.join('; '),
          Link_Path: `/admin/workforce/attrition/alerts/${p.alert_id}`,
        },
        dedupeKey: `attrition:${p.alert_id}:${userId}`,
      });
      callbacks.push(out.after);
    }
    return chainAfter(callbacks);
  }

  private async reportReady(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof ReportArtifactReady>;
    await this.begin(tx, p.tenant_id);
    await this.fanOut(tx, e, p.tenant_id);
    const out = await this.dispatcher.dispatch(tx, {
      tenantId: p.tenant_id,
      type: 'report_ready',
      to: { userId: p.requested_by },
      values: { Report_Type: p.type.replace(/_/g, ' '), Link_Path: `/reports/${p.report_id}` },
      dedupeKey: `report:${p.report_id}`,
    });
    return out.after;
  }

  private async erasure(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof ErasureRequested>;
    await this.begin(tx, p.tenant_id);
    const removed = await this.store.eraseSubject(tx, p.candidate_id);
    if (p.ack_required_from.includes(NOTIFICATION_CONSUMER))
      await appendOutbox(
        tx,
        ErasureAcknowledged.build({
          tenantId: p.tenant_id,
          aggregateId: p.request_id,
          payload: {
            tenant_id: p.tenant_id,
            request_id: p.request_id,
            service: NOTIFICATION_CONSUMER,
            occurred_at: this.clock.now().toISOString(),
          },
        }),
      );
    this.logger?.info(
      { tenant_id: p.tenant_id, request_id: p.request_id, removed },
      'erasure applied',
    );
    return undefined;
  }

  private async purged(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof TenantPurged>;
    await this.begin(tx, p.tenant_id);
    await this.store.purgeTenant(tx);
    return undefined;
  }
}
