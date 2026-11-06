import { QUESTION_TYPES } from '@atlas/contracts';
import { PreconditionFailedError, PreconditionRequiredError } from '@atlas/platform';
import { z } from 'zod';

const uuid = z.string().uuid();

export const tenantQuery = z.object({ tenant_id: uuid.optional() }).strict();

export const bankBody = z
  .object({
    tenant_id: uuid.optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(''),
    skill_ids: z.array(uuid).max(50).default([]),
  })
  .strict();

export const questionBody = z
  .object({
    tenant_id: uuid.optional(),
    bank_id: uuid.nullable().default(null),
    type: z.enum(QUESTION_TYPES),
    prompt: z.string().min(1).max(20_000),
    payload: z.unknown(),
    marks: z.number().gt(0).max(1000).default(1),
    negative_marks: z.number().min(0).max(1000).default(0),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
    skill_ids: z.array(uuid).max(20).default([]),
  })
  .strict();

export const listQuestionsQuery = z
  .object({
    tenant_id: uuid.optional(),
    bank_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const assessmentBody = z
  .object({
    tenant_id: uuid.optional(),
    title: z.string().trim().min(1).max(200),
    candidate_alias: z.string().max(200).nullable().default(null),
    kind: z.enum(['skills_test', 'coding', 'ai_interview', 'mixed']).default('skills_test'),
    navigation: z.enum(['fixed_section_order', 'section_switch']).default('fixed_section_order'),
    duration_seconds: z.number().int().min(60).max(21_600),
    definition: z.unknown(),
    settings: z.unknown().optional(),
    report_config: z.unknown().optional(),
    job_profile_id: uuid.nullable().default(null),
  })
  .strict();

export const listAssessmentsQuery = z
  .object({
    tenant_id: uuid.optional(),
    status: z.enum(['draft', 'published', 'inactive', 'archived']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const versionQuery = z
  .object({ tenant_id: uuid.optional(), version: z.coerce.number().int().min(1).optional() })
  .strict();

export const statusBody = z
  .object({ status: z.enum(['published', 'inactive', 'archived']) })
  .strict();

export const inviteBody = z
  .object({
    kind: z.enum(['open', 'targeted']),
    candidate_id: uuid.nullable().default(null),
    max_uses: z.number().int().min(1).max(100_000).nullable().default(null),
    expires_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();

export const redeemBody = z
  .object({ full_name: z.string().trim().min(1).max(200), email: z.string().email().max(254) })
  .strict()
  .optional();

export const saveBody = z
  .object({ client_rev: z.number().int().min(1).max(1_000_000), answer: z.unknown() })
  .strict();

const code = z.string().min(1).max(65_536);
const language = z.string().min(1).max(30);

export const runBody = z
  .object({ language, code, stdin: z.string().max(65_536).nullable().optional() })
  .strict();

export const codeSubmissionBody = z.object({ language, code }).strict();

export const waitQuery = z
  .object({ wait: z.coerce.number().int().min(0).max(10).default(0) })
  .strict();

export const startProctoringBody = z
  .object({
    consent: z.object({ biometrics: z.boolean(), version: z.string().min(1).max(40) }).strict(),
  })
  .strict();

export const sessionsQuery = z
  .object({
    tenant_id: uuid.optional(),
    status: z
      .string()
      .regex(/^[a-z_]+(,[a-z_]+)*$/)
      .transform((s) => s.split(','))
      .optional(),
    band: z.string().max(40).optional(),
    min_percent: z.coerce.number().min(0).max(100).optional(),
    candidate_status: z.enum(['pending', 'shortlisted', 'on_hold', 'rejected']).optional(),
    review_status: z
      .enum(['not_required', 'pending_review', 'in_review', 'cleared', 'confirmed_violation'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const reviewersBody = z
  .object({ reviewer_ids: z.array(z.string().min(1).max(200)).min(1).max(10) })
  .strict();

export const reviewBody = z
  .object({
    scores: z.record(uuid, z.number().min(0).max(1000)),
    comment: z.string().max(5000).nullable().default(null),
  })
  .strict();

export const candidateStatusBody = z
  .object({ status: z.enum(['pending', 'shortlisted', 'on_hold', 'rejected']) })
  .strict();

export function parseIfMatch(header: string | undefined): number {
  if (!header)
    throw new PreconditionRequiredError(
      'IF_MATCH_REQUIRED',
      'Send If-Match with the ETag from your last read.',
    );
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(header.trim());
  if (!match?.[1])
    throw new PreconditionFailedError('INVALID_IF_MATCH', 'If-Match must be an ETag such as "3".');
  return Number(match[1]);
}

export const etag = (v: number): string => `"${v}"`;
