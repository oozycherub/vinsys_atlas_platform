import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  ForbiddenError,
  hasAnyRole,
  NotFoundError,
  type Principal,
  withTenantTx,
} from '@atlas/platform';
import { enumeratePaths, pathType, recommendLearning } from '../domain/career';
import { MIN_GROUP_SIZE } from '../domain/opportunity';
import { gapBand, readiness } from '../domain/readiness';
import { ADMINS, isManager, MANAGERS, requireHris, requireRole, tenantOf } from './access';
import {
  CATALOGUE_REPOSITORY,
  type CatalogueRepository,
  type Employee,
  EMPLOYEE_REPOSITORY,
  type EmployeeRepository,
  type Policy,
  WORK_QUEUE,
  type WorkQueue,
} from './ports';

export type EmployeeInput = Omit<Employee, 'tenantId' | 'sourceSyncedAt'> & {
  sourceSyncedAt: string | null;
  protectedAttributes: Record<string, string> | null;
};

const monthOf = (d: Date) => `${d.toISOString().slice(0, 7)}-01`;
function monthsBack(month: string, n: number): string {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** The workforce view: HR roster sync, career paths and skill-gap analytics (PRD §2.5). */
@Injectable()
export class WorkforceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepository,
    @Inject(CATALOGUE_REPOSITORY) private readonly catalogue: CatalogueRepository,
    @Inject(WORK_QUEUE) private readonly work: WorkQueue,
  ) {}

  // --- HRIS sync ----------------------------------------------------------------------------

  async upsert(
    p: Principal,
    tenant: string | undefined,
    rows: EmployeeInput[],
  ): Promise<{ upserted: number }> {
    requireHris(p);
    const tenantId = tenantOf(p, tenant);
    const now = this.clock.now();
    return withTenantTx(this.db, tenantId, async (tx) => {
      for (const r of rows) {
        const { protectedAttributes, sourceSyncedAt, ...fields } = r;
        await this.employees.upsert(tx, {
          ...fields,
          tenantId,
          sourceSyncedAt: sourceSyncedAt ? new Date(sourceSyncedAt) : now,
        });
        // Fairness-audit attributes only: stored apart and readable only by the attrition audit.
        if (protectedAttributes) {
          await tx.query(`SELECT set_config('app.hrbp', 'on', true)`);
          await this.employees.setProtected(tx, r.employeeId, protectedAttributes);
          await tx.query(`SELECT set_config('app.hrbp', 'off', true)`);
        }
        await this.work.enqueue(tx, {
          tenantId,
          kind: 'employee',
          subjectId: r.employeeId,
          reason: 'hris_sync',
        });
      }
      return { upserted: rows.length };
    });
  }

  /** The employee themselves, their manager, or HR; the view never includes risk data. */
  /** The caller's own roster record (`GET /v1/employees/me`), found by their user id. */
  async me(p: Principal, tenant: string | undefined): Promise<Record<string, unknown>> {
    const tenantId = tenantOf(p, tenant);
    const e = await withTenantTx(this.db, tenantId, (tx) => this.employees.byUser(tx, p.subject));
    if (!e) throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'You are not in the workforce roster.');
    return this.get(p, tenant, e.employeeId);
  }

  async get(
    p: Principal,
    tenant: string | undefined,
    employeeId: string,
  ): Promise<Record<string, unknown>> {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const e = await this.employees.get(tx, employeeId);
      if (!e) throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      const self = e.userId !== null && e.userId === p.subject;
      const manager = e.managerUserId !== null && e.managerUserId === p.subject;
      if (!self && !manager && !hasAnyRole(p, ADMINS))
        throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      const gap = await this.employees.roleGap(tx, employeeId);
      return {
        employee_id: e.employeeId,
        department: e.department,
        location: e.location,
        job_profile_id: e.jobProfileId,
        role_started_at: e.roleStartedAt,
        marketplace_opt_in: e.marketplaceOptIn,
        status: e.status,
        source_synced_at: e.sourceSyncedAt.toISOString(),
        role_fit: gap
          ? {
              readiness: round4(gap.readiness),
              role_gap_pct: round4(gap.roleGapPct),
              band: gapBand(gap.roleGapPct),
            }
          : null,
      };
    });
  }

  async policy(p: Principal, tenant: string | undefined): Promise<Policy> {
    requireRole(p, MANAGERS);
    return withTenantTx(this.db, tenantOf(p, tenant), (tx) => this.employees.policy(tx));
  }

  async setPolicy(p: Principal, tenant: string | undefined, policy: Policy): Promise<Policy> {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      await this.employees.setPolicy(tx, policy, p.subject);
      return this.employees.policy(tx);
    });
  }

  // --- Career paths (PRD §2.5(v)) --------------------------------------------------------------

  async careerPaths(
    p: Principal,
    tenant: string | undefined,
    employeeId: string,
  ): Promise<Record<string, unknown>> {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const e = await this.employees.get(tx, employeeId);
      if (!e) throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      const self = e.userId !== null && e.userId === p.subject;
      const manager = e.managerUserId === p.subject;
      if (!self && !manager && !hasAnyRole(p, ADMINS))
        throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      if (!e.jobProfileId) return { employee_id: employeeId, from_profile_id: null, paths: [] };
      const skills = (await this.employees.skills(tx, [employeeId])).get(employeeId) ?? [];
      const prof = new Map(skills.map((s) => [s.skillId, s.proficiency]));
      const validated = skills.some((s) => s.validated);
      const paths = enumeratePaths(e.jobProfileId, await this.catalogue.transitions(tx));
      const profiles = await this.catalogue.profiles(
        tx,
        paths.map((ps) => ps.at(-1)?.profileId ?? ''),
      );
      const catalogue = await this.catalogue.learningItems(tx);
      const out = paths
        .map((steps) => {
          const target = profiles.get(steps.at(-1)?.profileId ?? '');
          if (!target) return null;
          const fit = readiness(target.skills, prof);
          const learning = recommendLearning(fit.gaps, catalogue);
          return {
            target_profile_id: target.jobProfileId,
            title: target.title,
            type: pathType(steps),
            steps: steps.map((s) => ({
              profile_id: s.profileId,
              type: s.type,
              typical_months: s.typicalMonths,
            })),
            readiness: round4(fit.readiness),
            match_pct: Math.round(fit.readiness * 100),
            gap_band: fit.band,
            gaps: fit.gaps.filter((g) => g.gap > 0),
            learning: {
              items: learning.items.map((i) => ({
                item_id: i.item_id,
                title: i.title,
                duration_hours: i.duration_hours,
              })),
              hours: learning.hours,
              uncovered_skills: learning.uncovered,
            },
          };
        })
        .filter((x) => x !== null)
        .sort((a, b) => b.readiness - a.readiness);
      return {
        employee_id: employeeId,
        from_profile_id: e.jobProfileId,
        low_confidence: !validated,
        paths: out,
      };
    });
  }

  // --- Skill-gap heat-map (PRD §2.5(a)) ---------------------------------------------------------

  async skillGaps(
    p: Principal,
    tenant: string | undefined,
    groupBy: 'department' | 'job_profile' | 'location',
    periodMonths: number,
  ): Promise<Record<string, unknown>> {
    if (!isManager(p)) throw new ForbiddenError('Skill-gap analytics are for managers and HR.');
    const tenantId = tenantOf(p, tenant);
    const month = monthOf(this.clock.now());
    const before = monthsBack(month, periodMonths);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const now = await this.employees.heatmap(tx, groupBy, month);
      const then = new Map(
        (await this.employees.heatmap(tx, groupBy, before)).map((c) => [
          `${c.groupKey}|${c.skillId}`,
          c,
        ]),
      );
      const cells = now
        .filter((c) => c.employees >= MIN_GROUP_SIZE)
        .map((c) => {
          const pct = c.reqSum > 0 ? c.gapSum / c.reqSum : 0;
          const old = then.get(`${c.groupKey}|${c.skillId}`);
          const oldPct =
            old && old.employees >= MIN_GROUP_SIZE && old.reqSum > 0
              ? old.gapSum / old.reqSum
              : null;
          return {
            group: c.groupKey,
            skill_id: c.skillId,
            employees: c.employees,
            gap_pct: round4(pct),
            band: gapBand(pct),
            trend: oldPct === null ? null : round4(pct - oldPct),
          };
        })
        .sort((a, b) => b.gap_pct - a.gap_pct || a.group.localeCompare(b.group));
      return {
        group_by: groupBy,
        period_month: month,
        compared_with: before,
        min_group_size: MIN_GROUP_SIZE,
        cells,
      };
    });
  }
}
