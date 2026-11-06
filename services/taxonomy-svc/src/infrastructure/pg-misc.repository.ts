import { Injectable } from '@nestjs/common';
import { type Tx } from '@atlas/platform';
import {
  type ImportBatch,
  type ImportRepository,
  type JobFamily,
  type JobRepository,
  type JobRole,
  type PurgeRepository,
  type Suggestion,
  type SuggestionRepository,
  type VersionRepository,
} from '../application/ports';
import { type JobProfile, type JobProfileSkill } from '../domain/job-profile';

const GLOBAL_SCOPE = '00000000-0000-0000-0000-000000000000';
const date = (v: Date | null): Date | null => (v ? new Date(v) : null);

@Injectable()
export class PgSuggestionRepository implements SuggestionRepository {
  async record(
    tx: Tx,
    tenantId: string,
    term: string,
    bestSkillId: string,
    score: number,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO unmapped_skill_suggestions (tenant_id, term, best_skill_id, best_score)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, term) DO UPDATE SET occurrences = unmapped_skill_suggestions.occurrences + 1,
         last_seen_at = now(), best_skill_id = EXCLUDED.best_skill_id, best_score = EXCLUDED.best_score`,
      [tenantId, term.slice(0, 200), bestSkillId, score],
    );
  }

  async list(tx: Tx, limit: number): Promise<Suggestion[]> {
    const { rows } = await tx.query<{
      term: string;
      best_skill_id: string | null;
      best_score: string | null;
      occurrences: number;
      last_seen_at: Date;
    }>(
      `SELECT term, best_skill_id, best_score::text AS best_score, occurrences, last_seen_at
       FROM unmapped_skill_suggestions WHERE tenant_id = current_tenant_id()
       ORDER BY occurrences DESC, last_seen_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      term: r.term,
      bestSkillId: r.best_skill_id,
      bestScore: r.best_score === null ? null : Number(r.best_score),
      occurrences: Number(r.occurrences),
      lastSeenAt: new Date(r.last_seen_at),
    }));
  }
}

@Injectable()
export class PgVersionRepository implements VersionRepository {
  async publishedVersion(tx: Tx, scopeTenantId: string | null): Promise<number> {
    const { rows } = await tx.query<{ v: number }>(
      `SELECT published_version AS v FROM taxonomy_versions WHERE scope_key = $1`,
      [scopeTenantId ?? GLOBAL_SCOPE],
    );
    return Number(rows[0]?.v ?? 0);
  }

  async publish(
    tx: Tx,
    scopeTenantId: string | null,
    version: number,
    by: string,
    at: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO taxonomy_versions (scope_key, published_version, published_at, published_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope_key) DO UPDATE SET published_version = EXCLUDED.published_version,
         published_at = EXCLUDED.published_at, published_by = EXCLUDED.published_by`,
      [scopeTenantId ?? GLOBAL_SCOPE, version, at, by],
    );
  }
}

interface ImportRow {
  batch_id: string;
  tenant_id: string | null;
  status: ImportBatch['status'];
  file_name: string;
  row_count: number;
  summary: ImportBatch['summary'];
  plan: ImportBatch['plan'];
  base_fingerprint: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  committed_at: Date | null;
}

@Injectable()
export class PgImportRepository implements ImportRepository {
  async insert(tx: Tx, b: ImportBatch): Promise<void> {
    await tx.query(
      `INSERT INTO taxonomy_import_batches (batch_id, tenant_id, status, file_name, row_count, summary, plan,
         base_fingerprint, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
      [
        b.id,
        b.tenantId,
        b.status,
        b.fileName,
        b.rowCount,
        JSON.stringify(b.summary),
        JSON.stringify(b.plan),
        b.baseFingerprint,
        b.createdBy,
        b.createdAt,
        b.expiresAt,
      ],
    );
  }

