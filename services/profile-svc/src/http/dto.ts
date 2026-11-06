import { CANDIDATE_SOURCES, SKILL_EVIDENCE_SOURCES } from '@atlas/contracts';
import { PreconditionFailedError, PreconditionRequiredError } from '@atlas/platform';
import { z } from 'zod';

/** Request schemas (mirror openapi.yaml). Unknown fields are rejected. */
const uuid = z.string().uuid();

const piiBody = z
  .object({
    full_name: z.string().min(1).max(200),
    email: z.string().max(254).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    dob: z.string().max(10).nullable().optional(),
  })
  .strict();

const attributes = {
  user_id: uuid.nullable().optional(),
  external_ref: z.string().max(200).nullable().optional(),
  current_title: z.string().max(200).nullable().optional(),
  job_profile_id: uuid.nullable().optional(),
  department: z.string().max(200).nullable().optional(),
  location_country: z.string().length(2).nullable().optional(),
  total_experience_months: z.number().int().nullable().optional(),
  marketplace_opt_in: z.boolean().optional(),
  consent: z.record(z.unknown()).optional(),
};

export const createCandidateBody = z
  .object({
    tenant_id: uuid.optional(),
    source: z.enum(CANDIDATE_SOURCES),
    pii: piiBody,
    ...attributes,
  })
  .strict();

export const patchCandidateBody = z
  .object({ pii: piiBody.partial().optional(), legal_hold: z.boolean().optional(), ...attributes })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required.');

export const tenantQuery = z.object({ tenant_id: uuid.optional() }).strict();

export const listCandidatesQuery = z
  .object({
    tenant_id: uuid.optional(),
    email: z.string().max(254).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(400).optional(),
  })
  .strict();

export const skillsQuery = z
  .object({ tenant_id: uuid.optional(), include: z.literal('evidence').optional() })
  .strict();

const evidenceItem = z
  .object({
    skill_id: uuid,
    source: z.enum(SKILL_EVIDENCE_SOURCES),
    proficiency: z.number(),
    confidence: z.number().default(1),
    source_ref: uuid.nullable().optional(),
    reason: z.string().max(1000).nullable().optional(),
    observed_at: z.string().datetime({ offset: true }).optional(),
    valid_until: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export const evidenceBody = z
  .object({ tenant_id: uuid.optional(), evidence: z.array(evidenceItem).min(1).max(100) })
  .strict();

export const initiateUploadBody = z
  .object({
    tenant_id: uuid.optional(),
    candidate_id: uuid,
    mime_type: z.string().max(100),
    byte_size: z.number().int(),
    sha256: z.string().max(64),
  })
  .strict();

export const privacyRequestBody = z
  .object({ tenant_id: uuid.optional(), type: z.enum(['access', 'erasure']), candidate_id: uuid })
  .strict();

export const sweepQuery = z
  .object({
    tenant_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

/** S3 / MinIO ObjectCreated notification, or a plain list of keys. */
export const storageEventBody = z.union([
  z.object({ keys: z.array(z.string().max(300)).min(1).max(100) }).strict(),
  z.object({
    Records: z
      .array(z.object({ s3: z.object({ object: z.object({ key: z.string().max(600) }) }) }))
      .min(1)
      .max(100),
  }),
]);

export function storageKeys(body: z.output<typeof storageEventBody>): string[] {
  // S3 notification keys are URL-encoded with '+' for spaces.
  return 'keys' in body
    ? body.keys
    : body.Records.map((r) => decodeURIComponent(r.s3.object.key.replace(/\+/g, ' ')));
}

export function parseIfMatch(header: string | undefined): number {
  if (!header)
    throw new PreconditionRequiredError(
      'IF_MATCH_REQUIRED',
      'Send If-Match with the ETag from your last read.',
    );
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(header.trim());
  if (!match?.[1])
    throw new PreconditionFailedError(
      'VERSION_MISMATCH',
      'If-Match does not match the current ETag.',
    );
  return Number(match[1]);
}

export const etag = (v: number): string => `"${v}"`;

export function attributesFrom(b: {
  user_id?: string | null | undefined;
  external_ref?: string | null | undefined;
  current_title?: string | null | undefined;
  job_profile_id?: string | null | undefined;
  department?: string | null | undefined;
  location_country?: string | null | undefined;
  total_experience_months?: number | null | undefined;
  marketplace_opt_in?: boolean | undefined;
  consent?: Record<string, unknown> | undefined;
  legal_hold?: boolean | undefined;
}) {
  return {
    ...(b.user_id !== undefined ? { userId: b.user_id } : {}),
    ...(b.external_ref !== undefined ? { externalRef: b.external_ref } : {}),
    ...(b.current_title !== undefined ? { currentTitle: b.current_title } : {}),
    ...(b.job_profile_id !== undefined ? { jobProfileId: b.job_profile_id } : {}),
    ...(b.department !== undefined ? { department: b.department } : {}),
    ...(b.location_country !== undefined ? { locationCountry: b.location_country } : {}),
    ...(b.total_experience_months !== undefined
      ? { totalExperienceMonths: b.total_experience_months }
      : {}),
    ...(b.marketplace_opt_in !== undefined ? { marketplaceOptIn: b.marketplace_opt_in } : {}),
    ...(b.consent !== undefined ? { consent: b.consent } : {}),
    ...(b.legal_hold !== undefined ? { legalHold: b.legal_hold } : {}),
  };
}
