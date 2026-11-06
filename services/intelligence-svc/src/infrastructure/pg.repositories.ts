/** Postgres persistence (SQL first, ADR-0004). Numerics come back as float8, dates as text. */
import { Injectable } from '@nestjs/common';
import { type Tx } from '@atlas/platform';
import { type LearningItem, type Transition } from '../domain/career';
import { type DemandInput, type RowError } from '../domain/demand';
import { type ApplicationStatus } from '../domain/opportunity';
import {
  type AllocationRow,
  type Application,
  type AttritionRepository,
  CapacityExceededError,
  type CatalogueRepository,
  DEFAULT_POLICY,
  type DemandRepository,
  type Employee,
  type EmployeeRepository,
  type EmployeeSkillRow,
  type JobProfileRow,
  type MatchRow,
  type Opportunity,
  type OpportunityRepository,
  type Policy,
  type Project,
  type ProjectRepository,
  type RoleGapRow,
  type WorkItem,
  type WorkQueue,
} from '../application/ports';

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const json = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

// --- Employees ------------------------------------------------------------------------------

const EMPLOYEE_COLUMNS = `tenant_id::text, employee_id::text, user_id, manager_user_id, department, location,
  job_profile_id::text, hired_at::text, role_started_at::text, last_promotion_at::text,
  manager_changed_at::text, compa_ratio::float8, engagement_delta::float8, overtime_hours_4w::float8,
  marketplace_opt_in, status, terminated_at::text, termination_voluntary, source_synced_at`;

function toEmployee(r: Row): Employee {
  return {
    tenantId: String(r['tenant_id']),
    employeeId: String(r['employee_id']),
    userId: str(r['user_id']),
    managerUserId: str(r['manager_user_id']),
    department: str(r['department']),
    location: str(r['location']),
    jobProfileId: str(r['job_profile_id']),
    hiredAt: str(r['hired_at']),
    roleStartedAt: str(r['role_started_at']),
    lastPromotionAt: str(r['last_promotion_at']),
    managerChangedAt: str(r['manager_changed_at']),
    compaRatio: numOrNull(r['compa_ratio']),
    engagementDelta: numOrNull(r['engagement_delta']),
    overtimeHours4w: numOrNull(r['overtime_hours_4w']),
    marketplaceOptIn: Boolean(r['marketplace_opt_in']),
    status: r['status'] as Employee['status'],
    terminatedAt: str(r['terminated_at']),
    terminationVoluntary:
      r['termination_voluntary'] === null ? null : Boolean(r['termination_voluntary']),
    sourceSyncedAt: new Date(r['source_synced_at'] as string),
  };
}

@Injectable()
export class PgEmployeeRepository implements EmployeeRepository {
  async upsert(tx: Tx, e: Employee): Promise<{ previous: Employee | null }> {
    const previous = await this.get(tx, e.employeeId);
    await tx.query(
      `INSERT INTO intel_employees (tenant_id, employee_id, user_id, manager_user_id, department, location,
         job_profile_id, hired_at, role_started_at, last_promotion_at, manager_changed_at, compa_ratio,
         engagement_delta, overtime_hours_4w, marketplace_opt_in, status, terminated_at,
         termination_voluntary, source_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (tenant_id, employee_id) DO UPDATE SET
         user_id = EXCLUDED.user_id, manager_user_id = EXCLUDED.manager_user_id,
         department = EXCLUDED.department, location = EXCLUDED.location,
         job_profile_id = EXCLUDED.job_profile_id, hired_at = EXCLUDED.hired_at,
         role_started_at = EXCLUDED.role_started_at, last_promotion_at = EXCLUDED.last_promotion_at,
         manager_changed_at = EXCLUDED.manager_changed_at, compa_ratio = EXCLUDED.compa_ratio,
         engagement_delta = EXCLUDED.engagement_delta, overtime_hours_4w = EXCLUDED.overtime_hours_4w,
         marketplace_opt_in = EXCLUDED.marketplace_opt_in, status = EXCLUDED.status,
         terminated_at = EXCLUDED.terminated_at, termination_voluntary = EXCLUDED.termination_voluntary,
         source_synced_at = EXCLUDED.source_synced_at`,
      [
        e.tenantId,
        e.employeeId,
        e.userId,
        e.managerUserId,
        e.department,
        e.location,
        e.jobProfileId,
        e.hiredAt,
        e.roleStartedAt,
        e.lastPromotionAt,
        e.managerChangedAt,
        e.compaRatio,
        e.engagementDelta,
        e.overtimeHours4w,
        e.marketplaceOptIn,
        e.status,
        e.terminatedAt,
        e.terminationVoluntary,
        e.sourceSyncedAt,
      ],
    );
    return { previous };
  }

  async get(tx: Tx, id: string): Promise<Employee | null> {
    const r = await tx.query(
      `SELECT ${EMPLOYEE_COLUMNS} FROM intel_employees WHERE employee_id = $1`,
      [id],
    );
    return r.rows[0] ? toEmployee(r.rows[0]) : null;
  }

  async byUser(tx: Tx, userId: string): Promise<Employee | null> {
    const r = await tx.query(`SELECT ${EMPLOYEE_COLUMNS} FROM intel_employees WHERE user_id = $1`, [
      userId,
    ]);
    return r.rows[0] ? toEmployee(r.rows[0]) : null;
  }

