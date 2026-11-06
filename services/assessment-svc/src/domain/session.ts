/**
 * Sessions: the state machine, the server-authoritative timer with its pause rule, and
 * evaluation into a score, a band and per-skill proficiency.
 */
import { type Plan, planItems } from './assessment';
import { autoScore, type Question, round2 } from './questions';

export type SessionStatus =
  | 'invited'
  | 'started'
  | 'in_progress'
  | 'paused'
  | 'submitted'
  | 'terminated'
  | 'expired'
  | 'evaluated'
  | 'cancelled';

export type ReviewStatus =
  'not_required' | 'pending_review' | 'in_review' | 'cleared' | 'confirmed_violation';
export type CandidateStatus = 'pending' | 'shortlisted' | 'on_hold' | 'rejected';

/** invited → started → in_progress ⇄ paused → submitted | terminated | expired → evaluated. */
const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  invited: ['started', 'cancelled', 'terminated'],
  started: ['in_progress', 'paused', 'submitted', 'terminated', 'expired'],
  in_progress: ['paused', 'submitted', 'terminated', 'expired'],
  paused: ['in_progress', 'submitted', 'terminated', 'expired'],
  submitted: ['evaluated'],
  terminated: ['evaluated'],
  expired: ['evaluated'],
  evaluated: [],
  cancelled: [],
};

export const LIVE: readonly SessionStatus[] = ['started', 'in_progress', 'paused'];
export const ENDED: readonly SessionStatus[] = ['submitted', 'terminated', 'expired', 'evaluated'];

/** No heartbeat or request for this long means the candidate was interrupted (paused). */
export const INTERRUPTION_SECONDS = 30;

export class SessionRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: 'conflict' | 'rule' = 'conflict',
  ) {
    super(message);
    this.name = 'SessionRuleError';
  }
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw new SessionRuleError('INVALID_SESSION_STATE', `A ${from} session cannot become ${to}.`);
  }
}

export interface Timer {
  status: SessionStatus;
  deadlineAt: Date | null;
  pausedAt: Date | null;
  pausedSeconds: number;
}

/** Seconds of pause credit still available. */
export function allowanceLeft(t: Timer, allowanceSeconds: number): number {
  return Math.max(0, allowanceSeconds - t.pausedSeconds);
}

/**
 * The moment the session ends. While paused the clock is frozen, but only for as long as the
 * remaining pause allowance: an abandoned session still ends.
 */
export function effectiveDeadline(t: Timer, allowanceSeconds: number): Date | null {
  if (!t.deadlineAt) return null;
  if (t.status === 'paused')
    return new Date(t.deadlineAt.getTime() + allowanceLeft(t, allowanceSeconds) * 1000);
  return t.deadlineAt;
}

export function remainingSeconds(t: Timer, now: Date): number {
  if (!t.deadlineAt) return 0;
  if (t.status === 'paused' && t.pausedAt) {
    return Math.max(0, Math.floor((t.deadlineAt.getTime() - t.pausedAt.getTime()) / 1000));
  }
  return Math.max(0, Math.floor((t.deadlineAt.getTime() - now.getTime()) / 1000));
}

export function isExpired(t: Timer, now: Date, allowanceSeconds: number): boolean {
  const end = effectiveDeadline(t, allowanceSeconds);
  return end !== null && now.getTime() >= end.getTime();
}

/** Resuming credits the interruption back to the deadline, up to the remaining allowance. */
export function resume(
  t: Timer,
  now: Date,
  allowanceSeconds: number,
): { deadlineAt: Date; credited: number } {
  if (!t.deadlineAt || !t.pausedAt)
    throw new SessionRuleError('NOT_PAUSED', 'The session is not paused.');
  const pausedFor = Math.max(0, Math.floor((now.getTime() - t.pausedAt.getTime()) / 1000));
  const credited = Math.min(pausedFor, allowanceLeft(t, allowanceSeconds));
  return { deadlineAt: new Date(t.deadlineAt.getTime() + credited * 1000), credited };
}

// --- Evaluation ---------------------------------------------------------------------------------

export interface StoredResponse {
  questionId: string;
  answer: unknown;
  autoScore: number | null;
  manualScore: number | null;
  state: 'saved' | 'scored' | 'pending_review' | 'pending_judge' | 'reviewed';
  /** The judge submission on record (coding questions). */
  judge?: unknown;
}

/**
 * The answer to score. A coding question submitted to the judge counts as answered even when no
 * draft was autosaved: the submission is the answer.
 */
export function effectiveAnswer(
  q: Question,
  r: Pick<StoredResponse, 'answer' | 'judge'> | undefined,
): unknown {
  const answer = r?.answer ?? null;
  if (answer === null && q.type === 'coding' && r?.judge) return r.judge;
  return answer;
}

