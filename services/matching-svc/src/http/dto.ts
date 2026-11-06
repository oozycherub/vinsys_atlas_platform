import { PreconditionFailedError, PreconditionRequiredError } from '@atlas/platform';
import { z } from 'zod';
import { REQUISITION_STATUSES } from '../domain/requisition';

const uuid = z.string().uuid();
const keywords = z.array(z.string().trim().min(1).max(60)).max(50);

export const createRequisitionBody = z
  .object({
    tenant_id: uuid.optional(),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).default(''),
    openings: z.number().int().min(1).max(1000).default(1),
    location: z.string().max(200).nullable().default(null),
    hiring_manager_id: uuid.nullable().default(null),
    job_profile_id: uuid.nullable().default(null),
    min_experience_years: z.number().min(0).max(60).nullable().default(null),
    keywords: keywords.default([]),
  })
  .strict();

export const patchRequisitionBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    openings: z.number().int().min(1).max(1000).optional(),
    location: z.string().max(200).nullable().optional(),
    hiring_manager_id: uuid.nullable().optional(),
    job_profile_id: uuid.nullable().optional(),
    min_experience_years: z.number().min(0).max(60).nullable().optional(),
    keywords: keywords.optional(),
    status: z.enum(REQUISITION_STATUSES).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Send at least one field.');

export const calibrateBody = z
  .object({
    skills: z
      .array(
        z
          .object({
            skill_id: uuid,
            weight: z.number().gt(0).lte(1),
            target: z.number().min(0).max(5),
            must_have: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .optional(),
  })
  .strict();

export const matchBody = z
  .object({
    tenant_id: uuid.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    filters: z
      .object({
        min_score: z.number().min(0).max(1).optional(),
        bands: z
          .array(z.enum(['strong', 'good', 'partial', 'weak']))
          .max(4)
          .optional(),
        exclude_candidate_ids: z.array(uuid).max(1000).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export const tenantQuery = z.object({ tenant_id: uuid.optional() }).strict();

export const listQuery = z
  .object({
    tenant_id: uuid.optional(),
    status: z.enum(REQUISITION_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(400).optional(),
  })
  .strict();

export const candidateMatchesQuery = z
  .object({
    tenant_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export function parseIfMatch(header: string | undefined): number {
  if (!header) {
    throw new PreconditionRequiredError(
      'IF_MATCH_REQUIRED',
      'Send If-Match with the ETag from your last read.',
    );
  }
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(header.trim());
  if (!match?.[1])
    throw new PreconditionFailedError('INVALID_IF_MATCH', 'If-Match must be an ETag such as "3".');
  return Number(match[1]);
}

export const etag = (v: number): string => `"${v}"`;