  async active(tx: Tx, ids?: readonly string[]): Promise<Employee[]> {
    const r = ids
      ? await tx.query(
          `SELECT ${EMPLOYEE_COLUMNS} FROM intel_employees WHERE status = 'active' AND employee_id = ANY($1::uuid[])`,
          [ids],
        )
      : await tx.query(
          `SELECT ${EMPLOYEE_COLUMNS} FROM intel_employees WHERE status = 'active' ORDER BY employee_id`,
        );
    return r.rows.map(toEmployee);
  }

  async byJobProfile(tx: Tx, jobProfileId: string): Promise<string[]> {
    const r = await tx.query<{ id: string }>(
      `SELECT employee_id::text AS id FROM intel_employees WHERE job_profile_id = $1 AND status = 'active'`,
      [jobProfileId],
    );
    return r.rows.map((x) => x.id);
  }

  async setProtected(
    tx: Tx,
    employeeId: string,
    attributes: Record<string, string>,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO intel_employee_protected (tenant_id, employee_id, attributes)
       VALUES (current_tenant_id(), $1, $2)
       ON CONFLICT (tenant_id, employee_id) DO UPDATE SET attributes = EXCLUDED.attributes, updated_at = now()`,
      [employeeId, JSON.stringify(attributes)],
    );
  }

  async skills(tx: Tx, ids: readonly string[]): Promise<Map<string, EmployeeSkillRow[]>> {
    const out = new Map<string, EmployeeSkillRow[]>();
    if (ids.length === 0) return out;
    const r = await tx.query(
      `SELECT employee_id::text, skill_id::text, proficiency::float8, is_validated
       FROM intel_employee_skills WHERE employee_id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of r.rows) {
      const id = String(row['employee_id']);
      out.set(id, [
        ...(out.get(id) ?? []),
        {
          skillId: String(row['skill_id']),
          proficiency: num(row['proficiency']),
          validated: Boolean(row['is_validated']),
        },
      ]);
    }
    return out;
  }

  async withAnySkill(tx: Tx, skillIds: readonly string[]): Promise<Set<string>> {
    if (skillIds.length === 0) return new Set();
    const r = await tx.query<{ id: string }>(
      `SELECT DISTINCT employee_id::text AS id FROM intel_employee_skills WHERE skill_id = ANY($1::uuid[])`,
      [skillIds],
    );
    return new Set(r.rows.map((x) => x.id));
  }

  async replaceSkills(
    tx: Tx,
    employeeId: string,
    skills: readonly EmployeeSkillRow[],
  ): Promise<void> {
    await tx.query(`DELETE FROM intel_employee_skills WHERE employee_id = $1`, [employeeId]);
    for (const s of skills) {
      await tx.query(
        `INSERT INTO intel_employee_skills (tenant_id, employee_id, skill_id, proficiency, is_validated)
         VALUES (current_tenant_id(), $1, $2, $3, $4)`,
        [employeeId, s.skillId, s.proficiency, s.validated],
      );
    }
  }

  async upsertRequisitionScores(
    tx: Tx,
    employeeId: string,
    scores: readonly { requisitionId: string; score: number; band: string }[],
    at: Date,
  ): Promise<void> {
    for (const s of scores) {
      await tx.query(
        `INSERT INTO intel_requisition_scores (tenant_id, employee_id, requisition_id, score, band, computed_at)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, employee_id, requisition_id) DO UPDATE
         SET score = EXCLUDED.score, band = EXCLUDED.band, computed_at = EXCLUDED.computed_at
         WHERE intel_requisition_scores.computed_at <= EXCLUDED.computed_at`,
        [employeeId, s.requisitionId, s.score, s.band, at],
      );
    }
  }

  async requisitionScores(tx: Tx, requisitionId: string): Promise<Map<string, number>> {
    const r = await tx.query(
      `SELECT employee_id::text, score::float8 FROM intel_requisition_scores WHERE requisition_id = $1`,
      [requisitionId],
    );
    return new Map(r.rows.map((x) => [String(x['employee_id']), num(x['score'])]));
  }

  async saveRoleGap(tx: Tx, g: RoleGapRow, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO employee_role_gaps (tenant_id, employee_id, job_profile_id, role_gap_pct, readiness, gaps,
         department, location, computed_at)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, employee_id) DO UPDATE SET job_profile_id = EXCLUDED.job_profile_id,
         role_gap_pct = EXCLUDED.role_gap_pct, readiness = EXCLUDED.readiness, gaps = EXCLUDED.gaps,
         department = EXCLUDED.department, location = EXCLUDED.location, computed_at = EXCLUDED.computed_at`,
      [
        g.employeeId,
        g.jobProfileId,
        g.roleGapPct,
        g.readiness,
        JSON.stringify(g.gaps),
        g.department,
        g.location,
        at,
      ],
    );
  }

  private toGap(r: Row): RoleGapRow {
    return {
      employeeId: String(r['employee_id']),
      jobProfileId: String(r['job_profile_id']),
      roleGapPct: num(r['role_gap_pct']),
      readiness: num(r['readiness']),
      gaps: json(r['gaps']),
      department: str(r['department']),
      location: str(r['location']),
    };
  }

  async deleteRoleGap(tx: Tx, employeeId: string): Promise<RoleGapRow | null> {
    const r = await tx.query(
      `DELETE FROM employee_role_gaps WHERE employee_id = $1
       RETURNING employee_id::text, job_profile_id::text, role_gap_pct::float8, readiness::float8, gaps, department, location`,
      [employeeId],
    );
    return r.rows[0] ? this.toGap(r.rows[0]) : null;
  }

  async roleGap(tx: Tx, employeeId: string): Promise<RoleGapRow | null> {
    const r = await tx.query(
      `SELECT employee_id::text, job_profile_id::text, role_gap_pct::float8, readiness::float8, gaps, department, location
       FROM employee_role_gaps WHERE employee_id = $1`,
      [employeeId],
    );
    return r.rows[0] ? this.toGap(r.rows[0]) : null;
  }

  async refreshGaps(tx: Tx, dimension: string, groups: string[] | null): Promise<number> {
    const r = await tx.query<{ n: number }>(
      `SELECT intel_refresh_skill_gaps($1, $2::text[]) AS n`,
      [dimension, groups],
    );
    return num(r.rows[0]?.n ?? 0);
  }

  async heatmap(tx: Tx, dimension: string, month: string) {
    const r = await tx.query(
      `SELECT group_key, skill_id::text, employees, gap_sum::float8, req_sum::float8
       FROM skill_gap_aggregates WHERE dimension = $1 AND period_month = $2::date`,
      [dimension, month],
    );
    return r.rows.map((x) => ({
      groupKey: String(x['group_key']),
      skillId: String(x['skill_id']),
      employees: num(x['employees']),
      gapSum: num(x['gap_sum']),
      reqSum: num(x['req_sum']),
    }));
  }

  async policy(tx: Tx): Promise<Policy> {
    const r = await tx.query(
      `SELECT applications_visible_to_manager, learning_hours_per_day::float8, attrition_threshold::float8
       FROM intel_tenant_policies`,
    );
    const row = r.rows[0];
    if (!row) return { ...DEFAULT_POLICY };
    return {
      applicationsVisibleToManager: Boolean(row['applications_visible_to_manager']),
      learningHoursPerDay: num(row['learning_hours_per_day']),
      attritionThreshold: num(row['attrition_threshold']),
    };
  }

  async setPolicy(tx: Tx, p: Policy, by: string): Promise<void> {
    await tx.query(
      `INSERT INTO intel_tenant_policies (tenant_id, applications_visible_to_manager, learning_hours_per_day,
         attrition_threshold, updated_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET applications_visible_to_manager = EXCLUDED.applications_visible_to_manager,
         learning_hours_per_day = EXCLUDED.learning_hours_per_day, attrition_threshold = EXCLUDED.attrition_threshold,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [p.applicationsVisibleToManager, p.learningHoursPerDay, p.attritionThreshold, by],
    );
  }

  async erase(tx: Tx, employeeId: string): Promise<number> {
    let n = 0;
    for (const table of [
      'intel_employee_skills',
      'intel_requisition_scores',
      'employee_role_gaps',
      'intel_employees',
    ]) {
      n += (await tx.query(`DELETE FROM ${table} WHERE employee_id = $1`, [employeeId])).rowCount;
    }
    return n;
  }
}

