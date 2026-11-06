import { Injectable } from '@nestjs/common';
import { type CandidateSource, type SkillEvidenceSource } from '@atlas/contracts';
import { type Tx } from '@atlas/platform';
import {
  type CandidateRepository,
  type CurrentSkill,
  type DocumentRepository,
  type DocumentStatus,
  type EvidenceRepository,
  type PiiColumns,
  type PrivacyRepository,
  type PurgeRepository,
  type ResumeDocument,
  type StoredCandidate,
  type StoredEvidence,
} from '../application/ports';
import { type Candidate } from '../domain/candidate';
import { type DocumentMimeType } from '../domain/documents';
import {
  type ErasureAck,
  type ErasureCertificate,
  type PrivacyRequest,
  type PrivacyStatus,
} from '../domain/privacy';

/**
 * Every statement names `tenant_id = current_tenant_id()` explicitly in addition to RLS, so a
 * call made from a system transaction (event consumers) can never touch another tenant.
 */
const T = 'tenant_id = current_tenant_id()';
const date = (v: Date | null): Date | null => (v ? new Date(v) : null);
const buf = (v: Uint8Array | null): Buffer | null => (v ? Buffer.from(v) : null);

interface CandidateRow {
  tenant_id: string;
  candidate_id: string;
  user_id: string | null;
  source: CandidateSource;
  external_ref: string | null;
  pii_enc: Uint8Array;
  current_title: string | null;
  job_profile_id: string | null;
  department: string | null;
  location_country: string | null;
  total_experience_months: number | null;
  profile: Record<string, unknown>;
  profile_version: number;
  marketplace_opt_in: boolean;
  consent: Record<string, unknown>;
  legal_hold: boolean;
  last_activity_at: Date;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const CANDIDATE_COLUMNS = `tenant_id, candidate_id, user_id, source, external_ref, pii_enc, current_title,
  job_profile_id, department, location_country, total_experience_months, profile, profile_version,
  marketplace_opt_in, consent, legal_hold, last_activity_at, version, created_at, updated_at`;

function toCandidate(r: CandidateRow): Candidate {
  return {
    id: r.candidate_id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    source: r.source,
    externalRef: r.external_ref,
    currentTitle: r.current_title,
    jobProfileId: r.job_profile_id,
    department: r.department,
    locationCountry: r.location_country,
    totalExperienceMonths:
      r.total_experience_months === null ? null : Number(r.total_experience_months),
    profile: r.profile,
    profileVersion: Number(r.profile_version),
    marketplaceOptIn: r.marketplace_opt_in,
    consent: r.consent,
    legalHold: r.legal_hold,
    lastActivityAt: new Date(r.last_activity_at),
    version: Number(r.version),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

@Injectable()
export class PgCandidateRepository implements CandidateRepository {
  async insert(tx: Tx, c: Candidate, pii: PiiColumns): Promise<void> {
    await tx.query(
      `INSERT INTO candidates (tenant_id, candidate_id, user_id, source, external_ref, pii_enc, email_bidx, phone_bidx,
         current_title, job_profile_id, department, location_country, total_experience_months, profile,
         profile_version, marketplace_opt_in, consent, legal_hold, last_activity_at, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17::jsonb, $18, $19, $20,
         $21, $22)`,
      [
        c.tenantId,
        c.id,
        c.userId,
        c.source,
        c.externalRef,
        pii.piiEnc,
        pii.emailBidx,
        pii.phoneBidx,
        c.currentTitle,
        c.jobProfileId,
        c.department,
        c.locationCountry,
        c.totalExperienceMonths,
        JSON.stringify(c.profile),
        c.profileVersion,
        c.marketplaceOptIn,
        JSON.stringify(c.consent),
        c.legalHold,
        c.lastActivityAt,
        c.version,
        c.createdAt,
        c.updatedAt,
      ],
    );
  }

  async find(
    tx: Tx,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<StoredCandidate | null> {
    const { rows } = await tx.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE candidate_id = $1 AND ${T} ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const r = rows[0];
    return r ? { candidate: toCandidate(r), piiEnc: Buffer.from(r.pii_enc) } : null;
  }

  async findIdByEmailIndex(tx: Tx, emailBidx: Buffer): Promise<string | null> {
    const { rows } = await tx.query<{ candidate_id: string }>(
      `SELECT candidate_id FROM candidates WHERE email_bidx = $1 AND ${T}`,
      [emailBidx],
    );
    return rows[0]?.candidate_id ?? null;
  }

  async list(tx: Tx, f: { limit: number; after?: { at: Date; id: string } }): Promise<Candidate[]> {
    const { rows } = await tx.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM candidates
       WHERE ${T} AND ($1::timestamptz IS NULL OR (last_activity_at, candidate_id) < ($1::timestamptz, $2::uuid))
       ORDER BY last_activity_at DESC, candidate_id DESC LIMIT $3`,
      [f.after?.at ?? null, f.after?.id ?? null, f.limit],
    );
    return rows.map(toCandidate);
  }

  async update(tx: Tx, c: Candidate, expectedVersion: number, pii?: PiiColumns): Promise<boolean> {
    const piiSet = pii ? ', pii_enc = $17, email_bidx = $18, phone_bidx = $19' : '';
    const params: unknown[] = [
      c.id,
      expectedVersion,
      c.userId,
      c.externalRef,
      c.currentTitle,
      c.jobProfileId,
      c.department,
      c.locationCountry,
      c.totalExperienceMonths,
      JSON.stringify(c.profile),
      c.profileVersion,
      c.marketplaceOptIn,
      JSON.stringify(c.consent),
      c.legalHold,
      c.lastActivityAt,
      c.version,
    ];
    if (pii) params.push(pii.piiEnc, pii.emailBidx, pii.phoneBidx);
    const { rowCount } = await tx.query(
      `UPDATE candidates SET user_id = $3, external_ref = $4, current_title = $5, job_profile_id = $6,
         department = $7, location_country = $8, total_experience_months = $9, profile = $10::jsonb,
         profile_version = $11, marketplace_opt_in = $12, consent = $13::jsonb, legal_hold = $14,
         last_activity_at = $15, version = $16${piiSet}
       WHERE candidate_id = $1 AND version = $2 AND ${T}`,
      params,
    );
    return rowCount === 1;
  }

  async delete(tx: Tx, id: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of [
      'candidate_skill_evidence',
      'candidate_skill_current',
      'resume_documents',
    ]) {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE candidate_id = $1 AND ${T}`,
        [id],
      );
      counts[table] = Number(rows[0]?.n ?? 0);
    }
    // Cascades remove evidence, current skills and documents in the same statement.
    const { rowCount } = await tx.query(`DELETE FROM candidates WHERE candidate_id = $1 AND ${T}`, [
      id,
    ]);
    counts['candidates'] = rowCount;
    return counts;
  }

  async inactiveSince(tx: Tx, cutoff: Date, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ candidate_id: string }>(
      `SELECT candidate_id FROM candidates
       WHERE ${T} AND legal_hold = false AND source <> 'employee' AND last_activity_at < $1
       ORDER BY last_activity_at LIMIT $2`,
      [cutoff, limit],
    );
    return rows.map((r) => r.candidate_id);
  }
}

interface EvidenceRow {
  evidence_id: string;
  skill_id: string;
  source: SkillEvidenceSource;
  proficiency: string;
  confidence: string;
  source_ref: string | null;
  reason: string | null;
  recorded_by: string;
  observed_at: Date;
  valid_until: Date | null;
}

function toEvidence(r: EvidenceRow): StoredEvidence {
  return {
    id: r.evidence_id,
    skillId: r.skill_id,
    source: r.source,
    proficiency: Number(r.proficiency),
    confidence: Number(r.confidence),
    sourceRef: r.source_ref,
    reason: r.reason,
    recordedBy: r.recorded_by,
    observedAt: new Date(r.observed_at),
    validUntil: date(r.valid_until),
  };
}

const EVIDENCE_COLUMNS = `evidence_id, skill_id, source, proficiency::text AS proficiency, confidence::text AS confidence,
  source_ref, reason, recorded_by, observed_at, valid_until`;

interface CurrentRow {
  skill_id: string;
  proficiency: string;
  is_validated: boolean;
  calibration_needed: boolean;
  evidence_count: number;
  computed_at: Date;
}

@Injectable()
export class PgEvidenceRepository implements EvidenceRepository {
  async insert(tx: Tx, tenantId: string, candidateId: string, e: StoredEvidence): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO candidate_skill_evidence (tenant_id, evidence_id, candidate_id, skill_id, source, proficiency,
         confidence, source_ref, reason, recorded_by, observed_at, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, candidate_id, skill_id, source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
      [
        tenantId,
        e.id,
        candidateId,
        e.skillId,
        e.source,
        e.proficiency,
        e.confidence,
        e.sourceRef,
        e.reason,
        e.recordedBy,
        e.observedAt,
        e.validUntil,
      ],
    );
    return rowCount === 1;
  }

