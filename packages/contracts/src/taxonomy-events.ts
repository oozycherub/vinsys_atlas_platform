import { z } from 'zod';
import { defineEvent } from './event';

/** taxonomy-svc events (docs/prompts/03-taxonomy-svc.md §5). tenant_id is null for global taxonomy. */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

export const SKILL_NODE_TYPES = ['domain', 'subdomain', 'cluster', 'skill'] as const;
export type SkillNodeType = (typeof SKILL_NODE_TYPES)[number];

export const SKILL_CLASSIFICATIONS = [
  'technical',
  'functional',
  'soft',
  'tool',
  'ai',
  'emerging',
  'unclassified',
] as const;
export type SkillClassification = (typeof SKILL_CLASSIFICATIONS)[number];

export const SkillCreated = defineEvent(
  'taxonomy.skill.created.v1',
  'skill',
  z.object({
    tenant_id: uuid.nullable(),
    skill_id: uuid,
    node_type: z.enum(SKILL_NODE_TYPES),
    path: z.string(),
    name: z.string(),
    taxonomy_version: z.number().int().min(1),
    occurred_at: isoTime,
  }),
);

/** Consumers re-map stored references from skill_id to replaced_by (when not null). */
export const SkillDeprecated = defineEvent(
  'taxonomy.skill.deprecated.v1',
  'skill',
  z.object({
    tenant_id: uuid.nullable(),
    skill_id: uuid,
    replaced_by: uuid.nullable(),
    taxonomy_version: z.number().int().min(1),
    occurred_at: isoTime,
  }),
);

/** A release boundary: downstream re-normalisation (PRD §2.1) keys off this version. */
export const TaxonomyVersionPublished = defineEvent(
  'taxonomy.version.published.v1',
  'taxonomy',
  z.object({
    tenant_id: uuid.nullable(),
    version: z.number().int().min(1),
    changed_skills: z.number().int().min(0),
    published_by: z.string(),
    occurred_at: isoTime,
  }),
);

export const JobProfileUpdated = defineEvent(
  'taxonomy.job_profile.updated.v1',
  'job_profile',
  z.object({
    tenant_id: uuid,
    job_profile_id: uuid,
    version: z.number().int().min(1),
    status: z.enum(['draft', 'published', 'archived']),
    title: z.string(),
    skills: z.array(
      z.object({
        skill_id: uuid,
        weight: z.number().gt(0).lte(1),
        target_proficiency: z.number().min(0).max(5),
        must_have: z.boolean(),
      }),
    ),
    occurred_at: isoTime,
  }),
);