// --- Catalogue --------------------------------------------------------------------------------

@Injectable()
export class PgCatalogueRepository implements CatalogueRepository {
  async upsertProfile(tx: Tx, p: JobProfileRow): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO intel_job_profiles (tenant_id, job_profile_id, version, status, title, skills)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, job_profile_id) DO UPDATE SET version = EXCLUDED.version,
         status = EXCLUDED.status, title = EXCLUDED.title, skills = EXCLUDED.skills, updated_at = now()
       WHERE intel_job_profiles.version <= EXCLUDED.version`,
      [p.jobProfileId, p.version, p.status, p.title, JSON.stringify(p.skills)],
    );
    return r.rowCount === 1;
  }

  private toProfile(r: Row): JobProfileRow {
    return {
      jobProfileId: String(r['job_profile_id']),
      version: num(r['version']),
      status: String(r['status']),
      title: String(r['title']),
      skills: json(r['skills']),
    };
  }

  async profile(tx: Tx, id: string): Promise<JobProfileRow | null> {
    const r = await tx.query(
      `SELECT job_profile_id::text, version, status, title, skills FROM intel_job_profiles WHERE job_profile_id = $1`,
      [id],
    );
    return r.rows[0] ? this.toProfile(r.rows[0]) : null;
  }

  async profiles(tx: Tx, ids: readonly string[]): Promise<Map<string, JobProfileRow>> {
    const valid = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
    if (valid.length === 0) return new Map();
    const r = await tx.query(
      `SELECT job_profile_id::text, version, status, title, skills FROM intel_job_profiles
       WHERE job_profile_id = ANY($1::uuid[])`,
      [valid],
    );
    return new Map(r.rows.map((x) => [String(x['job_profile_id']), this.toProfile(x)]));
  }

  async transitions(tx: Tx): Promise<Transition[]> {
    const r = await tx.query(
      `SELECT from_profile_id::text, to_profile_id::text, transition_type, typical_months
       FROM job_profile_transitions ORDER BY from_profile_id, to_profile_id`,
    );
    return r.rows.map((x) => ({
      from: String(x['from_profile_id']),
      to: String(x['to_profile_id']),
      type: x['transition_type'] as Transition['type'],
      typicalMonths: numOrNull(x['typical_months']),
    }));
  }

  async putTransition(tx: Tx, t: Transition): Promise<void> {
    await tx.query(
      `INSERT INTO job_profile_transitions (tenant_id, from_profile_id, to_profile_id, transition_type, typical_months)
       VALUES (current_tenant_id(), $1, $2, $3, $4)
       ON CONFLICT (tenant_id, from_profile_id, to_profile_id) DO UPDATE
       SET transition_type = EXCLUDED.transition_type, typical_months = EXCLUDED.typical_months`,
      [t.from, t.to, t.type, t.typicalMonths],
    );
  }

  async deleteTransition(tx: Tx, from: string, to: string): Promise<boolean> {
    const r = await tx.query(
      `DELETE FROM job_profile_transitions WHERE from_profile_id = $1 AND to_profile_id = $2`,
      [from, to],
    );
    return r.rowCount === 1;
  }

  async learningItems(tx: Tx): Promise<LearningItem[]> {
    const r = await tx.query(
      `SELECT item_id::text, title, skill_ids::text[] AS skill_ids, duration_hours::float8
       FROM learning_items WHERE active ORDER BY title, item_id`,
    );
    return r.rows.map((x) => ({
      item_id: String(x['item_id']),
      title: String(x['title']),
      skill_ids: x['skill_ids'] as string[],
      duration_hours: num(x['duration_hours']),
    }));
  }

  async putLearningItem(
    tx: Tx,
    i: LearningItem & { provider: string | null; url: string | null; external_ref: string | null },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO learning_items (tenant_id, item_id, title, provider, url, skill_ids, duration_hours, external_ref)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5::uuid[], $6, $7)
       ON CONFLICT (tenant_id, item_id) DO UPDATE SET title = EXCLUDED.title, provider = EXCLUDED.provider,
         url = EXCLUDED.url, skill_ids = EXCLUDED.skill_ids, duration_hours = EXCLUDED.duration_hours,
         external_ref = EXCLUDED.external_ref`,
      [i.item_id, i.title, i.provider, i.url, i.skill_ids, i.duration_hours, i.external_ref],
    );
  }
}