  async forSkill(tx: Tx, candidateId: string, skillId: string): Promise<StoredEvidence[]> {
    const { rows } = await tx.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} FROM candidate_skill_evidence
       WHERE candidate_id = $1 AND skill_id = $2 AND ${T} ORDER BY observed_at`,
      [candidateId, skillId],
    );
    return rows.map(toEvidence);
  }

  async forCandidate(tx: Tx, candidateId: string): Promise<StoredEvidence[]> {
    const { rows } = await tx.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} FROM candidate_skill_evidence
       WHERE candidate_id = $1 AND ${T} ORDER BY observed_at DESC`,
      [candidateId],
    );
    return rows.map(toEvidence);
  }

  async upsertCurrent(
    tx: Tx,
    tenantId: string,
    candidateId: string,
    s: CurrentSkill,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO candidate_skill_current (tenant_id, candidate_id, skill_id, proficiency, is_validated,
         calibration_needed, evidence_count, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, candidate_id, skill_id) DO UPDATE SET proficiency = EXCLUDED.proficiency,
         is_validated = EXCLUDED.is_validated, calibration_needed = EXCLUDED.calibration_needed,
         evidence_count = EXCLUDED.evidence_count, computed_at = EXCLUDED.computed_at`,
      [
        tenantId,
        candidateId,
        s.skillId,
        s.proficiency,
        s.isValidated,
        s.calibrationNeeded,
        s.evidenceCount,
        s.computedAt,
      ],
    );
  }

  async deleteCurrent(tx: Tx, candidateId: string, skillId: string): Promise<void> {
    await tx.query(
      `DELETE FROM candidate_skill_current WHERE candidate_id = $1 AND skill_id = $2 AND ${T}`,
      [candidateId, skillId],
    );
  }

  async currentFor(tx: Tx, candidateId: string): Promise<CurrentSkill[]> {
    const { rows } = await tx.query<CurrentRow>(
      `SELECT skill_id, proficiency::text AS proficiency, is_validated, calibration_needed, evidence_count, computed_at
       FROM candidate_skill_current WHERE candidate_id = $1 AND ${T} ORDER BY proficiency DESC, skill_id`,
      [candidateId],
    );
    return rows.map((r) => ({
      skillId: r.skill_id,
      proficiency: Number(r.proficiency),
      isValidated: r.is_validated,
      calibrationNeeded: r.calibration_needed,
      evidenceCount: Number(r.evidence_count),
      computedAt: new Date(r.computed_at),
    }));
  }
}

interface DocumentRow {
  tenant_id: string;
  document_id: string;
  candidate_id: string;
  storage_key: string;
  sha256: Uint8Array;
  mime_type: DocumentMimeType;
  byte_size: number;
  parse_status: DocumentStatus;
  flags: string[];
  error_code: string | null;
  page_count: number | null;
  language: string | null;
  parser_version: string | null;
  upload_expires_at: Date;
  uploaded_at: Date | null;
  parsed_at: Date | null;
  created_at: Date;
}

const DOCUMENT_COLUMNS = `tenant_id, document_id, candidate_id, storage_key, sha256, mime_type, byte_size, parse_status,
  flags, error_code, page_count, language, parser_version, upload_expires_at, uploaded_at, parsed_at, created_at`;

function toDocument(r: DocumentRow): ResumeDocument {
  return {
    id: r.document_id,
    tenantId: r.tenant_id,
    candidateId: r.candidate_id,
    storageKey: r.storage_key,
    sha256: Buffer.from(r.sha256),
    mimeType: r.mime_type,
    byteSize: Number(r.byte_size),
    status: r.parse_status,
    flags: r.flags,
    errorCode: r.error_code,
    pageCount: r.page_count === null ? null : Number(r.page_count),
    language: r.language?.trim() ?? null,
    parserVersion: r.parser_version,
    uploadExpiresAt: new Date(r.upload_expires_at),
    uploadedAt: date(r.uploaded_at),
    parsedAt: date(r.parsed_at),
    createdAt: new Date(r.created_at),
  };
}

@Injectable()
export class PgDocumentRepository implements DocumentRepository {
  async insert(tx: Tx, d: ResumeDocument): Promise<void> {
    await tx.query(
      `INSERT INTO resume_documents (tenant_id, document_id, candidate_id, storage_key, sha256, mime_type, byte_size,
         parse_status, upload_expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        d.tenantId,
        d.id,
        d.candidateId,
        d.storageKey,
        d.sha256,
        d.mimeType,
        d.byteSize,
        d.status,
        d.uploadExpiresAt,
        d.createdAt,
      ],
    );
  }

  async find(
    tx: Tx,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<ResumeDocument | null> {
    const { rows } = await tx.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM resume_documents WHERE document_id = $1 AND ${T} ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async findBySha(tx: Tx, sha256: Buffer): Promise<ResumeDocument | null> {
    const { rows } = await tx.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM resume_documents WHERE sha256 = $1 AND ${T}`,
      [sha256],
    );
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async delete(tx: Tx, id: string): Promise<void> {
    await tx.query(`DELETE FROM resume_documents WHERE document_id = $1 AND ${T}`, [id]);
  }

  async setStatus(
    tx: Tx,
    id: string,
    status: DocumentStatus,
    extra: { uploadedAt?: Date; errorCode?: string | null; flags?: string[] },
  ): Promise<void> {
    await tx.query(
      `UPDATE resume_documents SET parse_status = $2, uploaded_at = coalesce($3, uploaded_at),
         error_code = coalesce($4, error_code), flags = coalesce($5::text[], flags)
       WHERE document_id = $1 AND ${T}`,
      [id, status, extra.uploadedAt ?? null, extra.errorCode ?? null, extra.flags ?? null],
    );
  }

  async applyParsed(
    tx: Tx,
    id: string,
    p: {
      parserVersion: string;
      language: string | null;
      pageCount: number | null;
      flags: string[];
      parsedJson: Record<string, unknown>;
      parsedAt: Date;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE resume_documents SET parse_status = 'parsed', parser_version = $2, language = $3, page_count = $4,
         flags = $5::text[], parsed_json = $6::jsonb, parsed_at = $7, error_code = NULL
       WHERE document_id = $1 AND ${T}`,
      [
        id,
        p.parserVersion,
        p.language,
        p.pageCount,
        p.flags,
        JSON.stringify(p.parsedJson),
        p.parsedAt,
      ],
    );
  }

  async keysForCandidate(tx: Tx, candidateId: string): Promise<string[]> {
    const { rows } = await tx.query<{ storage_key: string }>(
      `SELECT storage_key FROM resume_documents WHERE candidate_id = $1 AND ${T}`,
      [candidateId],
    );
    return rows.map((r) => r.storage_key);
  }

  async forCandidate(tx: Tx, candidateId: string): Promise<ResumeDocument[]> {
    const { rows } = await tx.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM resume_documents WHERE candidate_id = $1 AND ${T} ORDER BY created_at DESC`,
      [candidateId],
    );
    return rows.map(toDocument);
  }
}

interface PrivacyRow {
  tenant_id: string;
  request_id: string;
  candidate_id: string;
  request_type: 'access' | 'erasure';
  reason: 'data_subject' | 'retention';
  status: PrivacyStatus;
  requested_by: string;
  ack_required_from: string[];
  acks: ErasureAck[];
  export_enc: Uint8Array | null;
  certificate: ErasureCertificate | null;
  due_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
}

function toPrivacy(r: PrivacyRow): PrivacyRequest {
  return {
    id: r.request_id,
    tenantId: r.tenant_id,
    candidateId: r.candidate_id,
    type: r.request_type,
    reason: r.reason,
    status: r.status,
    requestedBy: r.requested_by,
    ackRequiredFrom: r.ack_required_from,
    acks: r.acks,
    certificate: r.certificate,
    dueAt: date(r.due_at),
    createdAt: new Date(r.created_at),
    completedAt: date(r.completed_at),
  };
}

const PRIVACY_COLUMNS = `tenant_id, request_id, candidate_id, request_type, reason, status, requested_by,
  ack_required_from, acks, export_enc, certificate, due_at, created_at, completed_at`;

@Injectable()
export class PgPrivacyRepository implements PrivacyRepository {
  async insert(tx: Tx, r: PrivacyRequest, exportEnc: Buffer | null): Promise<void> {
    await tx.query(
      `INSERT INTO privacy_requests (${PRIVACY_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10, $11::jsonb, $12, $13, $14)`,
      [
        r.tenantId,
        r.id,
        r.candidateId,
        r.type,
        r.reason,
        r.status,
        r.requestedBy,
        [...r.ackRequiredFrom],
        JSON.stringify(r.acks),
        exportEnc,
        r.certificate ? JSON.stringify(r.certificate) : null,
        r.dueAt,
        r.createdAt,
        r.completedAt,
      ],
    );
  }

  async find(
    tx: Tx,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<{ request: PrivacyRequest; exportEnc: Buffer | null } | null> {
    const { rows } = await tx.query<PrivacyRow>(
      `SELECT ${PRIVACY_COLUMNS} FROM privacy_requests WHERE request_id = $1 AND ${T} ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const r = rows[0];
    return r ? { request: toPrivacy(r), exportEnc: buf(r.export_enc) } : null;
  }

  async update(tx: Tx, r: PrivacyRequest): Promise<void> {
    await tx.query(
      `UPDATE privacy_requests SET status = $2, acks = $3::jsonb, certificate = $4::jsonb, completed_at = $5
       WHERE request_id = $1 AND ${T}`,
      [
        r.id,
        r.status,
        JSON.stringify(r.acks),
        r.certificate ? JSON.stringify(r.certificate) : null,
        r.completedAt,
      ],
    );
  }

  async overdue(tx: Tx, now: Date): Promise<PrivacyRequest[]> {
    const { rows } = await tx.query<PrivacyRow>(
      `SELECT ${PRIVACY_COLUMNS} FROM privacy_requests WHERE ${T} AND status = 'awaiting_acks' AND due_at <= $1`,
      [now],
    );
    return rows.map(toPrivacy);
  }
}

/** Tenant purge. Privacy requests go too: the tenant's data no longer exists anywhere. */
@Injectable()
export class PgPurgeRepository implements PurgeRepository {
  async purgeTenant(tx: Tx): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    for (const table of [
      'candidate_skill_evidence',
      'candidate_skill_current',
      'resume_documents',
      'candidates',
      'privacy_requests',
    ]) {
      const { rowCount } = await tx.query(`DELETE FROM ${table} WHERE ${T}`);
      removed[table] = rowCount;
    }
    return removed;
  }
}
