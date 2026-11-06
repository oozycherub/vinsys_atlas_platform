import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import {
  ErasureAcknowledged,
  ErasureRequested,
  InterviewCompleted,
  ProctoringSessionFinalized,
  SubmissionJudged,
  TenantPurged,
  ViolationRaised,
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
import { planItems } from '../domain/assessment';
import { round2 } from '../domain/questions';
import { ENDED, LIVE } from '../domain/session';
import { EvaluationService } from './evaluation.service';
import {
  ASSESSMENT_LOGGER,
  ASSESSMENT_SETTINGS,
  type AssessmentServiceSettings,
  RESPONSE_REPOSITORY,
  type ResponseRepository,
  type Session,
  SESSION_REPOSITORY,
  type SessionRepository,
} from './ports';

export const ASSESSMENT_CONSUMER = 'assessment-svc.events';

type Payload<T extends { schema: { _output: unknown } }> = T['schema']['_output'];

/** Events assessment-svc consumes (Component Prompt 08 §5). */
@Injectable()
export class AssessmentEventHandlers {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(RESPONSE_REPOSITORY) private readonly responses: ResponseRepository,
    @Inject(ASSESSMENT_SETTINGS) private readonly settings: AssessmentServiceSettings,
    @Inject(ASSESSMENT_LOGGER) private readonly logger: Logger | null,
    private readonly evaluation: EvaluationService,
  ) {}

  handlers(): Record<string, EventHandler> {
    return {
      [SubmissionJudged.topic]: (tx, e) => this.judged(tx, e),
      [ViolationRaised.topic]: (tx, e) => this.violation(tx, e),
      [InterviewCompleted.topic]: (tx, e) => this.interview(tx, e),
      [ProctoringSessionFinalized.topic]: (tx, e) => this.proctored(tx, e),
      [ErasureRequested.topic]: (tx, e) => this.erasure(tx, e),
      [TenantPurged.topic]: (tx, e) => this.purged(tx, e),
    };
  }

  private async session(tx: Tx, tenantId: string, id: string): Promise<Session | null> {
    await setTenantContext(tx, tenantId);
    return this.sessions.get(tx, id, { forUpdate: true });
  }

  /**
   * The judge scored a coding answer: marks × the weighted share of passed tests. Results of an
   * older submission than the one on record are ignored (deliveries can arrive out of order). An
   * internal_error is never charged: the answer goes to a person instead (PRD §2.2d).
   */
  private async judged(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof SubmissionJudged>;
    let s = await this.session(tx, p.tenant_id, p.session_id);
    const item = s
      ? planItems(s.plan).find((x) => x.item.question_id === p.question_id)?.item
      : undefined;
    if (!s || !item) return undefined; // erased, or not a question of this session
    const current = (await this.responses.all(tx, s.id)).get(p.question_id)?.judge ?? null;
    if (
      current &&
      current.submission_id !== p.submission_id &&
      (!p.submitted_at || p.submitted_at < current.submitted_at)
    ) {
      return undefined; // a newer submission is on record
    }
    const judge = {
      submission_id: p.submission_id,
      submitted_at: p.submitted_at ?? current?.submitted_at ?? p.judged_at,
      verdict: p.verdict,
      tests_passed: p.tests_passed,
      tests_total: p.tests_total,
    };
    await this.responses.ensure(tx, s.tenantId, s.id, p.question_id);
    if (p.verdict === 'internal_error') {
      await this.responses.setScore(tx, s.id, p.question_id, {
        autoScore: null,
        state: 'pending_review',
        judge,
      });
      if (s.reviewStatus === 'not_required') {
        s =
          (await this.sessions.update(tx, s.id, s.lockVersion, {
            reviewStatus: 'pending_review',
          })) ?? s;
      }
    } else {
      const ratio =
        p.score_ratio ??
        (p.verdict === 'accepted' ? 1 : p.tests_total > 0 ? p.tests_passed / p.tests_total : 0);
      await this.responses.setScore(tx, s.id, p.question_id, {
        autoScore: round2(item.marks * ratio),
        state: 'scored',
        judge,
      });
    }
    if (ENDED.includes(s.status) && s.status !== 'evaluated')
      await this.evaluation.tryEvaluate(tx, s);
    return undefined;
  }

  /** Proctoring: record the trust score; `terminate` ends a live session; `review` flags it. */
  private async violation(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof ViolationRaised>;
    let s = await this.session(tx, p.tenant_id, p.session_id);
    if (!s) return undefined;
    if (p.trust_score !== null || p.action === 'review') {
      const updated = await this.sessions.update(tx, s.id, s.lockVersion, {
        ...(p.trust_score !== null ? { trustScore: p.trust_score } : {}),
        ...(p.action === 'review' && s.reviewStatus === 'not_required'
          ? { reviewStatus: 'pending_review' as const }
          : {}),
      });
      if (updated) s = updated;
    }
    if (p.action === 'terminate' && (LIVE.includes(s.status) || s.status === 'invited')) {
      await this.evaluation.end(tx, s, 'terminated', `proctoring: ${p.rule}`);
      this.logger?.warn(
        { tenant_id: s.tenantId, session_id: s.id, rule: p.rule },
        'session terminated by proctoring',
      );
    }
    return undefined;
  }

  /**
   * proctoring-svc's Trust Score (and its revisions after reviews). Red sessions need a human
   * decision: no candidate is rejected on AI inference alone (PRD §4.1).
   */
  private async proctored(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof ProctoringSessionFinalized>;
    const s = await this.session(tx, p.tenant_id, p.session_id);
    if (!s) return undefined;
    await this.sessions.update(tx, s.id, s.lockVersion, {
      trustScore: p.trust_score,
      ...(p.review_required && s.reviewStatus === 'not_required'
        ? { reviewStatus: 'pending_review' as const }
        : {}),
    });
    return undefined;
  }

  /**
   * An AI interview question was scored. One interview-svc sends to review (insufficient
   * evidence, flags, approval required) puts the session into review, like a judge fault; a
   * later revision without review (a recruiter's override in interview-svc) settles it.
   */
  private async interview(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof InterviewCompleted>;
    let s = await this.session(tx, p.tenant_id, p.session_id);
    const item = s
      ? planItems(s.plan).find((x) => x.item.question_id === p.question_id)?.item
      : undefined;
    if (!s || !item) return undefined;
    await this.responses.ensure(tx, s.tenantId, s.id, p.question_id);
    await this.responses.setScore(tx, s.id, p.question_id, {
      autoScore: round2(item.marks * p.score_ratio),
      state: p.needs_review ? 'pending_review' : 'scored',
    });
    const review: Session['reviewStatus'] | null = p.needs_review
      ? s.reviewStatus === 'not_required'
        ? 'pending_review'
        : null
      : s.reviewStatus === 'pending_review' &&
          ![...(await this.responses.all(tx, s.id)).values()].some(
            (r) => r.state === 'pending_review',
          )
        ? 'cleared'
        : null;
    if (review)
      s = (await this.sessions.update(tx, s.id, s.lockVersion, { reviewStatus: review })) ?? s;
    if (!p.needs_review && ENDED.includes(s.status) && s.status !== 'evaluated')
      await this.evaluation.tryEvaluate(tx, s);
    return undefined;
  }

  /** Erasure: the candidate's sessions (responses and reviews cascade), then acknowledge. */
  private async erasure(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof ErasureRequested>;
    await setTenantContext(tx, p.tenant_id);
    const sessions = await this.sessions.deleteCandidate(tx, p.candidate_id);
    const invites = await tx.query('DELETE FROM assessment_invites WHERE candidate_id = $1', [
      p.candidate_id,
    ]);
    if (p.ack_required_from.includes(this.settings.erasureService)) {
      await appendOutbox(
        tx,
        ErasureAcknowledged.build({
          tenantId: p.tenant_id,
          aggregateId: p.request_id,
          payload: {
            tenant_id: p.tenant_id,
            request_id: p.request_id,
            service: this.settings.erasureService,
            occurred_at: this.clock.now().toISOString(),
          },
        }),
      );
    }
    this.logger?.info(
      { tenant_id: p.tenant_id, request_id: p.request_id, sessions, invites: invites.rowCount },
      'candidate erased',
    );
    return undefined;
  }

  private async purged(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const tenantId = (e.payload as { tenant_id: string }).tenant_id;
    await setTenantContext(tx, tenantId);
    for (const table of [
      'review_assignments',
      'session_responses',
      'assessment_sessions',
      'assessment_invites',
      'assessments',
      'question_stats',
      'questions',
      'question_banks',
    ]) {
      await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    return undefined;
  }
}