// --- Opportunities ----------------------------------------------------------------------------

const OPPORTUNITY_COLUMNS = `tenant_id::text, opportunity_id::text, type, title, description, job_profile_id::text,
  requisition_id::text, project_id::text, skills, allocation_pct, start_date::text, end_date::text, location,
  min_tenure_months, status, owner_user_id, embedding, embedding_model, published_at, created_at, version`;

function toOpportunity(r: Row): Opportunity {
  return {
    tenantId: String(r['tenant_id']),
    id: String(r['opportunity_id']),
    type: r['type'] as Opportunity['type'],
    title: String(r['title']),
    description: String(r['description']),
    jobProfileId: str(r['job_profile_id']),
    requisitionId: str(r['requisition_id']),
    projectId: str(r['project_id']),
    skills: json(r['skills']),
    allocationPct: num(r['allocation_pct']),
    startDate: String(r['start_date']),
    endDate: str(r['end_date']),
    location: str(r['location']),
    minTenureMonths: num(r['min_tenure_months']),
    status: r['status'] as Opportunity['status'],
    ownerUserId: String(r['owner_user_id']),
    embedding: r['embedding'] === null ? null : json(r['embedding']),
    embeddingModel: str(r['embedding_model']),
    publishedAt: r['published_at'] ? new Date(r['published_at'] as string) : null,
    createdAt: new Date(r['created_at'] as string),
    version: num(r['version']),
  };
}

const MATCH_COLUMNS = `employee_id::text, score::float8, availability::float8, score_internal::float8,
  readiness::float8, explanation, low_confidence, stale, computed_at`;

function toMatch(r: Row): MatchRow {
  return {
    employeeId: String(r['employee_id']),
    score: num(r['score']),
    availability: num(r['availability']),
    scoreInternal: num(r['score_internal']),
    readiness: num(r['readiness']),
    explanation: json(r['explanation']),
    lowConfidence: Boolean(r['low_confidence']),
    stale: Boolean(r['stale']),
    computedAt: new Date(r['computed_at'] as string),
  };
}

const APPLICATION_COLUMNS = `tenant_id::text, application_id::text, opportunity_id::text, employee_id::text, kind,
  status, note, disclosed_to_manager, created_by, decided_by, decided_at, allocation_id::text, created_at`;

function toApplication(r: Row): Application {
  return {
    tenantId: String(r['tenant_id']),
    id: String(r['application_id']),
    opportunityId: String(r['opportunity_id']),
    employeeId: String(r['employee_id']),
    kind: r['kind'] as Application['kind'],
    status: r['status'] as ApplicationStatus,
    note: str(r['note']),
    disclosedToManager: Boolean(r['disclosed_to_manager']),
    createdBy: String(r['created_by']),
    decidedBy: str(r['decided_by']),
    decidedAt: r['decided_at'] ? new Date(r['decided_at'] as string) : null,
    allocationId: str(r['allocation_id']),
    createdAt: new Date(r['created_at'] as string),
  };
}

