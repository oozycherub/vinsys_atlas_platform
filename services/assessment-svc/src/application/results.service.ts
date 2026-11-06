import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import {
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  DomainRuleError,
  ForbiddenError,
  hasAnyRole,
  NotFoundError,
  PreconditionFailedError,
  type Principal,
  type Tx,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { planItems } from '../domain/assessment';
import {
  type CandidateStatus,
  consensus,
  ENDED,
  evaluate,
  INTERRUPTION_SECONDS,
  isExpired,
  isReviewable,
} from '../domain/session';
import { tenantOf, translate } from './access';
import { CodingDispatcher } from './coding-dispatch.service';
import { EvaluationService } from './evaluation.service';
import {
  ASSESSMENT_LOGGER,
  ASSESSMENT_REPOSITORY,
  type AssessmentRepository,
  RESPONSE_REPOSITORY,
  type ResponseRepository,
  REVIEW_REPOSITORY,
  type ReviewRepository,
  type Session,
  type SessionFilters,
  SESSION_REPOSITORY,
  type SessionRepository,
} from './ports';
import { toSessionResultView } from './views';

/** Results, the reviewer workflow and the candidate pipeline; plus the expiry sweeper. */
@Injectable()
export class ResultsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(RESPONSE_REPOSITORY) private readonly responses: ResponseRepository,
    @Inject(REVIEW_REPOSITORY) private readonly reviews: ReviewRepository,
    @Inject(ASSESSMENT_REPOSITORY) private readonly assessments: AssessmentRepository,
    @Inject(ASSESSMENT_LOGGER) private readonly logger: Logger | null,
    private readonly evaluation: EvaluationService,
    private readonly dispatcher: CodingDispatcher,
  ) {}

  async list(
    p: Principal,
    tenant: string | undefined,
    assessmentId: string,
    filters: SessionFilters,
  ) {
    const tenantId = tenantOf(p, tenant);
    const items = await withTenantTx(this.db, tenantId, (tx) =>
      this.sessions.list(tx, assessmentId, filters),
    );
    return { items: items.map(toSessionResultView) };
  }

  /** The full result for staff: per-question answers, scores and the answer key. */
  async result(p: Principal, tenant: string | undefined, sessionId: string) {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const s = await this.load(tx, sessionId);
      const questions = await this.evaluation.planQuestions(tx, s);
      const saved = await this.responses.all(tx, s.id);
      const evaluation = evaluate(s.plan, questions, saved);
      return {
        ...toSessionResultView(s),
        questions: planItems(s.plan).map(({ item, index, section }) => {
          const q = questions.get(`${item.question_id}@${item.version}`);
          const r = saved.get(item.question_id);
          const scored = evaluation.questions.find((x) => x.question_id === item.question_id);
          return {
            index,
            section,
            question_id: item.question_id,
            version: item.version,
            type: q?.type ?? null,
            marks: item.marks,
            answer: r?.answer ?? null,
            state: r?.state ?? 'saved',
            score: scored?.score ?? null,
            correct: scored?.correct ?? null,
            pending: scored?.pending ?? null,
            answer_key: q?.payload ?? null,
          };
        }),
        reviews: (await this.reviews.list(tx, s.id)).map((r) => ({
          reviewer_id: r.reviewerId,
          status: r.status,
          scores: r.scores,
          comment: r.comment,
          completed_at: r.completedAt?.toISOString() ?? null,
        })),
      };
    });
  }

  /** Assigns reviewers to a session whose descriptive answers need marking. */
  async assignReviewers(
    p: Principal,
    tenant: string | undefined,
    sessionId: string,
    reviewerIds: string[],
  ) {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const s = await this.load(tx, sessionId, true);
      if (!['pending_review', 'in_review'].includes(s.reviewStatus)) {
        throw new DomainRuleError('REVIEW_NOT_REQUIRED', 'This session has nothing to review.');
      }
      for (const id of reviewerIds) await this.reviews.assign(tx, tenantId, s.id, id, p.subject);
      const updated = await this.sessions.update(tx, s.id, s.lockVersion, {
        reviewStatus: 'in_review',
      });
      if (!updated)
        throw new PreconditionFailedError('SESSION_CHANGED', 'The session changed; retry.');
      return {
        session_id: s.id,
        review_status: 'in_review',
        reviewers: (await this.reviews.list(tx, s.id)).map((r) => r.reviewerId),
      };
    });
  }

  /**
   * A reviewer's marks. The score stays held until EVERY assigned reviewer has finished; then
   * each reviewed question takes the reviewers' mean and the session is evaluated.
   */
  async review(
    p: Principal,
    tenant: string | undefined,
    sessionId: string,
    scores: Record<string, number>,
    comment: string | null,
  ) {
    const tenantId = tenantOf(p, tenant);
    return translate(() =>
      withTenantTx(this.db, tenantId, async (tx) => {
        const s = await this.load(tx, sessionId, true);
        const assignments = await this.reviews.list(tx, s.id);
        const mine = assignments.find((a) => a.reviewerId === p.subject);
        if (!mine)
          throw new ForbiddenError('You are not a reviewer of this session.', 'NOT_ASSIGNED');
        if (mine.status === 'done')
          throw new DomainRuleError('ALREADY_REVIEWED', 'You have already submitted this review.');
        const questions = await this.evaluation.planQuestions(tx, s);
        const saved = await this.responses.all(tx, s.id);
        const reviewable = new Map(
          planItems(s.plan)
            .filter(({ item }) => {
              const q = questions.get(`${item.question_id}@${item.version}`);
              return q !== undefined && isReviewable(q, item.marks, saved.get(item.question_id));
            })
            .map(({ item }) => [item.question_id, item.marks]),
        );
        for (const [qid, marks] of Object.entries(scores)) {
          const max = reviewable.get(qid);
          if (max === undefined)
            throw new DomainRuleError('NOT_REVIEWABLE', `Question ${qid} is not up for review.`);
          if (marks < 0 || marks > max)
            throw new DomainRuleError('INVALID_MARKS', `Marks for ${qid} must be 0–${max}.`);
        }
        const missing = [...reviewable.keys()].filter((qid) => !(qid in scores));
        if (missing.length)
          throw new DomainRuleError(
            'INCOMPLETE_REVIEW',
            `Score every reviewable question (${missing.length} missing).`,
          );
        await this.reviews.complete(tx, s.id, p.subject, scores, comment, this.clock.now());

        const all = await this.reviews.list(tx, s.id);
        if (all.some((a) => a.status !== 'done')) {
          return {
            session_id: s.id,
            status: s.status,
            released: false,
            pending_reviewers: all.filter((a) => a.status !== 'done').length,
          };
        }
        for (const qid of reviewable.keys()) {
          const mean = consensus(
            all.map((a) => a.scores?.[qid]).filter((x): x is number => typeof x === 'number'),
          );
          await this.responses.setScore(tx, s.id, qid, { manualScore: mean, state: 'reviewed' });
        }
        const evaluated = ENDED.includes(s.status)
          ? await this.evaluation.tryEvaluate(tx, s)
          : null;
        return {
          session_id: s.id,
          status: (evaluated ?? s).status,
          released: evaluated !== null,
          pending_reviewers: 0,
        };
      }),
    );
  }

  /** Shortlist / reject (If-Match on lock_version). */
  async candidateStatus(
    p: Principal,
    tenant: string | undefined,
    sessionId: string,
    status: CandidateStatus,
    expectedLock: number,
  ) {
    const tenantId = tenantOf(p, tenant);
    if (!hasAnyRole(p, ['tenant_admin', 'recruiter', 'hiring_manager', 'super_admin', 'service'])) {
      throw new ForbiddenError('Your role cannot change candidate status.');
    }
    return withTenantTx(this.db, tenantId, async (tx) => {
      await this.load(tx, sessionId);
      const updated = await this.sessions.update(tx, sessionId, expectedLock, {
        candidateStatus: status,
      });
      if (!updated)
        throw new PreconditionFailedError('VERSION_MISMATCH', 'The session changed; reload it.');
      return toSessionResultView(updated);
    });
  }

  /**
   * The expiry workflow: live sessions past their deadline are auto-submitted with the last
   * acknowledged answers; sessions whose heartbeat stopped are paused (the interruption rule).
   */
  async sweep(limit = 100): Promise<{ expired: number; paused: number; dispatched: number }> {
    const now = this.clock.now();
    const due = await withSystemTx(this.db, (tx) =>
      this.sessions.due(tx, now, INTERRUPTION_SECONDS, limit),
    );
    let expired = 0;
    let paused = 0;
    for (const candidate of due) {
      try {
        await withTenantTx(this.db, candidate.tenantId, async (tx) => {
          const s = await this.load(tx, candidate.id, true);
          if (!['started', 'in_progress', 'paused'].includes(s.status)) return;
          const a = await this.assessments.get(tx, s.assessmentId, s.assessmentVersion);
          const allowance = a?.settings.pause_allowance_seconds ?? 0;
          if (isExpired(s, now, allowance)) {
            await this.evaluation.end(tx, s, 'expired');
            expired += 1;
            return;
          }
          const silentSince = s.lastHeartbeatAt ?? s.startedAt;
          if (
            s.status !== 'paused' &&
            silentSince &&
            now.getTime() - silentSince.getTime() >= INTERRUPTION_SECONDS * 1000
          ) {
            if (
              await this.sessions.update(tx, s.id, s.lockVersion, {
                status: 'paused',
                pausedAt: silentSince,
              })
            )
              paused += 1;
          }
        });
      } catch (error) {
        this.logger?.warn({ err: error, session_id: candidate.id }, 'sweep of one session failed');
      }
    }
    // Coding drafts of ended sessions go to the judge (retried here until they are sent).
    const dispatched = await this.dispatcher.dispatchPending(limit);
    return { expired, paused, dispatched };
  }

  async runForever(intervalMs = 5000): Promise<never> {
    for (;;) {
      try {
        await this.sweep();
      } catch (error) {
        this.logger?.error({ err: error }, 'session sweep failed');
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private async load(tx: Tx, id: string, forUpdate = false): Promise<Session> {
    const s = await this.sessions.get(tx, id, { forUpdate });
    if (!s) throw new NotFoundError('SESSION_NOT_FOUND', 'No such session.');
    return s;
  }
}
