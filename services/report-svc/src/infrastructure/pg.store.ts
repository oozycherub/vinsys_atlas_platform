import { Injectable } from '@nestjs/common';
import { type Tx } from '@atlas/platform';
import {
  type JobRow,
  type ArtifactRow,
  type Claimed,
  type FactPatch,
  type ReportStore,
} from '../application/store';
import { type InterviewSummary, type SessionFacts, type SkillScore } from '../domain/facts';

/** SQL for report-svc (ADR-0004). Every method runs in the caller's transaction. */

type Row = Record<string, unknown>;
const d = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string);

const toJob = (r: Row): JobRow => ({
  reportId: r['report_id'] as string,
  type: r['type'] as string,
  params: r['params'] as Record<string, unknown>,
  subjectId: (r['subject_id'] as string | null) ?? null,
  requestedBy: r['requested_by'] as string,
  status: r['status'] as string,
  attempts: r['attempts'] as number,
  error: (r['error'] as string | null) ?? null,
  artifactId: (r['artifact_id'] as string | null) ?? null,
  createdAt: d(r['created_at']) as Date,
  finishedAt: d(r['finished_at']),
});

const toArtifact = (r: Row): ArtifactRow => ({
  artifactId: r['artifact_id'] as string,
  reportId: r['report_id'] as string,
  storageKey: r['storage_key'] as string,
  contentType: r['content_type'] as string,
  fileName: r['file_name'] as string,
  sizeBytes: Number(r['size_bytes']),
  sha256: r['sha256'] as string,
  subjectId: (r['subject_id'] as string | null) ?? null,
  createdAt: d(r['created_at']) as Date,
  expiresAt: d(r['expires_at']) as Date,
});

export const toFacts = (r: Row): SessionFacts => ({
  sessionId: r['session_id'] as string,
  assessmentId: (r['assessment_id'] as string | null) ?? null,
  assessmentVersion: (r['assessment_version'] as number | null) ?? null,
  candidateId: (r['candidate_id'] as string | null) ?? null,
  attemptNo: (r['attempt_no'] as number | null) ?? null,
  startedAt: d(r['started_at']),
  deadlineAt: d(r['deadline_at']),
  submittedAt: d(r['submitted_at']),
  outcome: (r['outcome'] as string | null) ?? null,
  terminatedReason: (r['terminated_reason'] as string | null) ?? null,
  skills: (r['skills'] as SkillScore[] | null) ?? null,
  evaluatedAt: d(r['evaluated_at']),
  trustScore: (r['trust_score'] as number | null) ?? null,
  trustBand: (r['trust_band'] as string | null) ?? null,
  trustBreakdown: (r['trust_breakdown'] as Record<string, number> | null) ?? null,
  trustReview: (r['trust_review'] as boolean | null) ?? null,
  interview: (r['interview'] as InterviewSummary | null) ?? null,
});

const JSON_COLUMNS = new Set(['skills', 'trust_breakdown', 'interview']);

@Injectable()
export class PgReportStore implements ReportStore {
  // --- Settings -----------------------------------------------------------------------------

  async sections(tx: Tx): Promise<Record<string, boolean> | null> {
    const r = await tx.query(`SELECT sections FROM report_settings`);
    return (r.rows[0]?.['sections'] as Record<string, boolean> | undefined) ?? null;
  }