@Injectable()
export class PgOpportunityRepository implements OpportunityRepository {
  async insert(tx: Tx, o: Opportunity): Promise<void> {
    await tx.query(
      `INSERT INTO opportunities (tenant_id, opportunity_id, type, title, description, job_profile_id, requisition_id,
         project_id, skills, allocation_pct, start_date, end_date, location, min_tenure_months, status, owner_user_id,
         created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        o.tenantId,
        o.id,
        o.type,
        o.title,
        o.description,
        o.jobProfileId,
        o.requisitionId,
        o.projectId,
        JSON.stringify(o.skills),
        o.allocationPct,
        o.startDate,
        o.endDate,
        o.location,
        o.minTenureMonths,
        o.status,
        o.ownerUserId,
        o.createdAt,
      ],
    );
  }

  async get(tx: Tx, id: string): Promise<Opportunity | null> {
    const r = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities WHERE opportunity_id = $1`,
      [id],
    );
    return r.rows[0] ? toOpportunity(r.rows[0]) : null;
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    f: Partial<Pick<Opportunity, 'status' | 'publishedAt' | 'embedding' | 'embeddingModel'>>,
  ): Promise<Opportunity | null> {
    const r = await tx.query(
      `UPDATE opportunities SET
         status = COALESCE($3, status),
         published_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE published_at END,
         embedding = CASE WHEN $6::boolean THEN $7::jsonb ELSE embedding END,
         embedding_model = CASE WHEN $6::boolean THEN $8 ELSE embedding_model END,
         version = version + 1
       WHERE opportunity_id = $1 AND version = $2
       RETURNING ${OPPORTUNITY_COLUMNS}`,
      [
        id,
        version,
        f.status ?? null,
        f.publishedAt !== undefined,
        f.publishedAt ?? null,
        f.embedding !== undefined,
        f.embedding === undefined ? null : JSON.stringify(f.embedding),
        f.embeddingModel ?? null,
      ],
    );
    return r.rows[0] ? toOpportunity(r.rows[0]) : null;
  }

  async open(tx: Tx): Promise<Opportunity[]> {
    const r = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities WHERE status = 'open' ORDER BY start_date`,
    );
    return r.rows.map(toOpportunity);
  }

  async openByRequisition(tx: Tx, requisitionId: string): Promise<Opportunity[]> {
    const r = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities WHERE status = 'open' AND requisition_id = $1`,
      [requisitionId],
    );
    return r.rows.map(toOpportunity);
  }

  async openByJobProfile(tx: Tx, jobProfileId: string): Promise<Opportunity[]> {
    const r = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS} FROM opportunities WHERE status IN ('draft', 'open') AND job_profile_id = $1`,
      [jobProfileId],
    );
    return r.rows.map(toOpportunity);
  }

  private async writeMatch(tx: Tx, opportunityId: string, m: MatchRow): Promise<void> {
    await tx.query(
      `INSERT INTO opportunity_matches (tenant_id, opportunity_id, employee_id, score, availability, score_internal,
         readiness, explanation, low_confidence, stale, computed_at)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, opportunity_id, employee_id) DO UPDATE SET score = EXCLUDED.score,
         availability = EXCLUDED.availability, score_internal = EXCLUDED.score_internal,
         readiness = EXCLUDED.readiness, explanation = EXCLUDED.explanation,
         low_confidence = EXCLUDED.low_confidence, stale = EXCLUDED.stale, computed_at = EXCLUDED.computed_at`,
      [
        opportunityId,
        m.employeeId,
        m.score,
        m.availability,
        m.scoreInternal,
        m.readiness,
        JSON.stringify(m.explanation),
        m.lowConfidence,
        m.stale,
        m.computedAt,
      ],
    );
  }

  async replaceMatches(tx: Tx, opportunityId: string, matches: readonly MatchRow[]): Promise<void> {
    await tx.query(`DELETE FROM opportunity_matches WHERE opportunity_id = $1`, [opportunityId]);
    for (const m of matches) await this.writeMatch(tx, opportunityId, m);
  }

  /** One employee's match changed: write it (or remove it), keeping the 200 best. */
  async upsertMatch(
    tx: Tx,
    opportunityId: string,
    m: MatchRow | null,
    employeeId: string,
  ): Promise<void> {
    if (m === null) {
      await tx.query(
        `DELETE FROM opportunity_matches WHERE opportunity_id = $1 AND employee_id = $2`,
        [opportunityId, employeeId],
      );
      return;
    }
    await this.writeMatch(tx, opportunityId, m);
    await tx.query(
      `DELETE FROM opportunity_matches WHERE opportunity_id = $1 AND employee_id IN (
         SELECT employee_id FROM opportunity_matches WHERE opportunity_id = $1
         ORDER BY score_internal DESC, score DESC, employee_id OFFSET 200)`,
      [opportunityId],
    );
  }

  async matches(tx: Tx, opportunityId: string, limit: number): Promise<MatchRow[]> {
    const r = await tx.query(
      `SELECT ${MATCH_COLUMNS} FROM opportunity_matches WHERE opportunity_id = $1
       ORDER BY score_internal DESC, score DESC, employee_id LIMIT $2`,
      [opportunityId, limit],
    );
    return r.rows.map(toMatch);
  }

  async match(tx: Tx, opportunityId: string, employeeId: string): Promise<MatchRow | null> {
    const r = await tx.query(
      `SELECT ${MATCH_COLUMNS} FROM opportunity_matches WHERE opportunity_id = $1 AND employee_id = $2`,
      [opportunityId, employeeId],
    );
    return r.rows[0] ? toMatch(r.rows[0]) : null;
  }

  async feed(tx: Tx, employeeId: string, limit: number) {
    const r = await tx.query(
      `SELECT ${OPPORTUNITY_COLUMNS.split(',')
        .map((c) => `o.${c.trim()}`)
        .join(', ')},
              m.employee_id::text AS m_employee_id, m.score::float8 AS m_score, m.availability::float8 AS m_availability,
              m.score_internal::float8 AS m_score_internal, m.readiness::float8 AS m_readiness,
              m.explanation AS m_explanation, m.low_confidence AS m_low_confidence, m.stale AS m_stale,
              m.computed_at AS m_computed_at
       FROM opportunity_matches m JOIN opportunities o USING (tenant_id, opportunity_id)
       WHERE m.employee_id = $1 AND o.status = 'open' AND m.availability > 0
       ORDER BY m.score_internal DESC, o.start_date LIMIT $2`,
      [employeeId, limit],
    );
    return r.rows.map((x) => ({
      opportunity: toOpportunity(x),
      match: toMatch({
        employee_id: x['m_employee_id'],
        score: x['m_score'],
        availability: x['m_availability'],
        score_internal: x['m_score_internal'],
        readiness: x['m_readiness'],
        explanation: x['m_explanation'],
        low_confidence: x['m_low_confidence'],
        stale: x['m_stale'],
        computed_at: x['m_computed_at'],
      }),
    }));
  }

  async insertApplication(tx: Tx, a: Application): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO opportunity_applications (tenant_id, application_id, opportunity_id, employee_id, kind, status,
         note, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id, opportunity_id, employee_id) DO NOTHING`,
      [
        a.tenantId,
        a.id,
        a.opportunityId,
        a.employeeId,
        a.kind,
        a.status,
        a.note,
        a.createdBy,
        a.createdAt,
      ],
    );
    return r.rowCount === 1;
  }

  async application(tx: Tx, id: string): Promise<Application | null> {
    const r = await tx.query(
      `SELECT ${APPLICATION_COLUMNS} FROM opportunity_applications WHERE application_id = $1`,
      [id],
    );
    return r.rows[0] ? toApplication(r.rows[0]) : null;
  }

  async applications(
    tx: Tx,
    f: { opportunityId?: string; employeeId?: string },
  ): Promise<Application[]> {
    const r = await tx.query(
      `SELECT ${APPLICATION_COLUMNS} FROM opportunity_applications
       WHERE ($1::uuid IS NULL OR opportunity_id = $1) AND ($2::uuid IS NULL OR employee_id = $2)
       ORDER BY created_at, application_id`,
      [f.opportunityId ?? null, f.employeeId ?? null],
    );
    return r.rows.map(toApplication);
  }

  async updateApplication(
    tx: Tx,
    id: string,
    expected: ApplicationStatus,
    f: Partial<
      Pick<
        Application,
        'status' | 'decidedBy' | 'decidedAt' | 'allocationId' | 'disclosedToManager'
      >
    >,
  ): Promise<Application | null> {
    const r = await tx.query(
      `UPDATE opportunity_applications SET
         status = COALESCE($3, status), decided_by = COALESCE($4, decided_by),
         decided_at = COALESCE($5, decided_at), allocation_id = COALESCE($6, allocation_id),
         disclosed_to_manager = COALESCE($7, disclosed_to_manager)
       WHERE application_id = $1 AND status = $2
       RETURNING ${APPLICATION_COLUMNS}`,
      [
        id,
        expected,
        f.status ?? null,
        f.decidedBy ?? null,
        f.decidedAt ?? null,
        f.allocationId ?? null,
        f.disclosedToManager ?? null,
      ],
    );
    return r.rows[0] ? toApplication(r.rows[0]) : null;
  }

  async eraseEmployee(tx: Tx, employeeId: string): Promise<number> {
    const a = await tx.query(`DELETE FROM opportunity_applications WHERE employee_id = $1`, [
      employeeId,
    ]);
    const m = await tx.query(`DELETE FROM opportunity_matches WHERE employee_id = $1`, [
      employeeId,
    ]);
    return a.rowCount + m.rowCount;
  }
}

