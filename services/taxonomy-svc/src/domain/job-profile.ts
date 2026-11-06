import { TaxonomyDomainError } from './errors';

export type JobProfileStatus = 'draft' | 'published' | 'archived';

export interface JobProfileSkill {
  readonly skillId: string;
  readonly weight: number;
  readonly targetProficiency: number;
  readonly mustHave: boolean;
}

export interface JobProfile {
  readonly id: string;
  readonly tenantId: string;
  readonly jobRoleId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: JobProfileStatus;
  readonly skills: readonly JobProfileSkill[];
  readonly version: number;
  readonly publishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const MAX_PROFILE_SKILLS = 200;

function assertTitle(title: string): string {
  const t = title.trim();
  if (t.length < 1 || t.length > 200) {
    throw new TaxonomyDomainError('validation', 'INVALID_TITLE', 'Title must be 1–200 characters.');
  }
  return t;
}

export function createJobProfile(input: {
  id: string;
  tenantId: string;
  jobRoleId: string | null;
  title: string;
  description: string | null;
  now: Date;
}): JobProfile {
  return {
    id: input.id,
    tenantId: input.tenantId,
    jobRoleId: input.jobRoleId,
    title: assertTitle(input.title),
    description: input.description?.trim() || null,
    status: 'draft',
    skills: [],
    version: 1,
    publishedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function assertEditable(profile: JobProfile): void {
  if (profile.status === 'archived') {
    throw new TaxonomyDomainError(
      'rule',
      'JOB_PROFILE_ARCHIVED',
      'An archived job profile cannot change.',
    );
  }
}

export function patchJobProfile(
  profile: JobProfile,
  patch: { title?: string; description?: string | null; jobRoleId?: string | null },
  now: Date,
): JobProfile {
  assertEditable(profile);
  return {
    ...profile,
    ...(patch.title !== undefined ? { title: assertTitle(patch.title) } : {}),
    ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
    ...(patch.jobRoleId !== undefined ? { jobRoleId: patch.jobRoleId } : {}),
    version: profile.version + 1,
    updatedAt: now,
  };
}

/**
 * Required skills (PRD §2.5): weight in (0, 1], target proficiency 0–5 in steps of 0.5, each
 * skill at most once. A published profile must keep at least one skill.
 */
export function setJobProfileSkills(
  profile: JobProfile,
  skills: readonly JobProfileSkill[],
  now: Date,
): JobProfile {
  assertEditable(profile);
  if (skills.length > MAX_PROFILE_SKILLS) {
    throw new TaxonomyDomainError(
      'validation',
      'TOO_MANY_SKILLS',
      `At most ${MAX_PROFILE_SKILLS} skills.`,
    );
  }
  const ids = new Set<string>();
  for (const s of skills) {
    if (ids.has(s.skillId)) {
      throw new TaxonomyDomainError(
        'validation',
        'DUPLICATE_SKILL',
        `Skill ${s.skillId} is listed twice.`,
      );
    }
    ids.add(s.skillId);
    if (!(s.weight > 0 && s.weight <= 1)) {
      throw new TaxonomyDomainError(
        'validation',
        'INVALID_WEIGHT',
        'Weights must be greater than 0 and at most 1.',
      );
    }
    if (
      s.targetProficiency < 0 ||
      s.targetProficiency > 5 ||
      !Number.isInteger(s.targetProficiency * 2)
    ) {
      throw new TaxonomyDomainError(
        'validation',
        'INVALID_TARGET_PROFICIENCY',
        'Target proficiency must be 0–5 in steps of 0.5.',
      );
    }
  }
  if (profile.status === 'published' && skills.length === 0) {
    throw new TaxonomyDomainError(
      'rule',
      'SKILLS_REQUIRED',
      'A published job profile needs at least one skill.',
    );
  }
  return { ...profile, skills: [...skills], version: profile.version + 1, updatedAt: now };
}

export function publishJobProfile(profile: JobProfile, now: Date): JobProfile {
  assertEditable(profile);
  if (profile.skills.length === 0) {
    throw new TaxonomyDomainError(
      'rule',
      'SKILLS_REQUIRED',
      'Add at least one skill before publishing.',
    );
  }
  return {
    ...profile,
    status: 'published',
    publishedAt: now,
    version: profile.version + 1,
    updatedAt: now,
  };
}

export function archiveJobProfile(profile: JobProfile, now: Date): JobProfile {
  assertEditable(profile);
  return { ...profile, status: 'archived', version: profile.version + 1, updatedAt: now };
}
