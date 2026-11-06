import { type RunnerSession } from '@atlas/contracts';
import { type Assessment } from '../domain/assessment';
import { type Question } from '../domain/questions';
import { remainingSeconds } from '../domain/session';
import { type Bank, type Invite, type QuestionStats, type Session } from './ports';

/** Minimum attempts before the difficulty index is reported (small samples mislead). */
export const MIN_ATTEMPTS_FOR_DIFFICULTY = 10;

export const toBankView = (b: Bank) => ({
  bank_id: b.id,
  name: b.name,
  description: b.description,
  skill_ids: b.skillIds,
  created_at: b.createdAt.toISOString(),
});

export interface QuestionAuthorView {
  question_id: string;
  version: number;
  bank_id: string | null;
  type: string;
  prompt: string;
  /** Includes the hidden answer key: authors only, never candidates. */
  payload: Record<string, unknown>;
  marks: number;
  negative_marks: number;
  difficulty: string;
  skill_ids: string[];
  status: string;
  stats: { attempts: number; correct: number; difficulty_index: number | null } | null;
  created_at: string;
}

export function toQuestionAuthorView(q: Question, stats: QuestionStats | null): QuestionAuthorView {
  return {
    question_id: q.id,
    version: q.version,
    bank_id: q.bankId,
    type: q.type,
    prompt: q.prompt,
    payload: q.payload,
    marks: q.marks,
    negative_marks: q.negativeMarks,
    difficulty: q.difficulty,
    skill_ids: q.skillIds,
    status: q.status,
    stats: stats
      ? {
          attempts: stats.attempts,
          correct: stats.correct,
          // Classical difficulty index p: the share of attempts answered correctly.
          difficulty_index:
            stats.attempts >= MIN_ATTEMPTS_FOR_DIFFICULTY
              ? Math.round((stats.correct / stats.attempts) * 1000) / 1000
              : null,
        }
      : null,
    created_at: q.createdAt.toISOString(),
  };
}

export interface AssessmentView {
  assessment_id: string;
  version: number;
  title: string;
  candidate_alias: string | null;
  kind: string;
  status: string;
  navigation: string;
  duration_seconds: number;
  definition: Assessment['definition'];
  settings: Assessment['settings'];
  report_config: Assessment['reportConfig'];
  job_profile_id: string | null;
  lock_version: number;
  published_at: string | null;
  created_at: string;
}

export function toAssessmentView(a: Assessment): AssessmentView {
  return {
    assessment_id: a.id,
    version: a.version,
    title: a.title,
    candidate_alias: a.candidateAlias,
    kind: a.kind,
    status: a.status,
    navigation: a.navigation,
    duration_seconds: a.durationSeconds,
    definition: a.definition,
    settings: a.settings,
    report_config: a.reportConfig,
    job_profile_id: a.jobProfileId,
    lock_version: a.lockVersion,
    published_at: a.publishedAt?.toISOString() ?? null,
    created_at: a.createdAt.toISOString(),
  };
}

export const toInviteView = (i: Invite) => ({
  invite_id: i.id,
  assessment_id: i.assessmentId,
  assessment_version: i.assessmentVersion,
  kind: i.kind,
  candidate_id: i.candidateId,
  max_uses: i.maxUses,
  uses: i.uses,
  expires_at: i.expiresAt?.toISOString() ?? null,
  revoked_at: i.revokedAt?.toISOString() ?? null,
  created_at: i.createdAt.toISOString(),
});

/** Recruiter-side result view. */
export function toSessionResultView(s: Session) {
  return {
    session_id: s.id,
    assessment_id: s.assessmentId,
    assessment_version: s.assessmentVersion,
    candidate_id: s.candidateId,
    attempt_no: s.attemptNo,
    status: s.status,
    started_at: s.startedAt?.toISOString() ?? null,
    submitted_at: s.submittedAt?.toISOString() ?? null,
    evaluated_at: s.evaluatedAt?.toISOString() ?? null,
    raw_score: s.rawScore,
    max_score: s.maxScore,
    percent_score: s.percentScore,
    performance_band: s.performanceBand,
    skill_scores: s.skillScores,
    trust_score: s.trustScore,
    review_status: s.reviewStatus,
    candidate_status: s.candidateStatus,
    termination_reason: s.terminationReason,
    lock_version: s.lockVersion,
  };
}

/** What the candidate's runner sees about its own session: no scores until released. */
export function toRunnerSession(s: Session, a: Assessment, now: Date): RunnerSession {
  return {
    session_id: s.id,
    status: s.status,
    title: a.candidateAlias ?? a.title,
    navigation: a.navigation,
    question_count: s.plan.sections.reduce((n, sec) => n + sec.items.length, 0),
    sections: s.plan.sections.map((sec, i) => ({
      index: i + 1,
      title: sec.title,
      questions: sec.items.length,
    })),
    current_section: s.currentSection,
    started_at: s.startedAt?.toISOString() ?? null,
    deadline_at: s.deadlineAt?.toISOString() ?? null,
    server_time: now.toISOString(),
    remaining_seconds: s.deadlineAt ? remainingSeconds(s, now) : null,
  };
}