  async saveSections(
    tx: Tx,
    tenantId: string,
    sections: Record<string, boolean>,
    by: string,
    now: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO report_settings (tenant_id, sections, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET sections = $2::jsonb, updated_by = $3, updated_at = $4`,
      [tenantId, JSON.stringify(sections), by, now],
    );
  }

  // --- Facts --------------------------------------------------------------------------------

  async upsertFacts(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    patch: FactPatch,
    now: Date,
  ): Promise<void> {
    const cols = Object.keys(patch) as (keyof FactPatch)[];
    const values = cols.map((c) => (JSON_COLUMNS.has(c) ? JSON.stringify(patch[c]) : patch[c]));
    const insertCols = ['tenant_id', 'session_id', ...cols, 'updated_at'];
    const placeholders = insertCols.map(
      (c, i) => `$${i + 1}${JSON_COLUMNS.has(c) ? '::jsonb' : ''}`,
    );
    const updates = [...cols, 'updated_at'].map((c) => `${c} = EXCLUDED.${c}`);
    await tx.query(
      `INSERT INTO report_session_facts (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET ${updates.join(', ')}`,
      [tenantId, sessionId, ...values, now],
    );
  }

  /** Keeps only the newest revision (events can arrive out of order). */
  async upsertTrust(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    t: {
      assessmentId: string;
      score: number;
      band: string;
      breakdown: Record<string, number>;
      review: boolean;
      revision: number;
    },
    now: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO report_session_facts (tenant_id, session_id, assessment_id, trust_score, trust_band, trust_breakdown, trust_review, trust_revision, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET
         assessment_id = COALESCE(report_session_facts.assessment_id, EXCLUDED.assessment_id),
         trust_score = EXCLUDED.trust_score, trust_band = EXCLUDED.trust_band, trust_breakdown = EXCLUDED.trust_breakdown,
         trust_review = EXCLUDED.trust_review, trust_revision = EXCLUDED.trust_revision, updated_at = EXCLUDED.updated_at
       WHERE report_session_facts.trust_revision IS NULL OR report_session_facts.trust_revision < EXCLUDED.trust_revision`,
      [
        tenantId,
        sessionId,
        t.assessmentId,
        t.score,
        t.band,
        JSON.stringify(t.breakdown),
        t.review,
        t.revision,
        now,
      ],
    );
  }

  async upsertInterview(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    i: InterviewSummary,
    revision: number,
    now: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO report_session_facts (tenant_id, session_id, interview, interview_revision, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET interview = EXCLUDED.interview,
         interview_revision = EXCLUDED.interview_revision, updated_at = EXCLUDED.updated_at
       WHERE report_session_facts.interview_revision IS NULL OR report_session_facts.interview_revision <= EXCLUDED.interview_revision`,
      [tenantId, sessionId, JSON.stringify(i), revision, now],
    );
  }

  async facts(tx: Tx, sessionId: string): Promise<SessionFacts | null> {
    const r = await tx.query(`SELECT * FROM report_session_facts WHERE session_id = $1`, [
      sessionId,
    ]);
    return r.rows[0] ? toFacts(r.rows[0]) : null;
  }

  /** One page of an assessment's sessions in session order (keyset; exports stream page by page). */
  async factsPage(
    tx: Tx,
    assessmentId: string,
    after: string | null,
    limit: number,
  ): Promise<SessionFacts[]> {
    const r = await tx.query(
      `SELECT * FROM report_session_facts WHERE assessment_id = $1 AND ($2::uuid IS NULL OR session_id > $2)
       ORDER BY session_id LIMIT $3`,
      [assessmentId, after, limit],
    );
    return r.rows.map(toFacts);
  }

  async assessmentSkillIds(tx: Tx, assessmentId: string): Promise<string[]> {
    const r = await tx.query(
      `SELECT DISTINCT s->>'skillId' AS id FROM report_session_facts, jsonb_array_elements(skills) s
       WHERE assessment_id = $1 AND skills IS NOT NULL ORDER BY 1`,
      [assessmentId],
    );
    return r.rows.map((row) => row['id'] as string);
  }

  async assessmentExists(tx: Tx, assessmentId: string): Promise<boolean> {
    const r = await tx.query(
      `SELECT 1 FROM report_session_facts WHERE assessment_id = $1 LIMIT 1`,
      [assessmentId],
    );
    return r.rows.length > 0;
  }

  // --- Jobs and artifacts -------------------------------------------------------------------

  async insertJob(
    tx: Tx,
    tenantId: string,
    j: Omit<JobRow, 'status' | 'attempts' | 'error' | 'artifactId' | 'finishedAt'>,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO report_jobs (tenant_id, report_id, type, params, subject_id, requested_by, available_at, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7)`,
      [
        tenantId,
        j.reportId,
        j.type,
        JSON.stringify(j.params),
        j.subjectId,
        j.requestedBy,
        j.createdAt,
      ],
    );
  }

  async job(tx: Tx, id: string): Promise<JobRow | null> {
    const r = await tx.query(`SELECT * FROM report_jobs WHERE report_id = $1`, [id]);
    return r.rows[0] ? toJob(r.rows[0]) : null;
  }

  async jobs(tx: Tx, requestedBy: string | null, limit: number): Promise<JobRow[]> {
    const r = await tx.query(
      `SELECT * FROM report_jobs WHERE ($1::text IS NULL OR requested_by = $1) ORDER BY created_at DESC, report_id LIMIT $2`,
      [requestedBy, limit],
    );
    return r.rows.map(toJob);
  }

  async claimJobs(tx: Tx, now: Date, leaseUntil: Date, limit: number): Promise<Claimed[]> {
    const r = await tx.query(
      `UPDATE report_jobs j SET status = 'running', available_at = $2, attempts = j.attempts + 1
       FROM (SELECT tenant_id, report_id FROM report_jobs
             WHERE status IN ('queued', 'running') AND available_at <= $1
             ORDER BY available_at LIMIT $3 FOR UPDATE SKIP LOCKED) due
       WHERE j.tenant_id = due.tenant_id AND j.report_id = due.report_id
       RETURNING j.tenant_id, j.report_id, j.attempts`,
      [now, leaseUntil, limit],
    );
    return r.rows.map((row) => ({
      tenantId: row['tenant_id'] as string,
      id: row['report_id'] as string,
      attempts: row['attempts'] as number,
    }));
  }

  async finishJob(tx: Tx, id: string, artifactId: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE report_jobs SET status = 'ready', artifact_id = $2, finished_at = $3, error = NULL WHERE report_id = $1`,
      [id, artifactId, now],
    );
  }

  async retryJob(tx: Tx, id: string, until: Date, error: string): Promise<void> {
    await tx.query(
      `UPDATE report_jobs SET status = 'queued', available_at = $2, error = $3 WHERE report_id = $1`,
      [id, until, error.slice(0, 500)],
    );
  }

  async failJob(tx: Tx, id: string, error: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE report_jobs SET status = 'failed', error = $2, finished_at = $3 WHERE report_id = $1`,
      [id, error.slice(0, 500), now],
    );
  }

