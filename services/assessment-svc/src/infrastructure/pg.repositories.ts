import { type Tx } from '@atlas/platform';
import {
  type AssessmentRepository,
  type Bank,
  type Invite,
  type JudgeRef,
  type InviteRepository,
  type QuestionRepository,
  type QuestionStats,
  type ResponseRepository,
  type ReviewAssignment,
  type ReviewRepository,
  type Session,
  type SessionChange,
  type SessionFilters,
  type SessionRepository,
} from '../application/ports';
import { type Assessment } from '../domain/assessment';
import { type Question } from '../domain/questions';
import { type StoredResponse } from '../domain/session';

type Row = Record<string, unknown>;
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const maybeDate = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));
const num = (v: unknown): number => Number(v);
const maybeNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// --- Questions -----------------------------------------------------------------------------------

const QUESTION_COLUMNS = `tenant_id::text, question_id::text, version, bank_id::text, type::text, prompt, payload,
  marks, negative_marks, difficulty::text, skill_ids::text[] AS skill_ids, status, created_by, created_at`;

function toQuestion(r: Row): Question {
  return {
    tenantId: String(r['tenant_id']),
    id: String(r['question_id']),
    version: num(r['version']),
    bankId: (r['bank_id'] as string | null) ?? null,
    type: r['type'] as Question['type'],
    prompt: String(r['prompt']),
    payload: r['payload'] as Record<string, unknown>,
    marks: num(r['marks']),
    negativeMarks: num(r['negative_marks']),
    difficulty: r['difficulty'] as Question['difficulty'],
    skillIds: (r['skill_ids'] as string[]) ?? [],
    status: r['status'] as Question['status'],
    createdBy: String(r['created_by']),
    createdAt: date(r['created_at']),
  };
}

export class PgQuestionRepository implements QuestionRepository {
  async insertBank(tx: Tx, b: Bank): Promise<void> {
    await tx.query(
      `INSERT INTO question_banks (tenant_id, bank_id, name, description, skill_ids, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7)`,
      [b.tenantId, b.id, b.name, b.description, b.skillIds, b.createdBy, b.createdAt],
    );
  }

  async bank(tx: Tx, id: string): Promise<Bank | null> {
    const { rows } = await tx.query<Row>(
      `SELECT tenant_id::text, bank_id::text, name, description, skill_ids::text[] AS skill_ids, created_by, created_at
       FROM question_banks WHERE bank_id = $1`,
      [id],
    );
    const r = rows[0];
    return r
      ? {
          tenantId: String(r['tenant_id']),
          id: String(r['bank_id']),
          name: String(r['name']),
          description: String(r['description']),
          skillIds: r['skill_ids'] as string[],
          createdBy: String(r['created_by']),
          createdAt: date(r['created_at']),
        }
      : null;
  }

  async insert(tx: Tx, q: Question): Promise<void> {
    await tx.query(
      `INSERT INTO questions (tenant_id, question_id, version, bank_id, type, prompt, payload, marks, negative_marks,
         difficulty, skill_ids, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid[], $12, $13, $14)`,
      [
        q.tenantId,
        q.id,
        q.version,
        q.bankId,
        q.type,
        q.prompt,
        JSON.stringify(q.payload),
        q.marks,
        q.negativeMarks,
        q.difficulty,
        q.skillIds,
        q.status,
        q.createdBy,
        q.createdAt,
      ],
    );
  }

