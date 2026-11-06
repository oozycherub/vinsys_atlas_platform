import { type Tx } from '@atlas/platform';
import { type Assessment, type Plan } from '../domain/assessment';
import { type Question } from '../domain/questions';
import {
  type CandidateStatus,
  type ReviewStatus,
  type SessionStatus,
  type SkillScore,
  type StoredResponse,
} from '../domain/session';

export const QUESTION_REPOSITORY = Symbol('QUESTION_REPOSITORY');
export const ASSESSMENT_REPOSITORY = Symbol('ASSESSMENT_REPOSITORY');
export const INVITE_REPOSITORY = Symbol('INVITE_REPOSITORY');
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
export const RESPONSE_REPOSITORY = Symbol('RESPONSE_REPOSITORY');
export const REVIEW_REPOSITORY = Symbol('REVIEW_REPOSITORY');
export const PROFILE_DIRECTORY = Symbol('PROFILE_DIRECTORY');
export const ASSESSMENT_LOGGER = Symbol('ASSESSMENT_LOGGER');
export const ASSESSMENT_SETTINGS = Symbol('ASSESSMENT_SETTINGS');

export interface AssessmentServiceSettings {
  /** Base URL candidates open (`{base}/{token}`); the token is shown once. */
  inviteBaseUrl: string;
  /** Candidate runtime calls per session per second. */
  sessionRateLimit: number;
  /** A session token stays valid this long after the deadline (to read the final state). */
  tokenGraceSeconds: number;
  /** Time warnings sent over SSE (seconds before the deadline). */
  warnings: number[];
  /** How often the SSE stream re-reads the session. */
  ssePollMs: number;
  erasureService: string;
}

export const DEFAULT_ASSESSMENT_SETTINGS: AssessmentServiceSettings = {
  inviteBaseUrl: 'https://assess.atlas.example/t',
  sessionRateLimit: 20,
  tokenGraceSeconds: 3600,
  warnings: [300, 60],
  ssePollMs: 1000,
  erasureService: 'assessment-svc',
};

export interface Bank {
  tenantId: string;
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  createdBy: string;
  createdAt: Date;
}

export interface QuestionStats {
  questionId: string;
  version: number;
  attempts: number;
  correct: number;
}

export interface QuestionRepository {
  insertBank(tx: Tx, bank: Bank): Promise<void>;
  bank(tx: Tx, id: string): Promise<Bank | null>;
  insert(tx: Tx, q: Question): Promise<void>;
  get(tx: Tx, id: string, version?: number): Promise<Question | null>;
  /** Latest version of each id. */
  latest(tx: Tx, ids: string[]): Promise<Map<string, Question>>;
  /** Exact versions, keyed `id@version`. */
  versions(tx: Tx, keys: { id: string; version: number }[]): Promise<Map<string, Question>>;
  /** Active latest versions in each bank. */
  bankQuestions(tx: Tx, bankIds: string[]): Promise<Map<string, Question[]>>;
  list(tx: Tx, query: { bankId?: string; limit: number }): Promise<Question[]>;
  setStatus(tx: Tx, id: string, status: 'active' | 'retired'): Promise<number>;
  stats(tx: Tx, ids: string[]): Promise<QuestionStats[]>;
  recordAttempts(
    tx: Tx,
    tenantId: string,
    results: { questionId: string; version: number; correct: boolean; score: number }[],
  ): Promise<void>;
}

export interface AssessmentRepository {
  insert(tx: Tx, a: Assessment): Promise<void>;
  get(tx: Tx, id: string, version?: number): Promise<Assessment | null>;
  list(tx: Tx, query: { limit: number; status?: string }): Promise<Assessment[]>;
  /** Compare-and-set on lock_version. */
  update(tx: Tx, a: Assessment, expectedLock: number): Promise<boolean>;
}