  async insertArtifact(tx: Tx, tenantId: string, a: ArtifactRow): Promise<void> {
    await tx.query(
      `INSERT INTO report_artifacts (tenant_id, artifact_id, report_id, storage_key, content_type, file_name, size_bytes, sha256, subject_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        a.artifactId,
        a.reportId,
        a.storageKey,
        a.contentType,
        a.fileName,
        a.sizeBytes,
        a.sha256,
        a.subjectId,
        a.createdAt,
        a.expiresAt,
      ],
    );
  }

  async artifact(tx: Tx, id: string): Promise<ArtifactRow | null> {
    const r = await tx.query(`SELECT * FROM report_artifacts WHERE artifact_id = $1`, [id]);
    return r.rows[0] ? toArtifact(r.rows[0]) : null;
  }

  /** Erasure: the candidate's facts, jobs and artifacts; returns the storage keys to delete. */
  async eraseCandidate(tx: Tx, candidateId: string): Promise<string[]> {
    const keys = await tx.query(
      `DELETE FROM report_artifacts WHERE subject_id = $1 RETURNING storage_key`,
      [candidateId],
    );
    await tx.query(`DELETE FROM report_jobs WHERE subject_id = $1`, [candidateId]);
    await tx.query(`DELETE FROM report_session_facts WHERE candidate_id = $1`, [candidateId]);
    return keys.rows.map((r) => r['storage_key'] as string);
  }

  async purgeTenant(tx: Tx): Promise<void> {
    for (const t of ['report_artifacts', 'report_jobs', 'report_session_facts', 'report_settings'])
      await tx.query(`DELETE FROM ${t}`);
  }
}