  async get(tx: Tx, id: string, version?: number): Promise<Question | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${QUESTION_COLUMNS} FROM questions WHERE question_id = $1 AND ($2::int IS NULL OR version = $2)
       ORDER BY version DESC LIMIT 1`,
      [id, version ?? null],
    );
    return rows[0] ? toQuestion(rows[0]) : null;
  }

  async latest(tx: Tx, ids: string[]): Promise<Map<string, Question>> {
    if (ids.length === 0) return new Map();
    const { rows } = await tx.query<Row>(
      `SELECT DISTINCT ON (question_id) ${QUESTION_COLUMNS} FROM questions
       WHERE question_id = ANY($1::uuid[]) ORDER BY question_id, version DESC`,
      [ids],
    );
    return new Map(rows.map((r) => [String(r['question_id']), toQuestion(r)]));
  }

  async versions(tx: Tx, keys: { id: string; version: number }[]): Promise<Map<string, Question>> {
    if (keys.length === 0) return new Map();
    const { rows } = await tx.query<Row>(
      `SELECT ${QUESTION_COLUMNS} FROM questions q
       JOIN unnest($1::uuid[], $2::int[]) AS k(id, v) ON q.question_id = k.id AND q.version = k.v`,
      [keys.map((k) => k.id), keys.map((k) => k.version)],
    );
    return new Map(
      rows.map((r) => [`${String(r['question_id'])}@${num(r['version'])}`, toQuestion(r)]),
    );
  }

  async bankQuestions(tx: Tx, bankIds: string[]): Promise<Map<string, Question[]>> {
    const out = new Map<string, Question[]>(bankIds.map((b) => [b, []]));
    if (bankIds.length === 0) return out;
    const { rows } = await tx.query<Row>(
      `SELECT * FROM (
         SELECT DISTINCT ON (question_id) ${QUESTION_COLUMNS} FROM questions
         WHERE bank_id = ANY($1::uuid[]) ORDER BY question_id, version DESC) latest
       WHERE status = 'active' ORDER BY question_id`,
      [bankIds],
    );
    for (const r of rows) out.get(String(r['bank_id']))?.push(toQuestion(r));
    return out;
  }

  async list(tx: Tx, query: { bankId?: string; limit: number }): Promise<Question[]> {
    const { rows } = await tx.query<Row>(
      `SELECT * FROM (SELECT DISTINCT ON (question_id) ${QUESTION_COLUMNS} FROM questions
         WHERE ($1::uuid IS NULL OR bank_id = $1) ORDER BY question_id, version DESC) latest
       ORDER BY created_at DESC LIMIT $2`,
      [query.bankId ?? null, query.limit],
    );
    return rows.map(toQuestion);
  }

  async setStatus(tx: Tx, id: string, status: 'active' | 'retired'): Promise<number> {
    return (await tx.query('UPDATE questions SET status = $2 WHERE question_id = $1', [id, status]))
      .rowCount;
  }

  async stats(tx: Tx, ids: string[]): Promise<QuestionStats[]> {
    if (ids.length === 0) return [];
    const { rows } = await tx.query<Row>(
      `SELECT question_id::text, version, attempts, correct FROM question_stats WHERE question_id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.map((r) => ({
      questionId: String(r['question_id']),
      version: num(r['version']),
      attempts: num(r['attempts']),
      correct: num(r['correct']),
    }));
  }

  async recordAttempts(
    tx: Tx,
    tenantId: string,
    results: { questionId: string; version: number; correct: boolean; score: number }[],
  ): Promise<void> {
    for (const r of results) {
      await tx.query(
        `INSERT INTO question_stats (tenant_id, question_id, version, attempts, correct, score_sum)
         VALUES ($1, $2, $3, 1, $4, $5)
         ON CONFLICT (tenant_id, question_id, version) DO UPDATE SET attempts = question_stats.attempts + 1,
           correct = question_stats.correct + EXCLUDED.correct, score_sum = question_stats.score_sum + EXCLUDED.score_sum`,
        [tenantId, r.questionId, r.version, r.correct ? 1 : 0, r.score],
      );
    }
  }
}

// --- Assessments -------------------------------------------------------------------------------

const ASSESSMENT_COLUMNS = `tenant_id::text, assessment_id::text, version, title, candidate_alias, kind::text, status::text,
  navigation::text, duration_seconds, definition, settings, report_config, job_profile_id::text, lock_version,
  created_by, published_at, created_at, updated_at`;

function toAssessment(r: Row): Assessment {
  return {
    tenantId: String(r['tenant_id']),
    id: String(r['assessment_id']),
    version: num(r['version']),
    title: String(r['title']),
    candidateAlias: (r['candidate_alias'] as string | null) ?? null,
    kind: r['kind'] as Assessment['kind'],
    status: r['status'] as Assessment['status'],
    navigation: r['navigation'] as Assessment['navigation'],
    durationSeconds: num(r['duration_seconds']),
    definition: r['definition'] as Assessment['definition'],
    settings: r['settings'] as Assessment['settings'],
    reportConfig: r['report_config'] as Assessment['reportConfig'],
    jobProfileId: (r['job_profile_id'] as string | null) ?? null,
    lockVersion: num(r['lock_version']),
    createdBy: String(r['created_by']),
    publishedAt: maybeDate(r['published_at']),
    createdAt: date(r['created_at']),
    updatedAt: date(r['updated_at']),
  };
}