export interface QuestionResult {
  question_id: string;
  marks: number;
  score: number | null;
  correct: boolean | null;
  pending: 'review' | 'judge' | null;
}

export interface SkillScore {
  skill_id: string;
  /** 0–5 (the contract's `score`). */
  score: number;
  confidence: number;
  items: number;
}

export interface Evaluation {
  raw: number;
  max: number;
  percent: number;
  pending: boolean;
  needsReview: boolean;
  questions: QuestionResult[];
  skills: SkillScore[];
}

/** Score of a response before evaluation: deterministic, or held for a reviewer / the judge. */
export function initialScore(q: Question, marks: number, answer: unknown) {
  return autoScore(q, marks, answer);
}

/**
 * Totals and per-skill proficiency. A question's final score: reviewers' consensus (manual), else
 * the judge or interview result, else deterministic scoring. While anything is still waiting on a
 * reviewer or the judge, the evaluation is `pending` and nothing is released.
 *
 * Skill proficiency = 5 · earned / available over the questions mapped to the skill;
 * confidence = min(0.9, 0.4 + 0.1 · items) (≥ 2 items reach the 0.6 "validated" bar).
 */
/**
 * A person scores this answer: descriptive answers, coding answers the judge could not score
 * (internal_error after its retries: never charged to the candidate, PRD §2.2d), and AI
 * interviews interview-svc sent to review (insufficient evidence, flags, approval required).
 */
export function isReviewable(
  q: Question,
  marks: number,
  r: Pick<StoredResponse, 'answer' | 'state' | 'judge'> | undefined,
): boolean {
  if (autoScore(q, marks, effectiveAnswer(q, r)).needs === 'review') return true;
  // Still reviewable once reviewed, so the evaluation clears the session's review.
  return (
    (q.type === 'coding' || q.type === 'ai_interview') &&
    (r?.state === 'pending_review' || r?.state === 'reviewed')
  );
}

export function evaluate(
  plan: Plan,
  questions: ReadonlyMap<string, Question>,
  responses: ReadonlyMap<string, StoredResponse>,
): Evaluation {
  let raw = 0;
  let max = 0;
  let pending = false;
  let needsReview = false;
  const results: QuestionResult[] = [];
  const perSkill = new Map<string, { earned: number; available: number; items: number }>();
  for (const { item } of planItems(plan)) {
    const q = questions.get(`${item.question_id}@${item.version}`);
    if (!q)
      throw new SessionRuleError(
        'QUESTION_NOT_FOUND',
        `Question ${item.question_id} is missing.`,
        'rule',
      );
    const r = responses.get(item.question_id);
    const fresh = autoScore(q, item.marks, effectiveAnswer(q, r));
    let score: number | null;
    let waiting: 'review' | 'judge' | null = null;
    const reviewable = isReviewable(q, item.marks, r);
    if (r?.manualScore !== null && r?.manualScore !== undefined) score = r.manualScore;
    else if (fresh.needs === 'judge') score = r?.autoScore ?? null;
    else if (fresh.needs === 'review') score = null;
    else score = fresh.score;
    if (score === null) {
      waiting = reviewable ? 'review' : (fresh.needs ?? 'review');
      pending = true;
    }
    if (reviewable) needsReview = true;
    const bounded = score === null ? 0 : Math.max(-item.marks, Math.min(item.marks, score));
    raw += bounded;
    max += item.marks;
    results.push({
      question_id: q.id,
      marks: item.marks,
      score: score === null ? null : round2(bounded),
      correct: fresh.correct ?? (score === null ? null : bounded >= item.marks),
      pending: waiting,
    });
    for (const skill of q.skillIds) {
      const s = perSkill.get(skill) ?? { earned: 0, available: 0, items: 0 };
      s.earned += Math.max(0, bounded);
      s.available += item.marks;
      s.items += 1;
      perSkill.set(skill, s);
    }
  }
  const total = round2(Math.max(0, raw));
  return {
    raw: total,
    max: round2(max),
    percent: max > 0 ? round2((total * 100) / max) : 0,
    pending,
    needsReview,
    questions: results,
    skills: [...perSkill.entries()]
      .map(([skill_id, s]) => ({
        skill_id,
        score: s.available > 0 ? round2((5 * s.earned) / s.available) : 0,
        confidence: round2(Math.min(0.9, 0.4 + 0.1 * s.items)),
        items: s.items,
      }))
      .sort((a, b) => (a.skill_id < b.skill_id ? -1 : 1)),
  };
}

/** Reviewers' consensus for one question: the mean of their marks. */
export function consensus(marks: number[]): number | null {
  return marks.length === 0 ? null : round2(marks.reduce((a, b) => a + b, 0) / marks.length);
}
