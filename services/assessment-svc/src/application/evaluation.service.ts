import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import { AssessmentSessionEvaluated, SessionSubmitted, SessionTerminated } from '@atlas/contracts';
import { appendOutbox, CLOCK, type Clock, ConflictError, type Tx } from '@atlas/platform';
import { performanceBand, planItems } from '../domain/assessment';
import { autoScore, type Question } from '../domain/questions';
import {
  assertTransition,
  effectiveAnswer,
  evaluate,
  type Evaluation,
  type SessionStatus,
} from '../domain/session';
import {
  ASSESSMENT_LOGGER,
  ASSESSMENT_REPOSITORY,
  type AssessmentRepository,
  QUESTION_REPOSITORY,
  type QuestionRepository,
  RESPONSE_REPOSITORY,
  type ResponseRepository,
  type Session,
  SESSION_REPOSITORY,
  type SessionRepository,
} from './ports';

const MONTH_MS = 30.4375 * 24 * 3600 * 1000;

/**
 * Ending and evaluating sessions: shared by the candidate runtime (submit), the expiry sweeper,
 * proctoring (terminate), the judge, and reviewers. Every transition is a compare-and-set on
 * lock_version, so exactly one of two concurrent submits wins.
 */
@Injectable()
export class EvaluationService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(RESPONSE_REPOSITORY) private readonly responses: ResponseRepository,
    @Inject(QUESTION_REPOSITORY) private readonly questions: QuestionRepository,
    @Inject(ASSESSMENT_REPOSITORY) private readonly assessments: AssessmentRepository,
    @Inject(ASSESSMENT_LOGGER) private readonly logger: Logger | null,
  ) {}

  async planQuestions(tx: Tx, s: Session): Promise<Map<string, Question>> {
    return this.questions.versions(
      tx,
      planItems(s.plan).map(({ item }) => ({ id: item.question_id, version: item.version })),
    );
  }

  /**
   * Ends a live session (submitted, expired or terminated). Answers are frozen as they were last
   * acknowledged; descriptive answers go to review and coding answers wait for the judge.
   */
  async end(
    tx: Tx,
    s: Session,
    to: Extract<SessionStatus, 'submitted' | 'expired' | 'terminated'>,
    reason?: string,
  ): Promise<Session> {
    assertTransition(s.status, to);
    const now = this.clock.now();
    const questions = await this.planQuestions(tx, s);
    const saved = await this.responses.all(tx, s.id);
    let reviewRequired = false;
    let dispatch = false;
    for (const { item } of planItems(s.plan)) {
      const q = questions.get(`${item.question_id}@${item.version}`);
      if (!q) continue;
      const stored = saved.get(item.question_id);
      const answer = effectiveAnswer(q, stored);
      const score = autoScore(q, item.marks, answer);
      await this.responses.ensure(tx, s.tenantId, s.id, item.question_id);
      if (score.needs === 'review') reviewRequired = true;
      // A coding draft that was never submitted to the judge is auto-submitted (sweeper).
      if (score.needs === 'judge' && !stored?.judge) dispatch = true;
      if (
        score.needs === 'judge' &&
        stored?.autoScore !== null &&
        stored?.autoScore !== undefined
      ) {
        continue; // already judged while the session was running: keep that result
      }
      await this.responses.setScore(tx, s.id, item.question_id, {
        autoScore: score.score,
        state:
          score.needs === 'review'
            ? 'pending_review'
            : score.needs === 'judge'
              ? 'pending_judge'
              : 'scored',
      });
    }
    const ended = await this.sessions.update(tx, s.id, s.lockVersion, {
      status: to,
      submittedAt: s.startedAt ? now : null,
      pausedAt: null,
      ...(reviewRequired ? { reviewStatus: 'pending_review' as const } : {}),
      ...(reason ? { terminationReason: reason.slice(0, 200) } : {}),
      ...(dispatch ? { codingDispatchPending: true } : {}),
    });
    if (!ended)
      throw new ConflictError(
        'SESSION_CHANGED',
        'The session changed concurrently; it was not ended twice.',
      );
    const ref = {
      tenant_id: s.tenantId,
      session_id: s.id,
      assessment_id: s.assessmentId,
      assessment_version: s.assessmentVersion,
      candidate_id: s.candidateId,
    };
    if (to === 'terminated') {
      await appendOutbox(
        tx,
        SessionTerminated.build({
          tenantId: s.tenantId,
          aggregateId: s.id,
          payload: { ...ref, reason: reason ?? 'terminated', occurred_at: now.toISOString() },
        }),
      );
    } else {
      await appendOutbox(
        tx,
        SessionSubmitted.build({
          tenantId: s.tenantId,
          aggregateId: s.id,
          payload: {
            ...ref,
            outcome: to,
            review_required: reviewRequired,
            occurred_at: now.toISOString(),
          },
        }),
      );
    }
    return (await this.tryEvaluate(tx, ended)) ?? ended;
  }

  /**
   * Evaluates an ended session once nothing waits on a reviewer or the judge: score, band,
   * per-skill proficiency, item statistics and `assessment.session.evaluated.v1`. Returns null
   * while the score is held.
   */
  async tryEvaluate(tx: Tx, s: Session): Promise<Session | null> {
    if (!['submitted', 'expired', 'terminated'].includes(s.status)) return null;
    const assessment = await this.assessments.get(tx, s.assessmentId, s.assessmentVersion);
    if (!assessment) return null;
    const result: Evaluation = evaluate(
      s.plan,
      await this.planQuestions(tx, s),
      await this.responses.all(tx, s.id),
    );
    if (result.pending) {
      this.logger?.info(
        { tenant_id: s.tenantId, session_id: s.id },
        'evaluation held (review or judge pending)',
      );
      return null;
    }
    const now = this.clock.now();
    const evaluated = await this.sessions.update(tx, s.id, s.lockVersion, {
      status: 'evaluated',
      evaluatedAt: now,
      rawScore: result.raw,
      maxScore: result.max,
      performanceBand: performanceBand(result.percent, assessment.reportConfig),
      skillScores: result.skills,
      ...(result.needsReview ? { reviewStatus: 'cleared' as const } : {}),
    });
    if (!evaluated) throw new ConflictError('SESSION_CHANGED', 'The session changed concurrently.');
    // Terminated sessions are scored for the record but produce no skill evidence.
    if (s.status !== 'terminated') {
      await this.questions.recordAttempts(
        tx,
        s.tenantId,
        result.questions
          .filter((q) => q.correct !== null)
          .map((q) => ({
            questionId: q.question_id,
            version:
              planItems(s.plan).find((p) => p.item.question_id === q.question_id)?.item.version ??
              1,
            correct: q.correct === true,
            score: q.score ?? 0,
          })),
      );
      if (result.skills.length > 0) {
        await appendOutbox(
          tx,
          AssessmentSessionEvaluated.build({
            tenantId: s.tenantId,
            aggregateId: s.id,
            payload: {
              tenant_id: s.tenantId,
              candidate_id: s.candidateId,
              session_id: s.id,
              skills: result.skills.map((k) => ({
                skill_id: k.skill_id,
                score: k.score,
                confidence: k.confidence,
              })),
              valid_until: new Date(
                now.getTime() + assessment.reportConfig.skill_validity_months * MONTH_MS,
              ).toISOString(),
              evaluated_at: now.toISOString(),
            },
          }),
        );
      }
    }
    return evaluated;
  }
}