  async find(
    tx: Tx,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<ImportBatch | null> {
    const { rows } = await tx.query<ImportRow>(
      `SELECT batch_id, tenant_id, status, file_name, row_count, summary, plan, base_fingerprint, created_by,
         created_at, expires_at, committed_at
       FROM taxonomy_import_batches WHERE batch_id = $1 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const r = rows[0];
    return r
      ? {
          id: r.batch_id,
          tenantId: r.tenant_id,
          status: r.status,
          fileName: r.file_name,
          rowCount: Number(r.row_count),
          summary: r.summary,
          plan: r.plan,
          baseFingerprint: r.base_fingerprint,
          createdBy: r.created_by,
          createdAt: new Date(r.created_at),
          expiresAt: new Date(r.expires_at),
          committedAt: date(r.committed_at),
        }
      : null;
  }

  async markCommitted(tx: Tx, id: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE taxonomy_import_batches SET status = 'committed', committed_at = $2 WHERE batch_id = $1`,
      [id, at],
    );
  }
}

interface ProfileRow {
  tenant_id: string;
  job_profile_id: string;
  job_role_id: string | null;
  title: string;
  description: string | null;
  status: JobProfile['status'];
  version: number;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const PROFILE_COLUMNS = `tenant_id, job_profile_id, job_role_id, title, description, status, version, published_at,
  created_at, updated_at`;

/** Tenant-only tables: the caller's transaction carries the tenant context. */
@Injectable()
export class PgJobRepository implements JobRepository {
  async insertFamily(tx: Tx, f: JobFamily): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO job_families (tenant_id, job_family_id, name, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [f.tenantId, f.id, f.name, f.createdAt],
    );
    return rowCount === 1;
  }

  async listFamilies(tx: Tx): Promise<JobFamily[]> {
    const { rows } = await tx.query<{
      tenant_id: string;
      job_family_id: string;
      name: string;
      created_at: Date;
    }>(
      `SELECT tenant_id, job_family_id, name, created_at FROM job_families
       WHERE tenant_id = current_tenant_id() ORDER BY name`,
    );
    return rows.map((r) => ({
      id: r.job_family_id,
      tenantId: r.tenant_id,
      name: r.name,
      createdAt: new Date(r.created_at),
    }));
  }

  async findFamily(tx: Tx, id: string): Promise<JobFamily | null> {
    const { rows } = await tx.query<{
      tenant_id: string;
      job_family_id: string;
      name: string;
      created_at: Date;
    }>(
      `SELECT tenant_id, job_family_id, name, created_at FROM job_families
       WHERE job_family_id = $1 AND tenant_id = current_tenant_id()`,
      [id],
    );
    const r = rows[0];
    return r
      ? {
          id: r.job_family_id,
          tenantId: r.tenant_id,
          name: r.name,
          createdAt: new Date(r.created_at),
        }
      : null;
  }

  async insertRole(tx: Tx, r: JobRole): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO job_roles (tenant_id, job_role_id, job_family_id, name, level, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, job_family_id, name) DO NOTHING`,
      [r.tenantId, r.id, r.jobFamilyId, r.name, r.level, r.createdAt],
    );
    return rowCount === 1;
  }

  async listRoles(tx: Tx, familyId?: string): Promise<JobRole[]> {
    const { rows } = await tx.query<RoleRow>(
      `SELECT tenant_id, job_role_id, job_family_id, name, level, created_at FROM job_roles
       WHERE tenant_id = current_tenant_id() AND ($1::uuid IS NULL OR job_family_id = $1::uuid) ORDER BY name`,
      [familyId ?? null],
    );
    return rows.map(toRole);
  }

  async findRole(tx: Tx, id: string): Promise<JobRole | null> {
    const { rows } = await tx.query<RoleRow>(
      `SELECT tenant_id, job_role_id, job_family_id, name, level, created_at FROM job_roles
       WHERE job_role_id = $1 AND tenant_id = current_tenant_id()`,
      [id],
    );
    return rows[0] ? toRole(rows[0]) : null;
  }

  async insertProfile(tx: Tx, p: JobProfile): Promise<void> {
    await tx.query(
      `INSERT INTO job_profiles (${PROFILE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        p.tenantId,
        p.id,
        p.jobRoleId,
        p.title,
        p.description,
        p.status,
        p.version,
        p.publishedAt,
        p.createdAt,
        p.updatedAt,
      ],
    );
    await this.writeSkills(tx, p);
  }

