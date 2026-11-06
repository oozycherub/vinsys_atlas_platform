import { type Candidate } from '../domain/candidate';
import { type Pii } from '../domain/pii';
import { type PrivacyRequest } from '../domain/privacy';
import { type CurrentSkill, type ResumeDocument, type StoredEvidence } from './ports';

export interface CandidateView {
  candidate_id: string;
  tenant_id: string;
  user_id: string | null;
  source: string;
  external_ref: string | null;
  /** Decrypted only for callers with pii:read; otherwise null and pii_redacted is true. */
  pii: Pii | null;
  pii_redacted: boolean;
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
  last_activity_at: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function toCandidateView(c: Candidate, pii: Pii | null): CandidateView {
  return {
    candidate_id: c.id,
    tenant_id: c.tenantId,
    user_id: c.userId,
    source: c.source,
    external_ref: c.externalRef,
    pii,
    pii_redacted: pii === null,
    current_title: c.currentTitle,
    job_profile_id: c.jobProfileId,
    department: c.department,
    location_country: c.locationCountry,
    total_experience_months: c.totalExperienceMonths,
    profile: { ...c.profile },
    profile_version: c.profileVersion,
    marketplace_opt_in: c.marketplaceOptIn,
    consent: { ...c.consent },
    legal_hold: c.legalHold,
    last_activity_at: c.lastActivityAt.toISOString(),
    version: c.version,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

export function toSkillView(s: CurrentSkill) {
  return {
    skill_id: s.skillId,
    proficiency: s.proficiency,
    is_validated: s.isValidated,
    calibration_needed: s.calibrationNeeded,
    evidence_count: s.evidenceCount,
    computed_at: s.computedAt.toISOString(),
  };
}

export function toEvidenceView(e: StoredEvidence) {
  return {
    evidence_id: e.id,
    skill_id: e.skillId,
    source: e.source,
    proficiency: e.proficiency,
    confidence: e.confidence,
    source_ref: e.sourceRef,
    reason: e.reason,
    recorded_by: e.recordedBy,
    observed_at: e.observedAt.toISOString(),
    valid_until: e.validUntil?.toISOString() ?? null,
  };
}

export function toDocumentView(d: ResumeDocument) {
  return {
    document_id: d.id,
    candidate_id: d.candidateId,
    mime_type: d.mimeType,
    byte_size: d.byteSize,
    sha256: d.sha256.toString('hex'),
    parse_status: d.status,
    flags: d.flags,
    error_code: d.errorCode,
    page_count: d.pageCount,
    language: d.language,
    parser_version: d.parserVersion,
    uploaded_at: d.uploadedAt?.toISOString() ?? null,
    parsed_at: d.parsedAt?.toISOString() ?? null,
    created_at: d.createdAt.toISOString(),
  };
}

export function toPrivacyView(r: PrivacyRequest, exportData: unknown) {
  return {
    request_id: r.id,
    candidate_id: r.candidateId,
    type: r.type,
    reason: r.reason,
    status: r.status,
    requested_by: r.requestedBy,
    ack_required_from: [...r.ackRequiredFrom],
    acks: [...r.acks],
    certificate: r.certificate,
    due_at: r.dueAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
    completed_at: r.completedAt?.toISOString() ?? null,
    ...(exportData !== undefined ? { export: exportData } : {}),
  };
}
