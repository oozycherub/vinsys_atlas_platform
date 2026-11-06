import { Inject, Injectable, Optional } from '@nestjs/common';
import { type Logger } from 'pino';
import { type z } from 'zod';
import {
  AssessmentSessionEvaluated,
  ErasureAcknowledged,
  ErasureRequested,
  type EventDefinition,
  InterviewCompleted,
  ProctoringSessionFinalized,
  SessionStarted,
  SessionSubmitted,
  SessionTerminated,
  TenantPurged,
} from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  type ConsumedEvent,
  type EventHandler,
  setTenantContext,
  type Tx,
} from '@atlas/platform';
import { type ReportStore, REPORT_STORE } from './store';
import { ARTIFACT_STORE, type ArtifactStore, REPORT_LOGGER } from './ports';

export const REPORT_CONSUMER = 'report-svc';
type Payload<T extends EventDefinition<z.ZodTypeAny>> = z.output<T['schema']>;

/** Builds `report_session_facts` from the owners' events (ADR-0010 §6), and handles erasure. */
@Injectable()
export class ReportEventHandlers {
  constructor(
    @Inject(REPORT_STORE) private readonly store: ReportStore,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(REPORT_LOGGER) private readonly logger: Logger | null,
  ) {}

  handlers(): Record<string, EventHandler> {
    return {
      [SessionStarted.topic]: (tx, e) => this.started(tx, e),
      [SessionSubmitted.topic]: (tx, e) => this.submitted(tx, e),
      [SessionTerminated.topic]: (tx, e) => this.terminated(tx, e),
      [AssessmentSessionEvaluated.topic]: (tx, e) => this.evaluated(tx, e),
      [ProctoringSessionFinalized.topic]: (tx, e) => this.trust(tx, e),
      [InterviewCompleted.topic]: (tx, e) => this.interview(tx, e),
      [ErasureRequested.topic]: (tx, e) => this.erasure(tx, e),
      [TenantPurged.topic]: (tx, e) => this.purged(tx, e),
    };
  }

  private now(): Date {
    return this.clock.now();
  }

  private async started(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof SessionStarted>;
    await setTenantContext(tx, p.tenant_id);
    await this.store.upsertFacts(
      tx,
      p.tenant_id,
      p.session_id,
      {
        assessment_id: p.assessment_id,
        assessment_version: p.assessment_version,
        candidate_id: p.candidate_id,
        attempt_no: p.attempt_no,
        started_at: p.occurred_at,
        deadline_at: p.deadline_at,
      },
      this.now(),
    );
    return undefined;
  }

  private async submitted(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof SessionSubmitted>;
    await setTenantContext(tx, p.tenant_id);
    await this.store.upsertFacts(
      tx,
      p.tenant_id,
      p.session_id,
      {
        assessment_id: p.assessment_id,
        assessment_version: p.assessment_version,
        candidate_id: p.candidate_id,
        submitted_at: p.occurred_at,
        outcome: p.outcome,
      },
      this.now(),
    );
    return undefined;
  }

  private async terminated(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof SessionTerminated>;
    await setTenantContext(tx, p.tenant_id);
    await this.store.upsertFacts(
      tx,
      p.tenant_id,
      p.session_id,
      {
        assessment_id: p.assessment_id,
        assessment_version: p.assessment_version,
        candidate_id: p.candidate_id,
        terminated_reason: p.reason,
      },
      this.now(),
    );
    return undefined;
  }

  private async evaluated(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof AssessmentSessionEvaluated>;
    await setTenantContext(tx, p.tenant_id);
    await this.store.upsertFacts(
      tx,
      p.tenant_id,
      p.session_id,
      {
        candidate_id: p.candidate_id,
        skills: p.skills.map((s) => ({
          skillId: s.skill_id,
          score: s.score,
          confidence: s.confidence,
        })),
        evaluated_at: p.evaluated_at,
      },
      this.now(),
    );
    return undefined;
  }

  private async trust(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof ProctoringSessionFinalized>;
    await setTenantContext(tx, p.tenant_id);
    await this.store.upsertTrust(
      tx,
      p.tenant_id,
      p.session_id,
      {
        assessmentId: p.assessment_id,
        score: p.trust_score,
        band: p.band,
        breakdown: p.breakdown,
        review: p.review_required,
        revision: p.revision,
      },
      this.now(),
    );
    return undefined;
  }

  /** Only the interview summary (ADR-0008 members); per-question events without it are skipped. */
  private async interview(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof InterviewCompleted>;
    if (p.recommendation === undefined && p.competencies === undefined) return undefined;
    await setTenantContext(tx, p.tenant_id);
    await this.store.upsertInterview(
      tx,
      p.tenant_id,
      p.session_id,
      {
        recommendation: p.recommendation ?? null,
        outcome: p.outcome ?? null,
        needsReview: p.needs_review,
        competencies: (p.competencies ?? []).map((c) => ({
          skillId: c.skill_id,
          weight: c.weight,
          score: c.score,
        })),
      },
      p.revision ?? 1,
      this.now(),
    );
    return undefined;
  }

  private async erasure(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof ErasureRequested>;
    await setTenantContext(tx, p.tenant_id);
    const keys = await this.store.eraseCandidate(tx, p.candidate_id);
    if (p.ack_required_from.includes(REPORT_CONSUMER))
      await appendOutbox(
        tx,
        ErasureAcknowledged.build({
          tenantId: p.tenant_id,
          aggregateId: p.request_id,
          payload: {
            tenant_id: p.tenant_id,
            request_id: p.request_id,
            service: REPORT_CONSUMER,
            occurred_at: this.now().toISOString(),
          },
        }),
      );
    this.logger?.info(
      { tenant_id: p.tenant_id, request_id: p.request_id, artifacts: keys.length },
      'erasure applied',
    );
    // Objects go only after the rows are gone for good.
    return keys.length ? () => this.artifacts.delete(keys) : undefined;
  }

  private async purged(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof TenantPurged>;
    await setTenantContext(tx, p.tenant_id);
    await this.store.purgeTenant(tx);
    return () => this.artifacts.deletePrefix(`${p.tenant_id}/`);
  }
}
