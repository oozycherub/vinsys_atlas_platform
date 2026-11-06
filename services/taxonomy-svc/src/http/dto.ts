import { SKILL_CLASSIFICATIONS, SKILL_NODE_TYPES } from '@atlas/contracts';
import { PreconditionFailedError, PreconditionRequiredError } from '@atlas/platform';
import { z } from 'zod';
import { MAX_TERMS } from '../domain/normalize';

/** Request schemas for the HTTP adapter (mirrors openapi.yaml). Unknown fields are rejected. */
const uuid = z.string().uuid();
const aliases = z.array(z.string().min(1).max(100)).max(50);
const ltreePath = z
  .string()
  .regex(/^[a-z0-9_]{1,64}(\.[a-z0-9_]{1,64}){0,3}$/, 'dot-separated labels of a-z, 0-9, _');

export const tenantQuery = z.object({ tenant_id: uuid.optional() }).strict();

export const listSkillsQuery = z
  .object({
    tenant_id: uuid.optional(),
    path: ltreePath.optional(),
    q: z.string().trim().min(1).max(100).optional(),
    classification: z.enum(SKILL_CLASSIFICATIONS).optional(),
    node_type: z.enum(SKILL_NODE_TYPES).optional(),
    include_deprecated: z.enum(['true', 'false']).default('false'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(400).optional(),
  })
  .strict();

export const createSkillBody = z
  .object({
    node_type: z.enum(SKILL_NODE_TYPES),
    path: ltreePath,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    classification: z.enum(SKILL_CLASSIFICATIONS).optional(),
    aliases: aliases.optional(),
    external_id: z.string().max(200).nullable().optional(),
  })
  .strict();

export const patchSkillBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    classification: z.enum(SKILL_CLASSIFICATIONS).optional(),
    aliases: aliases.optional(),
    external_id: z.string().max(200).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required.');

export const deprecateBody = z.object({ replaced_by: uuid.nullable().default(null) }).strict();

export const overrideBody = z
  .object({
    hidden: z.boolean().default(false),
    adopted: z.boolean().default(false),
    display_name: z.string().min(1).max(200).nullable().default(null),
    aliases: aliases.default([]),
  })
  .strict();

export const edgeBody = z
  .object({
    src: uuid,
    dst: uuid,
    edge_type: z.enum(['RELATED_TO', 'PREREQUISITE_OF']),
    weight: z.number().gt(0).lte(1).default(1),
  })
  .strict();

export const edgeQuery = z
  .object({
    tenant_id: uuid.optional(),
    src: uuid,
    dst: uuid,
    edge_type: z.enum(['RELATED_TO', 'PREREQUISITE_OF']),
  })
  .strict();

export const normalizeBody = z
  .object({
    tenant_id: uuid.optional(),
    terms: z.array(z.string().max(200)).min(1).max(MAX_TERMS),
  })
  .strict();

export const reembedQuery = z
  .object({
    tenant_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .strict();

export const suggestionsQuery = z
  .object({
    tenant_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export const familyBody = z.object({ name: z.string().trim().min(1).max(200) }).strict();

export const roleBody = z
  .object({
    job_family_id: uuid,
    name: z.string().trim().min(1).max(200),
    level: z.string().trim().max(50).nullable().default(null),
  })
  .strict();

export const rolesQuery = z
  .object({ tenant_id: uuid.optional(), job_family_id: uuid.optional() })
  .strict();

export const createProfileBody = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(10_000).nullable().default(null),
    job_role_id: uuid.nullable().default(null),
  })
  .strict();

export const patchProfileBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).nullable().optional(),
    job_role_id: uuid.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required.');

export const profileSkillsBody = z
  .object({
    skills: z
      .array(
        z
          .object({
            skill_id: uuid,
            weight: z.number(),
            target_proficiency: z.number(),
            must_have: z.boolean().default(false),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export const listProfilesQuery = z
  .object({
    tenant_id: uuid.optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(400).optional(),
  })
  .strict();

/** `If-Match: "7"` → 7. Missing → 428, malformed → 412. */
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

export function parseOptionalIfMatch(header: string | undefined): number | undefined {
  return header ? parseIfMatch(header) : undefined;
}

export const etag = (version: number): string => `"${version}"`;

/** Splits `{uuid}:{verb}` (AIP-136) from one path segment. */
export function customMethod(segment: string): { id: string; method: string } {
  const i = segment.lastIndexOf(':');
  return i < 0
    ? { id: segment, method: '' }
    : { id: segment.slice(0, i), method: segment.slice(i + 1) };
}
