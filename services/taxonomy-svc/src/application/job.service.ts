import { Inject, Injectable } from '@nestjs/common';
import { JobProfileUpdated } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  DomainRuleError,
  isUuid,
  newId,
  NotFoundError,
  type Principal,
  type Tx,
  ValidationError,
} from '@atlas/platform';
import { TaxonomyDomainError } from '../domain/errors';
import {
  archiveJobProfile,
  createJobProfile,
  type JobProfile,
  type JobProfileSkill,
  patchJobProfile,
  publishJobProfile,
  setJobProfileSkills,
} from '../domain/job-profile';
import { assertVersion } from '../domain/skill';
import {
  JOB_REPOSITORY,
  type JobRepository,
  SKILL_REPOSITORY,
  type SkillRepository,
} from './ports';
import { inScope, readScope, tenantOnly, writeScope } from './scope';
import { translate } from './translate';
import {
  decodeCursor,
  encodeCursor,
  type JobProfileView,
  type Page,
  toFamilyView,
  toJobProfileView,
  toRoleView,
} from './views';

/** Job families → roles → profiles; a profile's required skills drive matching and gap analysis. */
@Injectable()
export class JobService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(JOB_REPOSITORY) private readonly jobs: JobRepository,
    @Inject(SKILL_REPOSITORY) private readonly skills: SkillRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async createFamily(principal: Principal, name: string, tenantHint?: string) {
    const scope = writeScope(principal, tenantHint);
    const tenantId = tenantOnly(scope);
    const family = { id: newId(), tenantId, name: name.trim(), createdAt: this.clock.now() };
    const ok = await inScope(this.db, scope, (tx) => this.jobs.insertFamily(tx, family));
    if (!ok) throw new ConflictError('JOB_FAMILY_EXISTS', 'A job family with this name exists.');
    return toFamilyView(family);
  }

  async listFamilies(principal: Principal, tenantHint?: string) {
    const scope = readScope(principal, tenantHint);
    tenantOnly(scope);
    return {
      items: (await inScope(this.db, scope, (tx) => this.jobs.listFamilies(tx))).map(toFamilyView),
    };
  }

  async createRole(
    principal: Principal,
    input: { jobFamilyId: string; name: string; level: string | null },
    tenantHint?: string,
  ) {
    const scope = writeScope(principal, tenantHint);
    const tenantId = tenantOnly(scope);
    const role = {
      id: newId(),
      tenantId,
      jobFamilyId: input.jobFamilyId,
      name: input.name.trim(),
      level: input.level,
      createdAt: this.clock.now(),
    };
    return inScope(this.db, scope, async (tx) => {
      if (!(await this.jobs.findFamily(tx, input.jobFamilyId))) {
        throw new NotFoundError('JOB_FAMILY_NOT_FOUND', 'Job family not found.');
      }
      if (!(await this.jobs.insertRole(tx, role))) {
        throw new ConflictError(
          'JOB_ROLE_EXISTS',
          'This family already has a role with this name.',
        );
      }
      return toRoleView(role);
    });
  }

  async listRoles(principal: Principal, familyId: string | undefined, tenantHint?: string) {
    const scope = readScope(principal, tenantHint);
    tenantOnly(scope);
    return {
      items: (await inScope(this.db, scope, (tx) => this.jobs.listRoles(tx, familyId))).map(
        toRoleView,
      ),
    };
  }

  async create(
    principal: Principal,
    input: { title: string; description: string | null; jobRoleId: string | null },
    tenantHint?: string,
  ): Promise<JobProfileView> {
    const scope = writeScope(principal, tenantHint);
    const tenantId = tenantOnly(scope);
    return inScope(this.db, scope, (tx) =>
      translate(async () => {
        await this.assertRole(tx, input.jobRoleId);
        const profile = createJobProfile({
          id: newId(),
          tenantId,
          ...input,
          now: this.clock.now(),
        });
        await this.jobs.insertProfile(tx, profile);
        return toJobProfileView(profile);
      }),
    );
  }

  async list(
    principal: Principal,
    query: { status?: JobProfile['status']; limit: number; cursor?: string },
    tenantHint?: string,
  ): Promise<Page<JobProfileView>> {
    const scope = readScope(principal, tenantHint);
    tenantOnly(scope);
    let after: { createdAt: Date; id: string } | undefined;
    if (query.cursor) {
      const parts = decodeCursor(query.cursor, 2);
      const at = parts?.[0] ? new Date(parts[0]) : null;
      if (!parts?.[1] || !at || Number.isNaN(at.getTime()) || !isUuid(parts[1])) {
        throw new ValidationError('The cursor is invalid.', [
          { path: 'query.cursor', message: 'Malformed cursor' },
        ]);
      }
      after = { createdAt: at, id: parts[1] };
    }
    const rows = await inScope(this.db, scope, (tx) =>
      this.jobs.listProfiles(tx, {
        limit: query.limit + 1,
        ...(query.status ? { status: query.status } : {}),
        ...(after ? { after } : {}),
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toJobProfileView),
      next_cursor:
        rows.length > query.limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    };
  }

  async get(principal: Principal, id: string, tenantHint?: string): Promise<JobProfileView> {
    const scope = readScope(principal, tenantHint);
    tenantOnly(scope);
    return inScope(this.db, scope, async (tx) => toJobProfileView(await this.load(tx, id)));
  }

  async patch(
    principal: Principal,
    id: string,
    patch: { title?: string; description?: string | null; jobRoleId?: string | null },
    ifMatch: number,
    tenantHint?: string,
  ): Promise<JobProfileView> {
    return this.mutate(principal, id, ifMatch, tenantHint, false, async (tx, profile, now) => {
      if (patch.jobRoleId) await this.assertRole(tx, patch.jobRoleId);
      return patchJobProfile(profile, patch, now);
    });
  }

  /** Replaces the required skills. Every skill must be an active leaf visible to the tenant. */
  async setSkills(
    principal: Principal,
    id: string,
    skills: readonly JobProfileSkill[],
    ifMatch: number,
    tenantHint?: string,
  ): Promise<JobProfileView> {
    return this.mutate(principal, id, ifMatch, tenantHint, true, async (tx, profile, now) => {
      const view = profile.tenantId;
      for (const s of skills) {
        const skill = isUuid(s.skillId) ? await this.skills.findById(tx, view, s.skillId) : null;
        if (!skill)
          throw new NotFoundError('SKILL_NOT_FOUND', `Skill ${s.skillId} is not available.`);
        if (skill.nodeType !== 'skill' || skill.deprecatedAt) {
          throw new DomainRuleError(
            'INVALID_PROFILE_SKILL',
            `"${skill.name}" is not an active leaf skill${skill.replacedBy ? '; use its successor' : ''}.`,
          );
        }
      }
      return setJobProfileSkills(profile, skills, now);
    });
  }

  async publish(
    principal: Principal,
    id: string,
    ifMatch: number | undefined,
    tenantHint?: string,
  ) {
    return this.mutate(principal, id, ifMatch, tenantHint, false, (_tx, p, now) =>
      Promise.resolve(publishJobProfile(p, now)),
    );
  }

  async archive(
    principal: Principal,
    id: string,
    ifMatch: number | undefined,
    tenantHint?: string,
  ) {
    return this.mutate(principal, id, ifMatch, tenantHint, false, (_tx, p, now) =>
      Promise.resolve(archiveJobProfile(p, now)),
    );
  }

  /** One transaction per change; published (and newly archived) profiles emit job_profile.updated. */
  private async mutate(
    principal: Principal,
    id: string,
    ifMatch: number | undefined,
    tenantHint: string | undefined,
    withSkills: boolean,
    change: (tx: Tx, profile: JobProfile, now: Date) => Promise<JobProfile>,
  ): Promise<JobProfileView> {
    const scope = writeScope(principal, tenantHint);
    const tenantId = tenantOnly(scope);
    return inScope(this.db, scope, (tx) =>
      translate(async () => {
        const current = await this.load(tx, id, true);
        if (ifMatch !== undefined) assertVersion(current, ifMatch);
        const now = this.clock.now();
        const next = await change(tx, current, now);
        if (!(await this.jobs.updateProfile(tx, next, current.version, withSkills))) {
          throw new TaxonomyDomainError(
            'precondition_failed',
            'VERSION_MISMATCH',
            'The job profile changed concurrently.',
          );
        }
        if (next.status !== 'draft' || current.status !== 'draft') {
          await appendOutbox(
            tx,
            JobProfileUpdated.build({
              tenantId,
              aggregateId: next.id,
              payload: {
                tenant_id: tenantId,
                job_profile_id: next.id,
                version: next.version,
                status: next.status,
                title: next.title,
                skills: next.skills.map((s) => ({
                  skill_id: s.skillId,
                  weight: s.weight,
                  target_proficiency: s.targetProficiency,
                  must_have: s.mustHave,
                })),
                occurred_at: now.toISOString(),
              },
            }),
          );
        }
        return toJobProfileView(next);
      }),
    );
  }

  private async load(tx: Tx, id: string, forUpdate = false): Promise<JobProfile> {
    const profile = isUuid(id) ? await this.jobs.findProfile(tx, id, { forUpdate }) : null;
    if (!profile) throw new NotFoundError('JOB_PROFILE_NOT_FOUND', 'Job profile not found.');
    return profile;
  }

  private async assertRole(tx: Tx, roleId: string | null): Promise<void> {
    if (roleId && !(await this.jobs.findRole(tx, roleId))) {
      throw new NotFoundError('JOB_ROLE_NOT_FOUND', 'Job role not found.');
    }
  }
}
