import { type Tx } from '@atlas/platform';
import {
  type CandidateMatchRow,
  type FeatureRepository,
  type RequisitionRepository,
  type ScoreRepository,
  type WorkItem,
  type WorkQueue,
} from '../application/ports';
import { type CandidateFeatures, type CandidateSkillFeature } from '../domain/features';
import {
  type Calibrated,
  type Calibration,
  isScorable,
  type Requisition,
  type RequisitionStatus,
} from '../domain/requisition';
import { type ScoredCandidate } from '../domain/score';

interface RequisitionRow {
  tenant_id: string;
  requisition_id: string;
  title: string;
  description: string;
  openings: number;
  location: string | null;
  hiring_manager_id: string | null;
  job_profile_id: string | null;
  min_experience_years: string | number | null;
  keywords: string[];
  status: RequisitionStatus;
  calibration_status: Requisition['calibrationStatus'];
  calibration: Calibration | null;
  calibration_version: number;
  calibrated_at: Date | string | null;
  version: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const date = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

function toRequisition(r: RequisitionRow): Requisition {
  return {
    tenantId: r.tenant_id,
    id: r.requisition_id,
    title: r.title,
    description: r.description,
    openings: r.openings,
    location: r.location,
    hiringManagerId: r.hiring_manager_id,
    jobProfileId: r.job_profile_id,
    minExperienceYears: r.min_experience_years === null ? null : Number(r.min_experience_years),
    keywords: r.keywords ?? [],
    status: r.status,
    calibrationStatus: r.calibration_status,
    calibration: r.calibration,
    calibrationVersion: r.calibration_version,
    calibratedAt: r.calibrated_at === null ? null : date(r.calibrated_at),
    version: r.version,
    createdBy: r.created_by,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

const vectorText = (v: readonly number[]): string =>
  `[${v.map((x) => Number(x.toPrecision(7))).join(',')}]`;
const parseVector = (text: string): number[] => text.slice(1, -1).split(',').map(Number);

const REQUISITION_COLUMNS = `tenant_id::text, requisition_id::text, title, description, openings, location,
  hiring_manager_id::text, job_profile_id::text, min_experience_years, keywords, status::text,
  calibration_status::text, calibration, calibration_version, calibrated_at, version, created_by,
  created_at, updated_at`;

export class PgRequisitionRepository implements RequisitionRepository {
  async bySource(tx: Tx, source: string, ref: string): Promise<Requisition | null> {
    const r = await tx.query<{ id: string }>(
      `SELECT requisition_id::text AS id FROM requisition_sources WHERE source = $1 AND source_ref = $2`,
      [source, ref],
    );
    return r.rows[0] ? this.find(tx, r.rows[0].id) : null;
  }

  async linkSource(tx: Tx, source: string, ref: string, requisitionId: string): Promise<void> {
    await tx.query(
      `INSERT INTO requisition_sources (tenant_id, source, source_ref, requisition_id)
       VALUES (current_tenant_id(), $1, $2, $3)`,
      [source, ref, requisitionId],
    );
  }

  async insert(tx: Tx, r: Requisition): Promise<void> {
    await tx.query(
      `INSERT INTO job_requisitions (tenant_id, requisition_id, title, description, openings, location,
         hiring_manager_id, job_profile_id, min_experience_years, keywords, status, calibration_status,
         calibration, calibration_version, calibrated_at, version, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)`,
      [
        r.tenantId,
        r.id,
        r.title,
        r.description,
        r.openings,
        r.location,
        r.hiringManagerId,
        r.jobProfileId,
        r.minExperienceYears,
        r.keywords,
        r.status,
        r.calibrationStatus,
        r.calibration ? JSON.stringify(r.calibration) : null,
        r.calibrationVersion,
        r.calibratedAt,
        r.version,
        r.createdBy,
        r.createdAt,
      ],
    );
  }

  async find(
    tx: Tx,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Requisition | null> {
    const { rows } = await tx.query<RequisitionRow>(
      `SELECT ${REQUISITION_COLUMNS} FROM job_requisitions WHERE requisition_id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toRequisition(rows[0]) : null;
  }

  async list(
    tx: Tx,
    query: { limit: number; status?: RequisitionStatus; after?: { createdAt: Date; id: string } },
  ): Promise<Requisition[]> {
    const { rows } = await tx.query<RequisitionRow>(
      `SELECT ${REQUISITION_COLUMNS} FROM job_requisitions
       WHERE ($1::requisition_status IS NULL OR status = $1::requisition_status)
         AND ($2::timestamptz IS NULL OR (created_at, requisition_id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, requisition_id DESC LIMIT $4`,
      [query.status ?? null, query.after?.createdAt ?? null, query.after?.id ?? null, query.limit],
    );
    return rows.map(toRequisition);
  }

  async update(tx: Tx, r: Requisition, expectedVersion: number): Promise<boolean> {
    const result = await tx.query(
      `UPDATE job_requisitions SET title = $3, description = $4, openings = $5, location = $6,
         hiring_manager_id = $7, job_profile_id = $8, min_experience_years = $9, keywords = $10,
         status = $11, calibration_status = $12, calibration = $13, calibration_version = $14,
         calibrated_at = $15, version = $16
       WHERE requisition_id = $1 AND version = $2`,
      [
        r.id,
        expectedVersion,
        r.title,
        r.description,
        r.openings,
        r.location,
        r.hiringManagerId,
        r.jobProfileId,
        r.minExperienceYears,
        r.keywords,
        r.status,
        r.calibrationStatus,
        r.calibration ? JSON.stringify(r.calibration) : null,
        r.calibrationVersion,
        r.calibratedAt,
        r.version,
      ],
    );
    return result.rowCount === 1;
  }

  async saveEmbedding(
    tx: Tx,
    r: Requisition,
    model: string,
    sha256: string,
    vector: number[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO requisition_embeddings (tenant_id, requisition_id, model_id, content_sha256, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (tenant_id, requisition_id, model_id)
       DO UPDATE SET content_sha256 = EXCLUDED.content_sha256, embedding = EXCLUDED.embedding, created_at = now()`,
      [r.tenantId, r.id, model, sha256, vectorText(vector)],
    );
  }

  async embedding(tx: Tx, id: string, model: string): Promise<number[] | null> {
    // Only an embedding of the CURRENT calibration text counts (a re-calibration replaces it).
    const { rows } = await tx.query<{ embedding: string }>(
      `SELECT e.embedding::text AS embedding FROM requisition_embeddings e
       JOIN job_requisitions r USING (tenant_id, requisition_id)
       WHERE e.requisition_id = $1 AND e.model_id = $2
         AND e.content_sha256 = encode(sha256(convert_to(r.calibration->>'embedded_text', 'UTF8')), 'hex')`,
      [id, model],
    );
    return rows[0] ? parseVector(rows[0].embedding) : null;
  }

  async scorable(tx: Tx): Promise<Calibrated[]> {
    const { rows } = await tx.query<RequisitionRow>(
      `SELECT ${REQUISITION_COLUMNS} FROM job_requisitions
       WHERE status <> 'closed' AND calibration IS NOT NULL ORDER BY created_at`,
    );
    return rows.map(toRequisition).filter(isScorable);
  }

  async byJobProfile(tx: Tx, jobProfileId: string): Promise<Requisition[]> {
    const { rows } = await tx.query<RequisitionRow>(
      `SELECT ${REQUISITION_COLUMNS} FROM job_requisitions WHERE job_profile_id = $1`,
      [jobProfileId],
    );
    return rows.map(toRequisition);
  }

  async setLexicalMax(tx: Tx, id: string, max: number): Promise<void> {
    // Not a content change: no version bump.
    await tx.query(
      `UPDATE job_requisitions SET calibration = jsonb_set(calibration, '{lexical_max}', to_jsonb($2::float8))
       WHERE requisition_id = $1 AND calibration IS NOT NULL`,
      [id, max],
    );
  }

  async lexicalMax(tx: Tx, id: string): Promise<number> {
    const { rows } = await tx.query<{ m: number | null }>(
      `SELECT (calibration->>'lexical_max')::float8 AS m FROM job_requisitions WHERE requisition_id = $1`,
      [id],
    );
    return rows[0]?.m ?? 0;
  }
}

interface FeatureRow {
  tenant_id: string;
  candidate_id: string;
  skills: CandidateSkillFeature[];
  evidence: Record<string, string>;
  total_experience_months: number | null;
  current_title: string | null;
  profile_text: string;
}

export class PgFeatureRepository implements FeatureRepository {
  async upsertProfile(tx: Tx, f: Omit<CandidateFeatures, 'skills'>): Promise<void> {
    await tx.query(
      `INSERT INTO candidate_features (tenant_id, candidate_id, evidence, total_experience_months, current_title, profile_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, candidate_id) DO UPDATE SET evidence = EXCLUDED.evidence,
         total_experience_months = EXCLUDED.total_experience_months, current_title = EXCLUDED.current_title,
         profile_text = EXCLUDED.profile_text, updated_at = now()`,
      [
        f.tenantId,
        f.candidateId,
        JSON.stringify(f.evidence),
        f.totalExperienceMonths,
        f.currentTitle,
        f.profileText,
      ],
    );
  }

  async upsertSkills(
    tx: Tx,
    tenantId: string,
    candidateId: string,
    skills: CandidateSkillFeature[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO candidate_features (tenant_id, candidate_id, skills) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, candidate_id) DO UPDATE SET skills = EXCLUDED.skills, updated_at = now()`,
      [tenantId, candidateId, JSON.stringify(skills)],
    );
  }

  async get(tx: Tx, candidateIds: string[]): Promise<Map<string, CandidateFeatures>> {
    if (candidateIds.length === 0) return new Map();
    const { rows } = await tx.query<FeatureRow>(
      `SELECT tenant_id::text, candidate_id::text, skills, evidence, total_experience_months, current_title, profile_text
       FROM candidate_features WHERE candidate_id = ANY($1::uuid[])`,
      [candidateIds],
    );
    return new Map(
      rows.map((r) => [
        r.candidate_id,
        {
          tenantId: r.tenant_id,
          candidateId: r.candidate_id,
          skills: r.skills,
          evidence: r.evidence,
          totalExperienceMonths: r.total_experience_months,
          currentTitle: r.current_title,
          profileText: r.profile_text,
        },
      ]),
    );
  }

  async delete(tx: Tx, candidateId: string): Promise<number> {
    return (await tx.query('DELETE FROM candidate_features WHERE candidate_id = $1', [candidateId]))
      .rowCount;
  }
}

export class PgScoreRepository implements ScoreRepository {
  async replaceForRequisition(
    tx: Tx,
    tenantId: string,
    requisitionId: string,
    scored: ScoredCandidate[],
    weightsVersion: string,
    at: Date,
  ): Promise<void> {
    await tx.query('DELETE FROM match_scores WHERE requisition_id = $1', [requisitionId]);
    for (const s of scored) await this.upsert(tx, tenantId, requisitionId, s, weightsVersion, at);
  }

  async upsert(
    tx: Tx,
    tenantId: string,
    requisitionId: string,
    s: ScoredCandidate,
    weightsVersion: string,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO match_scores (tenant_id, requisition_id, candidate_id, score, band, components, explanation,
         weights_version, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, requisition_id, candidate_id) DO UPDATE SET score = EXCLUDED.score,
         band = EXCLUDED.band, components = EXCLUDED.components, explanation = EXCLUDED.explanation,
         weights_version = EXCLUDED.weights_version, computed_at = EXCLUDED.computed_at`,
      [
        tenantId,
        requisitionId,
        s.candidate_id,
        s.score,
        s.band,
        JSON.stringify(s.components),
        JSON.stringify(s.explanation),
        weightsVersion,
        at,
      ],
    );
  }

  async forCandidate(tx: Tx, candidateId: string, limit: number): Promise<CandidateMatchRow[]> {
    const { rows } = await tx.query<
      CandidateMatchRow & { score: string | number; computed_at: Date | string }
    >(
      `SELECT s.requisition_id::text, r.title, r.status::text AS status, s.score, s.band::text AS band,
              s.components, s.explanation, s.weights_version, s.computed_at
       FROM match_scores s JOIN job_requisitions r USING (tenant_id, requisition_id)
       WHERE s.candidate_id = $1 AND r.status <> 'closed'
       ORDER BY s.score DESC, s.requisition_id LIMIT $2`,
      [candidateId, limit],
    );
    return rows.map((r) => ({
      ...r,
      score: Number(r.score),
      computed_at: date(r.computed_at).toISOString(),
    }));
  }

  async deleteCandidate(tx: Tx, candidateId: string): Promise<number> {
    return (await tx.query('DELETE FROM match_scores WHERE candidate_id = $1', [candidateId]))
      .rowCount;
  }
}

export class PgWorkQueue implements WorkQueue {
  async enqueue(tx: Tx, item: Omit<WorkItem, 'attempts'>): Promise<void> {
    await tx.query(
      `INSERT INTO match_work (tenant_id, kind, subject_id, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, kind, subject_id) DO UPDATE SET reason = EXCLUDED.reason, attempts = 0`,
      [item.tenantId, item.kind, item.subjectId, item.reason],
    );
  }

  async claim(tx: Tx, limit: number): Promise<WorkItem[]> {
    const { rows } = await tx.query<{
      tenant_id: string;
      kind: WorkItem['kind'];
      subject_id: string;
      reason: string;
      attempts: number;
    }>(
      `DELETE FROM match_work WHERE (tenant_id, kind, subject_id) IN (
         SELECT tenant_id, kind, subject_id FROM match_work ORDER BY enqueued_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING tenant_id::text, kind, subject_id::text, reason, attempts, enqueued_at`,
      [limit],
    );
    // Requisitions first (their ranking also scores the candidates queued with them).
    return rows
      .map((r) => ({
        tenantId: r.tenant_id,
        kind: r.kind,
        subjectId: r.subject_id,
        reason: r.reason,
        attempts: r.attempts,
      }))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'requisition' ? -1 : 1));
  }

  async retry(tx: Tx, item: WorkItem): Promise<void> {
    await tx.query(
      `INSERT INTO match_work (tenant_id, kind, subject_id, reason, attempts) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, kind, subject_id) DO NOTHING`,
      [item.tenantId, item.kind, item.subjectId, item.reason, item.attempts],
    );
  }

  async deleteSubject(tx: Tx, subjectId: string): Promise<number> {
    return (await tx.query('DELETE FROM match_work WHERE subject_id = $1', [subjectId])).rowCount;
  }
}