export class PgAssessmentRepository implements AssessmentRepository {
  async insert(tx: Tx, a: Assessment): Promise<void> {
    await tx.query(
      `INSERT INTO assessments (tenant_id, assessment_id, version, title, candidate_alias, kind, status, navigation,
         duration_seconds, definition, settings, report_config, job_profile_id, lock_version, created_by, published_at,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
      [
        a.tenantId,
        a.id,
        a.version,
        a.title,
        a.candidateAlias,
        a.kind,
        a.status,
        a.navigation,
        a.durationSeconds,
        JSON.stringify(a.definition),
        JSON.stringify(a.settings),
        JSON.stringify(a.reportConfig),
        a.jobProfileId,
        a.lockVersion,
        a.createdBy,
        a.publishedAt,
        a.createdAt,
      ],
    );
  }

  async get(tx: Tx, id: string, version?: number): Promise<Assessment | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${ASSESSMENT_COLUMNS} FROM assessments WHERE assessment_id = $1 AND ($2::int IS NULL OR version = $2)
       ORDER BY version DESC LIMIT 1`,
      [id, version ?? null],
    );
    return rows[0] ? toAssessment(rows[0]) : null;
  }

  async list(tx: Tx, query: { limit: number; status?: string }): Promise<Assessment[]> {
    const { rows } = await tx.query<Row>(
      `SELECT * FROM (SELECT DISTINCT ON (assessment_id) ${ASSESSMENT_COLUMNS} FROM assessments
         ORDER BY assessment_id, version DESC) latest
       WHERE ($1::text IS NULL OR status::text = $1) ORDER BY updated_at DESC LIMIT $2`,
      [query.status ?? null, query.limit],
    );
    return rows.map(toAssessment);
  }

  async update(tx: Tx, a: Assessment, expectedLock: number): Promise<boolean> {
    const result = await tx.query(
      `UPDATE assessments SET title = $4, candidate_alias = $5, status = $6, navigation = $7, duration_seconds = $8,
         definition = $9, settings = $10, report_config = $11, job_profile_id = $12, published_at = $13,
         lock_version = lock_version + 1
       WHERE assessment_id = $1 AND version = $2 AND lock_version = $3`,
      [
        a.id,
        a.version,
        expectedLock,
        a.title,
        a.candidateAlias,
        a.status,
        a.navigation,
        a.durationSeconds,
        JSON.stringify(a.definition),
        JSON.stringify(a.settings),
        JSON.stringify(a.reportConfig),
        a.jobProfileId,
        a.publishedAt,
      ],
    );
    return result.rowCount === 1;
  }
}

// --- Invites -------------------------------------------------------------------------------------

const INVITE_COLUMNS = `tenant_id::text, invite_id::text, assessment_id::text, assessment_version, kind, candidate_id::text,
  max_uses, uses, expires_at, revoked_at, created_by, created_at`;

function toInvite(r: Row): Invite {
  return {
    tenantId: String(r['tenant_id']),
    id: String(r['invite_id']),
    assessmentId: String(r['assessment_id']),
    assessmentVersion: num(r['assessment_version']),
    kind: r['kind'] as Invite['kind'],
    candidateId: (r['candidate_id'] as string | null) ?? null,
    maxUses: maybeNum(r['max_uses']),
    uses: num(r['uses']),
    expiresAt: maybeDate(r['expires_at']),
    revokedAt: maybeDate(r['revoked_at']),
    createdBy: String(r['created_by']),
    createdAt: date(r['created_at']),
  };
}

export class PgInviteRepository implements InviteRepository {
  async insert(tx: Tx, i: Invite, tokenHash: Buffer): Promise<void> {
    await tx.query(
      `INSERT INTO assessment_invites (tenant_id, invite_id, assessment_id, assessment_version, kind, token_hash,
         candidate_id, max_uses, uses, expires_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11)`,
      [
        i.tenantId,
        i.id,
        i.assessmentId,
        i.assessmentVersion,
        i.kind,
        tokenHash,
        i.candidateId,
        i.maxUses,
        i.expiresAt,
        i.createdBy,
        i.createdAt,
      ],
    );
  }

