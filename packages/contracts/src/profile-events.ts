import { z } from 'zod';
import { defineEvent } from './event';

/**
 * profile-svc events (docs/prompts/04-profile-svc.md §5). Events NEVER carry PII: candidates are
 * referenced by candidate_id only.
 */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

export const CANDIDATE_SOURCES = [
  'external_applicant',
  'employee',
  'referral',
  'sourced',
  'rediscovered',
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

export const SKILL_EVIDENCE_SOURCES = [
  'assessment',
  'certification',
  'manager',
  'ai_interview',
  'multi_rater',
  'project_inference',
  'resume_inference',
  'learning_completion',
  'self',
] as const;
export type SkillEvidenceSource = (typeof SKILL_EVIDENCE_SOURCES)[number];

export const CandidateCreated = defineEvent(
  'profile.candidate.created.v1',
  'candidate',
  z.object({
    tenant_id: uuid,
    candidate_id: uuid,
    source: z.enum(CANDIDATE_SOURCES),
    occurred_at: isoTime,
  }),
);

/** A document finished uploading and passed MIME sniffing; parsing-svc picks it up. */
export const ResumeUploaded = defineEvent(
  'profile.resume.uploaded.v1',
  'document',
  z.object({
    tenant_id: uuid,
    candidate_id: uuid,
    document_id: uuid,
    storage_key: z.string(),
    mime_type: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byte_size: z.number().int().positive(),
    occurred_at: isoTime,
  }),
);

/** Fused proficiencies changed (matching and intelligence re-score). */
export const CandidateSkillsUpdated = defineEvent(
  'profile.candidate.skills_updated.v1',
  'candidate',
  z.object({
    tenant_id: uuid,
    candidate_id: uuid,
    skills: z.array(
      z.object({
        skill_id: uuid,
        proficiency: z.number().min(0).max(5),
        is_validated: z.boolean(),
        calibration_needed: z.boolean(),
      }),
    ),
    occurred_at: isoTime,
  }),
);

/** Every service holding data about the candidate must delete it and acknowledge. */
export const ErasureRequested = defineEvent(
  'privacy.erasure.requested.v1',
  'privacy_request',
  z.object({
    tenant_id: uuid,
    request_id: uuid,
    candidate_id: uuid,
    reason: z.enum(['data_subject', 'retention']),
    ack_required_from: z.array(z.string()),
    due_at: isoTime,
    occurred_at: isoTime,
  }),
);

/** Emitted by each consumer of ErasureRequested once its data is gone. */
export const ErasureAcknowledged = defineEvent(
  'privacy.erasure.acknowledged.v1',
  'privacy_request',
  z.object({
    tenant_id: uuid,
    request_id: uuid,
    service: z.string().min(1),
    occurred_at: isoTime,
  }),
);

export const ErasureCompleted = defineEvent(
  'privacy.erasure.completed.v1',
  'privacy_request',
  z.object({
    tenant_id: uuid,
    request_id: uuid,
    candidate_id: uuid,
    acks: z.array(z.object({ service: z.string(), at: isoTime })),
    completed_at: isoTime,
  }),
);

/** Produced by parsing-svc (brick 6). `profile` is the REDACTED ParsedResumeV3 (no PII). */
export const ResumeParsed = defineEvent(
  'profile.resume.parsed.v1',
  'document',
  z.object({
    tenant_id: uuid,
    candidate_id: uuid,
    document_id: uuid,
    parser_version: z.string(),
    language: z.string().length(2).nullable(),
    page_count: z.number().int().min(0).nullable(),
    flags: z.array(z.string()),
    profile: z.record(z.unknown()),
    current_title: z.string().max(200).nullable(),
    total_experience_months: z.number().int().min(0).max(900).nullable(),
    skills: z.array(
      z.object({
        skill_id: uuid,
        proficiency: z.number().min(0).max(5),
        confidence: z.number().min(0).max(1),
      }),
    ),
    occurred_at: isoTime,
  }),
);

/** Produced by assessment-svc (brick 8): per-skill scores on the 0–5 scale. */
export const AssessmentSessionEvaluated = defineEvent(
  'assessment.session.evaluated.v1',
  'assessment_session',
  z.object({
    tenant_id: uuid,
    candidate_id: uuid,
    session_id: uuid,
    skills: z.array(
      z.object({
        skill_id: uuid,
        score: z.number().min(0).max(5),
        confidence: z.number().min(0).max(1),
      }),
    ),
    /** Skill validity window (assessment report settings); the evidence expires then. */
    valid_until: isoTime.nullable().optional(),
    evaluated_at: isoTime,
  }),
);
