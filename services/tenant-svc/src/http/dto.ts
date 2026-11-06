import { ISOLATION_TIERS, TENANT_STATUSES } from '@atlas/contracts';
import { PreconditionFailedError, PreconditionRequiredError } from '@atlas/platform';
import { z } from 'zod';
import { SLUG_PATTERN } from '../domain/slug';

/** Request schemas for the HTTP adapter (mirrors openapi.yaml). Unknown fields are rejected. */
export const createTenantBody = z
  .object({
    slug: z.string().regex(SLUG_PATTERN, 'must be 3–63 lowercase letters, digits or hyphens'),
    display_name: z.string().trim().min(1).max(200),
    data_region: z.string().min(1).max(32),
    isolation_tier: z.enum(ISOLATION_TIERS).default('pooled'),
    /** identity-svc invites this address as the first tenant_admin (not stored here). */
    bootstrap_admin_email: z.string().trim().toLowerCase().email().max(254).optional(),
  })
  .strict();

export const listTenantsQuery = z
  .object({
    status: z.enum(TENANT_STATUSES).optional(),
    data_region: z.string().max(32).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const patchTenantBody = z
  .object({ display_name: z.string().trim().min(1).max(200) })
  .strict();

export const settingsBody = z
  .object({
    limits: z
      .object({
        api_rps: z.number().int().min(1).max(10_000),
        parse_concurrency: z.number().int().min(1).max(500),
        sandbox_concurrency: z.number().int().min(1).max(2_000),
      })
      .strict(),
    matching: z
      .object({
        weights: z
          .object({
            sem: z.number().min(0).max(1),
            cov: z.number().min(0).max(1),
            exp: z.number().min(0).max(1),
            lex: z.number().min(0).max(1),
          })
          .strict(),
      })
      .strict(),
    features: z.record(z.string().max(100), z.boolean()).default({}),
    compliance: z
      .object({ jurisdictions: z.array(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/)).max(50) })
      .strict(),
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .default('en'),
  })
  .strict();

export const retentionPolicyBody = z
  .object({
    candidate_inactive_days: z.number().int().min(30).max(3650),
    proctoring_frames_days: z.number().int().min(1).max(365),
    interview_audio_days: z.number().int().min(1).max(1095),
    assessment_reports_days: z.number().int().min(30).max(3650),
  })
  .strict();

export const lifecycleBody = z
  .object({ reason: z.string().trim().min(1).max(1000).optional() })
  .strict()
  .default({});

export const resolveQuery = z.object({ slug: z.string().regex(SLUG_PATTERN) }).strict();

/** Parses `If-Match: "7"` (or W/"7") into a version number. Missing → 428, malformed → 412. */
export function parseIfMatch(header: string | undefined): number {
  if (!header) {
    throw new PreconditionRequiredError(
      'IF_MATCH_REQUIRED',
      'Send If-Match with the ETag from your last read.',
    );
  }
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(header.trim());
  if (!match?.[1]) {
    throw new PreconditionFailedError(
      'VERSION_MISMATCH',
      'If-Match does not match the current ETag.',
    );
  }
  return Number(match[1]);
}

/** For custom methods: If-Match is optional, but when sent it must match (prevents double-apply on retry). */
export function parseOptionalIfMatch(header: string | undefined): number | undefined {
  return header ? parseIfMatch(header) : undefined;
}

export function etag(version: number): string {
  return `"${version}"`;
}