export interface Invite {
  tenantId: string;
  id: string;
  assessmentId: string;
  assessmentVersion: number;
  kind: 'open' | 'targeted';
  candidateId: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface InviteRepository {
  insert(tx: Tx, invite: Invite, tokenHash: Buffer): Promise<void>;
  /** System transaction: the candidate has no tenant claim. */
  byTokenHash(tx: Tx, hash: Buffer): Promise<Invite | null>;
  /** Atomically takes one use; false when exhausted. */
  use(tx: Tx, id: string): Promise<boolean>;
  list(tx: Tx, assessmentId: string): Promise<Invite[]>;
  revoke(tx: Tx, id: string, at: Date): Promise<boolean>;
}

export interface Session {
  tenantId: string;
  id: string;
  assessmentId: string;
  assessmentVersion: number;
  candidateId: string;
  attemptNo: number;
  inviteId: string | null;
  status: SessionStatus;
  plan: Plan;
  currentSection: number;
  invitedAt: Date;
  startedAt: Date | null;
  deadlineAt: Date | null;
  submittedAt: Date | null;
  evaluatedAt: Date | null;
  lastHeartbeatAt: Date | null;
  pausedAt: Date | null;
  pausedSeconds: number;
  rawScore: number | null;
  maxScore: number | null;
  percentScore: number | null;
  performanceBand: string | null;
  skillScores: SkillScore[] | null;
  trustScore: number | null;
  reviewStatus: ReviewStatus;
  candidateStatus: CandidateStatus;
  terminationReason: string | null;
  /** Coding answers wait to be auto-submitted to the judge (sweeper). */
  codingDispatchPending: boolean;
  lockVersion: number;
}

export type SessionChange = Partial<
  Pick<
    Session,
    | 'status'
    | 'currentSection'
    | 'startedAt'
    | 'deadlineAt'
    | 'submittedAt'
    | 'evaluatedAt'
    | 'lastHeartbeatAt'
    | 'pausedAt'
    | 'pausedSeconds'
    | 'rawScore'
    | 'maxScore'
    | 'performanceBand'
    | 'skillScores'
    | 'trustScore'
    | 'reviewStatus'
    | 'candidateStatus'
    | 'terminationReason'
    | 'codingDispatchPending'
  >
>;

export interface SessionFilters {
  status?: SessionStatus[];
  band?: string;
  minPercent?: number;
  candidateStatus?: CandidateStatus;
  reviewStatus?: ReviewStatus;
  limit: number;
}

export interface SessionRepository {
  insert(tx: Tx, s: Session, tokenHash: Buffer): Promise<void>;
  get(tx: Tx, id: string, options?: { forUpdate?: boolean }): Promise<Session | null>;
  /** System transaction: resolves a session from its candidate token. */
  byToken(tx: Tx, id: string, hash: Buffer): Promise<Session | null>;
  /** Compare-and-set on lock_version (bumps it); false when someone else won. */
  update(tx: Tx, id: string, expectedLock: number, change: SessionChange): Promise<Session | null>;
  list(tx: Tx, assessmentId: string, filters: SessionFilters): Promise<Session[]>;
  attempts(tx: Tx, assessmentId: string, candidateId: string): Promise<Session[]>;
  /** System transaction: live sessions whose deadline (or heartbeat) is due. */
  due(tx: Tx, now: Date, interruptionSeconds: number, limit: number): Promise<Session[]>;
  /** System transaction: ended sessions with coding answers still to send to the judge. */
  awaitingDispatch(tx: Tx, limit: number): Promise<Session[]>;
  deleteCandidate(tx: Tx, candidateId: string): Promise<number>;
}

export interface ResponseRepository {
  /**
   * Autosave with `client_rev`: accepted only as the next revision (rev = stored + 1), so a
   * stale tab or a replayed request can never overwrite a newer answer.
   */
  save(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    questionId: string,
    clientRev: number,
    answer: unknown,
    at: Date,
  ): Promise<boolean>;
  all(
    tx: Tx,
    sessionId: string,
  ): Promise<Map<string, StoredResponse & { clientRev: number; judge: JudgeRef | null }>>;
  setScore(
    tx: Tx,
    sessionId: string,
    questionId: string,
    change: {
      autoScore?: number | null;
      manualScore?: number | null;
      state: StoredResponse['state'];
      judge?: unknown;
    },
  ): Promise<void>;
  ensure(tx: Tx, tenantId: string, sessionId: string, questionId: string): Promise<void>;
}

export interface ReviewAssignment {
  sessionId: string;
  reviewerId: string;
  status: 'pending' | 'done';
  scores: Record<string, number> | null;
  comment: string | null;
  assignedBy: string;
  assignedAt: Date;
  completedAt: Date | null;
}

export interface ReviewRepository {
  assign(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    reviewerId: string,
    by: string,
  ): Promise<void>;
  list(tx: Tx, sessionId: string): Promise<ReviewAssignment[]>;
  complete(
    tx: Tx,
    sessionId: string,
    reviewerId: string,
    scores: Record<string, number>,
    comment: string | null,
    at: Date,
  ): Promise<boolean>;
}

/** profile-svc: the candidate behind an open invite link (found by email, else created). */
export interface ProfileDirectory {
  findOrCreate(
    tenantId: string,
    person: { fullName: string; email: string },
    idempotencyKey: string,
  ): Promise<string>;
}

/** What the response remembers about its judge submission (session_responses.judge). */
export interface JudgeRef {
  submission_id: string;
  /** When the candidate (or the auto-submit) sent it; the latest submission wins. */
  submitted_at: string;
  status?: string;
  verdict?: string;
  tests_passed?: number;
  tests_total?: number;
}

export const SANDBOX_GATEWAY = Symbol('SANDBOX_GATEWAY');

/** The coding part of a question, as sandbox-svc registers it (PRD §2.2, ADR-0006). */
export interface SandboxBundle {
  languages: string[];
  tests: { input: string; expected: string; hidden: boolean; weight?: number }[];
  checker?: { kind: string; tolerance?: number; language?: string; source?: string };
  limits?: Record<string, number>;
  reference_solution: { language: string; source: string };
}

export interface SandboxExecution {
  language: string;
  source: string;
  question_version: number;
  assessment_id: string;
  candidate_id: string;
  /** The session deadline; omitted for the auto-submit after the session ended. */
  active_until?: string;
  stdin?: string | null;
}

/** sandbox-svc (brick 9), called with a service token (scopes sandbox:execute, sandbox:bundles). */
export interface SandboxGateway {
  registerBundle(
    tenantId: string,
    questionId: string,
    version: number,
    bundle: SandboxBundle,
  ): Promise<{ status: string; status_detail: string | null }>;
  run(
    tenantId: string,
    sessionId: string,
    questionId: string,
    body: SandboxExecution,
  ): Promise<{ run_id: string }>;
  getRun(tenantId: string, runId: string, waitSeconds: number): Promise<Record<string, unknown>>;
  submit(
    tenantId: string,
    sessionId: string,
    questionId: string,
    body: SandboxExecution,
    idempotencyKey: string,
  ): Promise<{ submission_id: string }>;
  getSubmission(tenantId: string, submissionId: string): Promise<Record<string, unknown>>;
}

/** An internal service (sandbox-svc, proctoring-svc) refused the request; its problem document is passed on. */
export class ServiceRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly retryAfter: number | null,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ServiceRejectedError';
  }
}

export const PROCTORING_GATEWAY = Symbol('PROCTORING_GATEWAY');

/** proctoring-svc (brick 10), called with a service token (scope proctoring:sessions). */
export interface ProctoringGateway {
  start(
    tenantId: string,
    sessionId: string,
    body: {
      assessment_id: string;
      candidate_id: string;
      rules: Record<string, unknown> | null;
      consent: { biometrics: boolean; version: string; granted_at: string };
      id_verification: boolean;
    },
  ): Promise<Record<string, unknown>>;
}

export const INTERVIEW_GATEWAY = Symbol('INTERVIEW_GATEWAY');

/** interview-svc (brick 11), called with a service token (scope interviews:sessions). */
export interface InterviewGateway {
  /** Starts (or, for the same question, resumes with a new token) an AI interview. */
  start(
    tenantId: string,
    interviewId: string,
    body: {
      assessment_id: string;
      assessment_session_id: string;
      question_id: string;
      candidate_id: string;
    },
  ): Promise<{
    session_id: string;
    interview_token: string;
    mode: string;
    status: string;
    join_path: string;
  }>;
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}