// --- Projects ---------------------------------------------------------------------------------

@Injectable()
export class PgProjectRepository implements ProjectRepository {
  async insert(tx: Tx, p: Project): Promise<void> {
    await tx.query(
      `INSERT INTO projects (tenant_id, project_id, name, account_id, start_date, end_date, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.tenantId, p.id, p.name, p.accountId, p.startDate, p.endDate, p.status, p.createdBy],
    );
  }

  async get(tx: Tx, id: string): Promise<Project | null> {
    const r = await tx.query(
      `SELECT tenant_id::text, project_id::text, name, account_id, start_date::text, end_date::text, status, created_by
       FROM projects WHERE project_id = $1`,
      [id],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      tenantId: String(x['tenant_id']),
      id: String(x['project_id']),
      name: String(x['name']),
      accountId: str(x['account_id']),
      startDate: String(x['start_date']),
      endDate: str(x['end_date']),
      status: x['status'] as Project['status'],
      createdBy: String(x['created_by']),
    };
  }

  async allocate(tx: Tx, a: AllocationRow, by: string): Promise<void> {
    try {
      await tx.query(
        `INSERT INTO project_allocations (tenant_id, allocation_id, project_id, employee_id, percent, during, source,
           opportunity_id, created_by)
         VALUES (current_tenant_id(), $1, $2, $3, $4, daterange($5::date, $6::date, '[)'), $7, $8, $9)`,
        [a.id, a.projectId, a.employeeId, a.percent, a.start, a.end, a.source, a.opportunityId, by],
      );
    } catch (error) {
      const e = error as { code?: string; constraint?: string; message?: string };
      if (
        e.code === '23514' &&
        (e.constraint === 'project_allocations_capacity' || /would reach/.test(e.message ?? ''))
      )
        throw new CapacityExceededError();
      throw error;
    }
  }

  async removeAllocation(tx: Tx, id: string): Promise<AllocationRow | null> {
    const r = await tx.query(
      `DELETE FROM project_allocations WHERE allocation_id = $1
       RETURNING allocation_id::text, project_id::text, employee_id::text, percent, lower(during)::text AS start,
                 upper(during)::text AS "end", source, opportunity_id::text`,
      [id],
    );
    return r.rows[0] ? this.toAllocation(r.rows[0]) : null;
  }

  private toAllocation(x: Row): AllocationRow {
    return {
      id: String(x['allocation_id']),
      projectId: String(x['project_id']),
      employeeId: String(x['employee_id']),
      percent: num(x['percent']),
      start: String(x['start']),
      end: str(x['end']),
      source: x['source'] as AllocationRow['source'],
      opportunityId: str(x['opportunity_id']),
    };
  }

  async allocations(tx: Tx, ids: readonly string[]): Promise<Map<string, AllocationRow[]>> {
    const out = new Map<string, AllocationRow[]>();
    if (ids.length === 0) return out;
    const r = await tx.query(
      `SELECT allocation_id::text, project_id::text, employee_id::text, percent, lower(during)::text AS start,
              upper(during)::text AS "end", source, opportunity_id::text
       FROM project_allocations WHERE employee_id = ANY($1::uuid[]) ORDER BY lower(during)`,
      [ids],
    );
    for (const x of r.rows) {
      const a = this.toAllocation(x);
      out.set(a.employeeId, [...(out.get(a.employeeId) ?? []), a]);
    }
    return out;
  }

  async eraseEmployee(tx: Tx, employeeId: string): Promise<number> {
    return (await tx.query(`DELETE FROM project_allocations WHERE employee_id = $1`, [employeeId]))
      .rowCount;
  }
}

// --- Demand -----------------------------------------------------------------------------------

@Injectable()
export class PgDemandRepository implements DemandRepository {
  async insertBatch(
    tx: Tx,
    b: {
      id: string;
      fileName: string;
      status: 'processed' | 'failed';
      rowsTotal: number;
      rowsLoaded: number;
      errors: RowError[];
      by: string;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO demand_batches (tenant_id, batch_id, file_name, status, rows_total, rows_loaded, errors, uploaded_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
      [b.id, b.fileName, b.status, b.rowsTotal, b.rowsLoaded, JSON.stringify(b.errors), b.by],
    );
  }

  async batch(tx: Tx, id: string): Promise<Record<string, unknown> | null> {
    const r = await tx.query(
      `SELECT batch_id::text, file_name, status, rows_total, rows_loaded, errors, uploaded_by, created_at
       FROM demand_batches WHERE batch_id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  /** Upserts on (account, external_ref) when the row has one: re-uploads update in place. */
  async upsertDemand(tx: Tx, batchId: string, id: string, d: DemandInput): Promise<string> {
    const params = [
      id,
      batchId,
      d.account_id,
      d.external_ref,
      d.title,
      d.job_profile_id,
      JSON.stringify(d.skills),
      d.headcount,
      d.allocation_pct,
      d.start_date,
      d.end_date,
      d.location,
    ];
    const r = d.external_ref
      ? await tx.query<{ id: string }>(
          `INSERT INTO demands (tenant_id, demand_id, batch_id, account_id, external_ref, title, job_profile_id, skills,
             headcount, allocation_pct, start_date, end_date, location)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (tenant_id, account_id, external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
             batch_id = EXCLUDED.batch_id, title = EXCLUDED.title, job_profile_id = EXCLUDED.job_profile_id,
             skills = EXCLUDED.skills, headcount = EXCLUDED.headcount, allocation_pct = EXCLUDED.allocation_pct,
             start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, location = EXCLUDED.location,
             status = 'open'
           RETURNING demand_id::text AS id`,
          params,
        )
      : await tx.query<{ id: string }>(
          `INSERT INTO demands (tenant_id, demand_id, batch_id, account_id, external_ref, title, job_profile_id, skills,
             headcount, allocation_pct, start_date, end_date, location)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING demand_id::text AS id`,
          params,
        );
    return r.rows[0]?.id ?? id;
  }

  async list(tx: Tx, f: { status?: string; accountId?: string; batchId?: string }) {
    const r = await tx.query(
      `SELECT demand_id::text, batch_id::text, account_id, external_ref, title, job_profile_id::text, skills, headcount,
              allocation_pct, start_date::text, end_date::text, location, status
       FROM demands
       WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR account_id = $2)
         AND ($3::uuid IS NULL OR batch_id = $3)
       ORDER BY start_date, external_ref NULLS LAST, demand_id LIMIT 1000`,
      [f.status ?? null, f.accountId ?? null, f.batchId ?? null],
    );
    return r.rows.map((x) => ({ ...x, skills: json(x['skills']) }));
  }

  async queuePlan(
    tx: Tx,
    p: { id: string; accountId: string | null; horizonDays: number; by: string },
  ) {
    const existing = await tx.query<{ id: string }>(
      `SELECT plan_id::text AS id FROM fulfilment_plans
       WHERE status IN ('queued', 'running') AND account_id IS NOT DISTINCT FROM $1 LIMIT 1`,
      [p.accountId],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    await tx.query(
      `INSERT INTO fulfilment_plans (tenant_id, plan_id, account_id, horizon_days, requested_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4)`,
      [p.id, p.accountId, p.horizonDays, p.by],
    );
    return { id: p.id, created: true };
  }

  async plan(tx: Tx, id: string): Promise<Record<string, unknown> | null> {
    const r = await tx.query(
      `SELECT plan_id::text, account_id, horizon_days, status, solver_status, objective::float8, summary, error,
              requested_by, created_at, finished_at
       FROM fulfilment_plans WHERE plan_id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async planLines(tx: Tx, id: string): Promise<Record<string, unknown>[]> {
    const r = await tx.query(
      `SELECT demand_id::text, slot, classification, employee_id::text, readiness::float8, learning_hours::float8,
              days_until_start, explanation
       FROM fulfilment_plan_lines WHERE plan_id = $1 ORDER BY demand_id, slot`,
      [id],
    );
    return r.rows;
  }
}

// --- Attrition --------------------------------------------------------------------------------

@Injectable()
export class PgAttritionRepository implements AttritionRepository {
  async asHrbp(tx: Tx): Promise<void> {
    await tx.query(`SELECT set_config('app.hrbp', 'on', true)`);
  }

  async alerts(tx: Tx, status: string | null, limit: number) {
    const r = await tx.query(
      `SELECT alert_id::text, employee_id::text, probability::float8, delta_30d::float8, first_crossing, drivers,
              suggested_actions, manager_user_id, model_version, status, raised_on::text, acknowledged_by,
              acknowledged_at
       FROM attrition_alerts WHERE ($1::text IS NULL OR status = $1)
       ORDER BY raised_on DESC, probability DESC LIMIT $2`,
      [status, limit],
    );
    return r.rows;
  }

  async acknowledge(tx: Tx, alertId: string, by: string, at: Date): Promise<boolean> {
    const r = await tx.query(
      `UPDATE attrition_alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3
       WHERE alert_id = $1 AND status = 'open'`,
      [alertId, by, at],
    );
    return r.rowCount === 1;
  }

  async scores(tx: Tx, employeeId: string, limit: number) {
    const r = await tx.query(
      `SELECT scored_on::text, probability::float8, model_version, drivers FROM attrition_scores
       WHERE employee_id = $1 ORDER BY scored_on DESC LIMIT $2`,
      [employeeId, limit],
    );
    return r.rows;
  }

  async activeModel(tx: Tx) {
    const r = await tx.query(
      `SELECT model_version, scope, trained_at, metrics, features, excluded, alerts_enabled, disabled_reason, psi,
              threshold::float8
       FROM attrition_models WHERE active ORDER BY trained_at DESC LIMIT 1`,
    );
    return r.rows[0] ?? null;
  }

  async audit(tx: Tx, subject: string, action: string, target: string | null): Promise<void> {
    await tx.query(
      `INSERT INTO intel_audit_log (tenant_id, subject, action, target) VALUES (current_tenant_id(), $1, $2, $3)`,
      [subject, action, target],
    );
  }

  async eraseEmployee(tx: Tx, employeeId: string): Promise<number> {
    let n = 0;
    for (const table of [
      'attrition_alerts',
      'attrition_scores',
      'attrition_feature_snapshots',
      'intel_employee_protected',
    ])
      n += (await tx.query(`DELETE FROM ${table} WHERE employee_id = $1`, [employeeId])).rowCount;
    return n;
  }
}

// --- Work queue -------------------------------------------------------------------------------

@Injectable()
export class PgWorkQueue implements WorkQueue {
  async enqueue(tx: Tx, w: WorkItem): Promise<void> {
    await tx.query(
      `INSERT INTO intel_work (tenant_id, kind, subject_id, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, kind, subject_id) DO UPDATE SET reason = EXCLUDED.reason, attempts = 0,
         available_at = LEAST(intel_work.available_at, now())`,
      [w.tenantId, w.kind, w.subjectId, w.reason],
    );
  }

  async due(tx: Tx, limit: number, now: Date): Promise<WorkItem[]> {
    const r = await tx.query(
      `SELECT tenant_id::text, kind, subject_id::text, reason, attempts FROM intel_work
       WHERE available_at <= $1 ORDER BY available_at, created_at LIMIT $2`,
      [now, limit],
    );
    return r.rows.map((x) => ({
      tenantId: String(x['tenant_id']),
      kind: x['kind'] as WorkItem['kind'],
      subjectId: String(x['subject_id']),
      reason: String(x['reason']),
      attempts: num(x['attempts']),
    }));
  }

  async done(tx: Tx, w: WorkItem): Promise<void> {
    // Only if not re-enqueued meanwhile with a newer reason (attempts reset to 0 then too).
    await tx.query(`DELETE FROM intel_work WHERE kind = $1 AND subject_id = $2 AND attempts = $3`, [
      w.kind,
      w.subjectId,
      w.attempts ?? 0,
    ]);
  }

  async retry(tx: Tx, w: WorkItem, at: Date): Promise<void> {
    await tx.query(
      `UPDATE intel_work SET attempts = attempts + 1, available_at = $3 WHERE kind = $1 AND subject_id = $2`,
      [w.kind, w.subjectId, at],
    );
  }

  async deleteSubject(tx: Tx, subjectId: string): Promise<number> {
    return (await tx.query(`DELETE FROM intel_work WHERE subject_id = $1`, [subjectId])).rowCount;
  }
}