  async byTokenHash(tx: Tx, hash: Buffer): Promise<Invite | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${INVITE_COLUMNS} FROM assessment_invites WHERE token_hash = $1`,
      [hash],
    );
    return rows[0] ? toInvite(rows[0]) : null;
  }

  async use(tx: Tx, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE assessment_invites SET uses = uses + 1
       WHERE invite_id = $1 AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses)`,
      [id],
    );
    return result.rowCount === 1;
  }

  async list(tx: Tx, assessmentId: string): Promise<Invite[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${INVITE_COLUMNS} FROM assessment_invites WHERE assessment_id = $1 ORDER BY created_at DESC`,
      [assessmentId],
    );
    return rows.map(toInvite);
  }

  async revoke(tx: Tx, id: string, at: Date): Promise<boolean> {
    const r = await tx.query(
      'UPDATE assessment_invites SET revoked_at = $2 WHERE invite_id = $1 AND revoked_at IS NULL',
      [id, at],
    );
    return r.rowCount === 1;
  }
}

// --- Sessions ------------------------------------------------------------------------------------

const SESSION_COLUMNS = `tenant_id::text, session_id::text, assessment_id::text, assessment_version, candidate_id::text,
  attempt_no, invite_id::text, status::text, plan, current_section, invited_at, started_at, deadline_at, submitted_at,
  evaluated_at, last_heartbeat_at, paused_at, paused_seconds, raw_score, max_score, percent_score, performance_band,
  skill_scores, trust_score, review_status::text, candidate_status::text, termination_reason, coding_dispatch_pending, lock_version`;

function toSession(r: Row): Session {
  return {
    tenantId: String(r['tenant_id']),
    id: String(r['session_id']),
    assessmentId: String(r['assessment_id']),
    assessmentVersion: num(r['assessment_version']),
    candidateId: String(r['candidate_id']),
    attemptNo: num(r['attempt_no']),
    inviteId: (r['invite_id'] as string | null) ?? null,
    status: r['status'] as Session['status'],
    plan: r['plan'] as Session['plan'],
    currentSection: num(r['current_section']),
    invitedAt: date(r['invited_at']),
    startedAt: maybeDate(r['started_at']),
    deadlineAt: maybeDate(r['deadline_at']),
    submittedAt: maybeDate(r['submitted_at']),
    evaluatedAt: maybeDate(r['evaluated_at']),
    lastHeartbeatAt: maybeDate(r['last_heartbeat_at']),
    pausedAt: maybeDate(r['paused_at']),
    pausedSeconds: num(r['paused_seconds']),
    rawScore: maybeNum(r['raw_score']),
    maxScore: maybeNum(r['max_score']),
    percentScore: maybeNum(r['percent_score']),
    performanceBand: (r['performance_band'] as string | null) ?? null,
    skillScores: (r['skill_scores'] as Session['skillScores']) ?? null,
    trustScore: maybeNum(r['trust_score']),
    reviewStatus: r['review_status'] as Session['reviewStatus'],
    candidateStatus: r['candidate_status'] as Session['candidateStatus'],
    terminationReason: (r['termination_reason'] as string | null) ?? null,
    codingDispatchPending: r['coding_dispatch_pending'] === true,
    lockVersion: num(r['lock_version']),
  };
}

const CHANGE_COLUMNS: Record<keyof SessionChange, string> = {
  status: 'status',
  currentSection: 'current_section',
  startedAt: 'started_at',
  deadlineAt: 'deadline_at',
  submittedAt: 'submitted_at',
  evaluatedAt: 'evaluated_at',
  lastHeartbeatAt: 'last_heartbeat_at',
  pausedAt: 'paused_at',
  pausedSeconds: 'paused_seconds',
  rawScore: 'raw_score',
  maxScore: 'max_score',
  performanceBand: 'performance_band',
  skillScores: 'skill_scores',
  trustScore: 'trust_score',
  reviewStatus: 'review_status',
  candidateStatus: 'candidate_status',
  terminationReason: 'termination_reason',
  codingDispatchPending: 'coding_dispatch_pending',
};

export class PgSessionRepository implements SessionRepository {
  async insert(tx: Tx, s: Session, tokenHash: Buffer): Promise<void> {
    await tx.query(
      `INSERT INTO assessment_sessions (tenant_id, session_id, assessment_id, assessment_version, candidate_id,
         attempt_no, invite_id, access_token_hash, status, plan, invited_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        s.tenantId,
        s.id,
        s.assessmentId,
        s.assessmentVersion,
        s.candidateId,
        s.attemptNo,
        s.inviteId,
        tokenHash,
        s.status,
        JSON.stringify(s.plan),
        s.invitedAt,
      ],
    );
  }

  async get(tx: Tx, id: string, options: { forUpdate?: boolean } = {}): Promise<Session | null> {
    const { rows } = await tx.query<Row>(
      `SELECT ${SESSION_COLUMNS} FROM assessment_sessions WHERE session_id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async byToken(tx: Tx, id: string, hash: Buffer): Promise<Session | null> {
    // Constant-time in effect: the comparison happens inside the index lookup, not in JS.
    const { rows } = await tx.query<Row>(
      `SELECT ${SESSION_COLUMNS} FROM assessment_sessions WHERE session_id = $1 AND access_token_hash = $2`,
      [id, hash],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async update(
    tx: Tx,
    id: string,
    expectedLock: number,
    change: SessionChange,
  ): Promise<Session | null> {
    const keys = Object.keys(change) as (keyof SessionChange)[];
    const sets = keys.map(
      (k, i) => `${CHANGE_COLUMNS[k]} = $${i + 3}${k === 'skillScores' ? '::jsonb' : ''}`,
    );
    const values = keys.map((k) => (k === 'skillScores' ? JSON.stringify(change[k]) : change[k]));
    const { rows } = await tx.query<Row>(
      `UPDATE assessment_sessions SET ${[...sets, 'lock_version = lock_version + 1'].join(', ')}
       WHERE session_id = $1 AND lock_version = $2 RETURNING ${SESSION_COLUMNS}`,
      [id, expectedLock, ...values],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async list(tx: Tx, assessmentId: string, f: SessionFilters): Promise<Session[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${SESSION_COLUMNS} FROM assessment_sessions
       WHERE assessment_id = $1
         AND ($2::text[] IS NULL OR status::text = ANY($2))
         AND ($3::text IS NULL OR performance_band = $3)
         AND ($4::numeric IS NULL OR percent_score >= $4)
         AND ($5::text IS NULL OR candidate_status::text = $5)
         AND ($6::text IS NULL OR review_status::text = $6)
       ORDER BY percent_score DESC NULLS LAST, invited_at DESC LIMIT $7`,
      [
        assessmentId,
        f.status ?? null,
        f.band ?? null,
        f.minPercent ?? null,
        f.candidateStatus ?? null,
        f.reviewStatus ?? null,
        f.limit,
      ],
    );
    return rows.map(toSession);
  }

  async attempts(tx: Tx, assessmentId: string, candidateId: string): Promise<Session[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${SESSION_COLUMNS} FROM assessment_sessions WHERE assessment_id = $1 AND candidate_id = $2 ORDER BY attempt_no`,
      [assessmentId, candidateId],
    );
    return rows.map(toSession);
  }

  async due(tx: Tx, now: Date, interruptionSeconds: number, limit: number): Promise<Session[]> {
    // Deadline-due sessions (paused ones get their allowance checked in the domain), and live
    // sessions whose heartbeat stopped (interruptions to pause).
    const { rows } = await tx.query<Row>(
      `SELECT ${SESSION_COLUMNS} FROM assessment_sessions
       WHERE status IN ('started', 'in_progress', 'paused')
         AND (deadline_at <= $1
              OR (status <> 'paused' AND COALESCE(last_heartbeat_at, started_at) <= $1 - make_interval(secs => $2)))
       ORDER BY deadline_at LIMIT $3`,
      [now, interruptionSeconds, limit],
    );
    return rows.map(toSession);
  }

  async awaitingDispatch(tx: Tx, limit: number): Promise<Session[]> {
    const { rows } = await tx.query<Row>(
      `SELECT ${SESSION_COLUMNS} FROM assessment_sessions
       WHERE coding_dispatch_pending ORDER BY submitted_at NULLS FIRST LIMIT $1`,
      [limit],
    );
    return rows.map(toSession);
  }

  async deleteCandidate(tx: Tx, candidateId: string): Promise<number> {
    return (
      await tx.query('DELETE FROM assessment_sessions WHERE candidate_id = $1', [candidateId])
    ).rowCount;
  }
}

// --- Responses and reviews -------------------------------------------------------------------------

export class PgResponseRepository implements ResponseRepository {
  async save(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    questionId: string,
    clientRev: number,
    answer: unknown,
    at: Date,
  ): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO session_responses (tenant_id, session_id, question_id, answer, client_rev, saved_at, state)
       SELECT $1, $2, $3, $4, $5, $6, 'saved' WHERE $5 = 1
       ON CONFLICT (tenant_id, session_id, question_id) DO UPDATE
         SET answer = EXCLUDED.answer, client_rev = EXCLUDED.client_rev, saved_at = EXCLUDED.saved_at
         WHERE session_responses.client_rev = EXCLUDED.client_rev - 1`,
      [tenantId, sessionId, questionId, JSON.stringify(answer), clientRev, at],
    );
    if (rowCount === 1) return true;
    if (clientRev === 1) return false;
    const updated = await tx.query(
      `UPDATE session_responses SET answer = $3, client_rev = $4, saved_at = $5
       WHERE session_id = $1 AND question_id = $2 AND client_rev = $4 - 1`,
      [sessionId, questionId, JSON.stringify(answer), clientRev, at],
    );
    return updated.rowCount === 1;
  }

  async all(
    tx: Tx,
    sessionId: string,
  ): Promise<Map<string, StoredResponse & { clientRev: number; judge: JudgeRef | null }>> {
    const { rows } = await tx.query<Row>(
      `SELECT question_id::text, answer, client_rev, auto_score, manual_score, state, judge FROM session_responses WHERE session_id = $1`,
      [sessionId],
    );
    return new Map(
      rows.map((r) => [
        String(r['question_id']),
        {
          questionId: String(r['question_id']),
          answer: r['answer'] ?? null,
          clientRev: num(r['client_rev']),
          autoScore: maybeNum(r['auto_score']),
          manualScore: maybeNum(r['manual_score']),
          state: r['state'] as StoredResponse['state'],
          judge: (r['judge'] as JudgeRef | null) ?? null,
        },
      ]),
    );
  }

  async setScore(
    tx: Tx,
    sessionId: string,
    questionId: string,
    change: {
      autoScore?: number | null;
      manualScore?: number | null;
      state: StoredResponse['state'];
      judge?: unknown;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE session_responses SET state = $3,
         auto_score = CASE WHEN $4::boolean THEN $5::numeric ELSE auto_score END,
         manual_score = CASE WHEN $6::boolean THEN $7::numeric ELSE manual_score END,
         judge = COALESCE($8::jsonb, judge)
       WHERE session_id = $1 AND question_id = $2`,
      [
        sessionId,
        questionId,
        change.state,
        'autoScore' in change,
        change.autoScore ?? null,
        'manualScore' in change,
        change.manualScore ?? null,
        change.judge === undefined ? null : JSON.stringify(change.judge),
      ],
    );
  }

  async ensure(tx: Tx, tenantId: string, sessionId: string, questionId: string): Promise<void> {
    await tx.query(
      `INSERT INTO session_responses (tenant_id, session_id, question_id, answer, client_rev, state)
       VALUES ($1, $2, $3, NULL, 0, 'saved') ON CONFLICT DO NOTHING`,
      [tenantId, sessionId, questionId],
    );
  }
}

export class PgReviewRepository implements ReviewRepository {
  async assign(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    reviewerId: string,
    by: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO review_assignments (tenant_id, session_id, reviewer_id, assigned_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, sessionId, reviewerId, by],
    );
  }

  async list(tx: Tx, sessionId: string): Promise<ReviewAssignment[]> {
    const { rows } = await tx.query<Row>(
      `SELECT session_id::text, reviewer_id, status, scores, comment, assigned_by, assigned_at, completed_at
       FROM review_assignments WHERE session_id = $1 ORDER BY assigned_at, reviewer_id`,
      [sessionId],
    );
    return rows.map((r) => ({
      sessionId: String(r['session_id']),
      reviewerId: String(r['reviewer_id']),
      status: r['status'] as ReviewAssignment['status'],
      scores: (r['scores'] as Record<string, number> | null) ?? null,
      comment: (r['comment'] as string | null) ?? null,
      assignedBy: String(r['assigned_by']),
      assignedAt: date(r['assigned_at']),
      completedAt: maybeDate(r['completed_at']),
    }));
  }

  async complete(
    tx: Tx,
    sessionId: string,
    reviewerId: string,
    scores: Record<string, number>,
    comment: string | null,
    at: Date,
  ): Promise<boolean> {
    const r = await tx.query(
      `UPDATE review_assignments SET status = 'done', scores = $3, comment = $4, completed_at = $5
       WHERE session_id = $1 AND reviewer_id = $2 AND status = 'pending'`,
      [sessionId, reviewerId, JSON.stringify(scores), comment, at],
    );
    return r.rowCount === 1;
  }
}
