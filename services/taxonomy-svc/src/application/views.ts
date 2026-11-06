import { type JobProfile } from '../domain/job-profile';
import { type Skill } from '../domain/skill';
import { type JobFamily, type JobRole, type RelatedSkill, type VisibleSkill } from './ports';

export interface SkillRef {
  skill_id: string;
  path: string;
  name: string;
  node_type: string;
}

export interface SkillView {
  skill_id: string;
  tenant_id: string | null;
  scope: 'global' | 'tenant';
  node_type: string;
  path: string;
  /** The tenant's display name if it renamed a global skill, else the canonical name. */
  name: string;
  canonical_name: string;
  description: string | null;
  classification: string;
  aliases: string[];
  external_id: string | null;
  taxonomy_version: number;
  deprecated_at: string | null;
  replaced_by: string | null;
  override: {
    hidden: boolean;
    adopted: boolean;
    display_name: string | null;
    aliases: string[];
  } | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SkillDetailView extends SkillView {
  ancestors: SkillRef[];
  related: (SkillRef & { edge_type: string; direction: string; weight: number })[];
  /** For a deprecated skill: the active skill at the end of its REPLACES chain. */
  successor: SkillRef | null;
}

export function toRef(skill: Skill): SkillRef {
  return { skill_id: skill.id, path: skill.path, name: skill.name, node_type: skill.nodeType };
}

export function toSkillView(skill: VisibleSkill | Skill): SkillView {
  const override = 'override' in skill ? skill.override : null;
  return {
    skill_id: skill.id,
    tenant_id: skill.tenantId,
    scope: skill.tenantId ? 'tenant' : 'global',
    node_type: skill.nodeType,
    path: skill.path,
    name: override?.displayName ?? skill.name,
    canonical_name: skill.name,
    description: skill.description,
    classification: skill.classification,
    aliases: [...new Set([...skill.aliases, ...(override?.aliases ?? [])])],
    external_id: skill.externalId,
    taxonomy_version: skill.taxonomyVersion,
    deprecated_at: skill.deprecatedAt?.toISOString() ?? null,
    replaced_by: skill.replacedBy,
    override: override
      ? {
          hidden: override.hidden,
          adopted: override.adopted,
          display_name: override.displayName,
          aliases: [...override.aliases],
        }
      : null,
    version: skill.version,
    created_at: skill.createdAt.toISOString(),
    updated_at: skill.updatedAt.toISOString(),
  };
}

export function toDetailView(
  skill: VisibleSkill,
  ancestors: Skill[],
  related: RelatedSkill[],
  successor: Skill | null,
): SkillDetailView {
  return {
    ...toSkillView(skill),
    ancestors: ancestors.map(toRef),
    related: related.map((r) => ({
      ...toRef(r.skill),
      edge_type: r.edgeType,
      direction: r.direction,
      weight: r.weight,
    })),
    successor: successor ? toRef(successor) : null,
  };
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface JobProfileView {
  job_profile_id: string;
  tenant_id: string;
  job_role_id: string | null;
  title: string;
  description: string | null;
  status: string;
  skills: { skill_id: string; weight: number; target_proficiency: number; must_have: boolean }[];
  version: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toJobProfileView(p: JobProfile): JobProfileView {
  return {
    job_profile_id: p.id,
    tenant_id: p.tenantId,
    job_role_id: p.jobRoleId,
    title: p.title,
    description: p.description,
    status: p.status,
    skills: p.skills.map((s) => ({
      skill_id: s.skillId,
      weight: s.weight,
      target_proficiency: s.targetProficiency,
      must_have: s.mustHave,
    })),
    version: p.version,
    published_at: p.publishedAt?.toISOString() ?? null,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export const toFamilyView = (f: JobFamily) => ({
  job_family_id: f.id,
  name: f.name,
  created_at: f.createdAt.toISOString(),
});

export const toRoleView = (r: JobRole) => ({
  job_role_id: r.id,
  job_family_id: r.jobFamilyId,
  name: r.name,
  level: r.level,
  created_at: r.createdAt.toISOString(),
});

export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string, size: number): string[] | null {
  try {
    const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(parts) ||
      parts.length !== size ||
      !parts.every((p) => typeof p === 'string')
    ) {
      return null;
    }
    return parts as string[];
  } catch {
    return null;
  }
}