  async findProfile(
    tx: Tx,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<JobProfile | null> {
    const { rows } = await tx.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM job_profiles WHERE job_profile_id = $1 AND tenant_id = current_tenant_id()
       ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    const skills = await this.skillsOf(tx, [r.job_profile_id]);
    return toProfile(r, skills.get(r.job_profile_id) ?? []);
  }

  async listProfiles(
    tx: Tx,
    f: { status?: JobProfile['status']; limit: number; after?: { createdAt: Date; id: string } },
  ): Promise<JobProfile[]> {
    const { rows } = await tx.query<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM job_profiles
       WHERE tenant_id = current_tenant_id() AND ($1::text IS NULL OR status = $1)
         AND ($2::timestamptz IS NULL OR (created_at, job_profile_id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, job_profile_id DESC LIMIT $4`,
      [f.status ?? null, f.after?.createdAt ?? null, f.after?.id ?? null, f.limit],
    );
    const skills = await this.skillsOf(
      tx,
      rows.map((r) => r.job_profile_id),
    );
    return rows.map((r) => toProfile(r, skills.get(r.job_profile_id) ?? []));
  }

  async updateProfile(
    tx: Tx,
    p: JobProfile,
    expectedVersion: number,
    withSkills: boolean,
  ): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE job_profiles SET job_role_id = $3, title = $4, description = $5, status = $6, version = $7,
         published_at = $8
       WHERE job_profile_id = $1 AND version = $2 AND tenant_id = current_tenant_id()`,
      [
        p.id,
        expectedVersion,
        p.jobRoleId,
        p.title,
        p.description,
        p.status,
        p.version,
        p.publishedAt,
      ],
    );
    if (rowCount !== 1) return false;
    if (withSkills) {
      await tx.query(
        `DELETE FROM job_profile_skills WHERE job_profile_id = $1 AND tenant_id = current_tenant_id()`,
        [p.id],
      );
      await this.writeSkills(tx, p);
    }
    return true;
  }

  private async writeSkills(tx: Tx, p: JobProfile): Promise<void> {
    if (p.skills.length === 0) return;
    await tx.query(
      `INSERT INTO job_profile_skills (tenant_id, job_profile_id, skill_id, weight, target_proficiency, must_have)
       SELECT $1, $2, x.skill_id, x.weight, x.target, x.must_have
       FROM unnest($3::uuid[], $4::numeric[], $5::numeric[], $6::boolean[]) AS x(skill_id, weight, target, must_have)`,
      [
        p.tenantId,
        p.id,
        p.skills.map((s) => s.skillId),
        p.skills.map((s) => s.weight),
        p.skills.map((s) => s.targetProficiency),
        p.skills.map((s) => s.mustHave),
      ],
    );
  }

  private async skillsOf(tx: Tx, ids: readonly string[]): Promise<Map<string, JobProfileSkill[]>> {
    const out = new Map<string, JobProfileSkill[]>();
    if (ids.length === 0) return out;
    const { rows } = await tx.query<{
      job_profile_id: string;
      skill_id: string;
      weight: string;
      target_proficiency: string;
      must_have: boolean;
    }>(
      `SELECT job_profile_id, skill_id, weight::text AS weight, target_proficiency::text AS target_proficiency, must_have
       FROM job_profile_skills WHERE job_profile_id = ANY($1::uuid[]) AND tenant_id = current_tenant_id()
       ORDER BY weight DESC, skill_id`,
      [[...ids]],
    );
    for (const r of rows) {
      const list = out.get(r.job_profile_id) ?? [];
      list.push({
        skillId: r.skill_id,
        weight: Number(r.weight),
        targetProficiency: Number(r.target_proficiency),
        mustHave: r.must_have,
      });
      out.set(r.job_profile_id, list);
    }
    return out;
  }
}

interface RoleRow {
  tenant_id: string;
  job_role_id: string;
  job_family_id: string;
  name: string;
  level: string | null;
  created_at: Date;
}

function toRole(r: RoleRow): JobRole {
  return {
    id: r.job_role_id,
    tenantId: r.tenant_id,
    jobFamilyId: r.job_family_id,
    name: r.name,
    level: r.level,
    createdAt: new Date(r.created_at),
  };
}

function toProfile(r: ProfileRow, skills: JobProfileSkill[]): JobProfile {
  return {
    id: r.job_profile_id,
    tenantId: r.tenant_id,
    jobRoleId: r.job_role_id,
    title: r.title,
    description: r.description,
    status: r.status,
    skills,
    version: Number(r.version),
    publishedAt: date(r.published_at),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

/**
 * Tenant purge. Every statement names `tenant_id = current_tenant_id()` explicitly: the consumer
 * runs in a system transaction, where RLS alone would also allow touching global rows.
 */
@Injectable()
export class PgPurgeRepository implements PurgeRepository {
  async purgeTenant(tx: Tx): Promise<Record<string, number>> {
    const tables = [
      'job_profile_skills',
      'job_profiles',
      'job_roles',
      'job_families',
      'unmapped_skill_suggestions',
      'tenant_skill_overrides',
      'taxonomy_import_batches',
      'taxonomy_versions',
      'skill_edges',
      'skills',
    ];
    const removed: Record<string, number> = {};
    for (const table of tables) {
      const { rowCount } = await tx.query(
        `DELETE FROM ${table} WHERE tenant_id = current_tenant_id()`,
      );
      removed[table] = rowCount;
    }
    return removed;
  }
}
