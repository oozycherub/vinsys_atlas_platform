import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  sha256,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { type Logger } from 'pino';
import { planItems } from '../domain/assessment';
import { EvaluationService } from './evaluation.service';
import {
  ASSESSMENT_LOGGER,
  type JudgeRef,
  RESPONSE_REPOSITORY,
  type ResponseRepository,
  SANDBOX_GATEWAY,
  type SandboxGateway,
  SESSION_REPOSITORY,
  type SessionRepository,
} from './ports';

/** The idempotency key of a coding submission: the same code for the same question is one job. */
export function submissionKey(sessionId: string, questionId: string, code: string): string {
  return `${sessionId}:${sha256(`${questionId}|${code}`).toString('hex')}`;
}

/**
 * Auto-submit (PRD §2.2d): when a session ends, coding drafts that were never submitted go to
 * the judge. The session carries a flag until every draft has a submission, so a failed call
 * is retried by the sweeper, and the idempotency key makes retries harmless.
 */
@Injectable()
export class CodingDispatcher {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(RESPONSE_REPOSITORY) private readonly responses: ResponseRepository,
    @Inject(SANDBOX_GATEWAY) private readonly sandbox: SandboxGateway,
    @Inject(ASSESSMENT_LOGGER) private readonly logger: Logger | null,
    private readonly evaluation: EvaluationService,
  ) {}

  /** Sends one session's pending drafts. Returns how many were submitted. */
  async dispatch(tenantId: string, sessionId: string): Promise<number> {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const s = await this.sessions.get(tx, sessionId, { forUpdate: true });
      if (!s?.codingDispatchPending) return 0;
      const questions = await this.evaluation.planQuestions(tx, s);
      const saved = await this.responses.all(tx, s.id);
      let sent = 0;
      for (const { item } of planItems(s.plan)) {
        const q = questions.get(`${item.question_id}@${item.version}`);
        const r = saved.get(item.question_id);
        const answer = r?.answer as { language?: string; code?: string } | null | undefined;
        if (q?.type !== 'coding' || !answer?.code || !answer.language || r?.judge) continue;
        const { submission_id } = await this.sandbox.submit(
          s.tenantId,
          s.id,
          q.id,
          {
            language: answer.language,
            source: answer.code,
            question_version: q.version,
            assessment_id: s.assessmentId,
            candidate_id: s.candidateId,
          },
          submissionKey(s.id, q.id, answer.code),
        );
        const ref: JudgeRef = {
          submission_id,
          submitted_at: this.clock.now().toISOString(),
          status: 'queued',
        };
        await this.responses.setScore(tx, s.id, q.id, { state: 'pending_judge', judge: ref });
        sent += 1;
      }
      await this.sessions.update(tx, s.id, s.lockVersion, { codingDispatchPending: false });
      return sent;
    });
  }

  /** The sweeper's pass over ended sessions that still have drafts to send. */
  async dispatchPending(limit = 50): Promise<number> {
    const due = await withSystemTx(this.db, (tx) => this.sessions.awaitingDispatch(tx, limit));
    let sent = 0;
    for (const s of due) {
      try {
        sent += await this.dispatch(s.tenantId, s.id);
      } catch (error) {
        this.logger?.warn(
          { err: error, session_id: s.id },
          'coding auto-submit failed; will retry',
        );
      }
    }
    return sent;
  }
}
