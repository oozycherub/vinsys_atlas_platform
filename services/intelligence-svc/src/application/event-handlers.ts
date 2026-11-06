import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import {
  CandidateRescored,
  CandidateSkillsUpdated,
  ErasureAcknowledged,
  ErasureRequested,
  JobProfileUpdated,
  TenantPurged,
} from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  type ConsumedEvent,
  type EventHandler,
  setTenantContext,
  type Tx,
} from '@atlas/platform';
import {
  ATTRITION_REPOSITORY,
  type AttritionRepository,
  CATALOGUE_REPOSITORY,
  type CatalogueRepository,
  EMPLOYEE_REPOSITORY,
  type EmployeeRepository,
  INTEL_LOGGER,
  OPPORTUNITY_REPOSITORY,
  type OpportunityRepository,
  PROJECT_REPOSITORY,
  type ProjectRepository,
  WORK_QUEUE,
  type WorkQueue,
} from './ports';

export const INTEL_CONSUMER = 'intelligence-svc.events';
export const SERVICE_NAME = 'intelligence-svc';

type Payload<T extends { schema: { _output: unknown } }> = T['schema']['_output'];

const TENANT_TABLES = [
  'opportunity_matches',
  'opportunity_applications',
  'project_allocations',
  'opportunities',
  'projects',
  'fulfilment_plan_lines',
  'fulfilment_plans',
  'demands',
  'demand_batches',
  'skill_gap_aggregates',
  'employee_role_gaps',
  'learning_items',
  'job_profile_transitions',
  'intel_requisition_scores',
  'intel_job_profiles',
  'intel_employee_skills',
  'intel_tenant_policies',
  'intel_employees',
  'intel_work',
  'intel_audit_log',
];
const HRBP_TABLES = [
  'attrition_alerts',
  'attrition_scores',
  'attrition_models',
  'attrition_feature_snapshots',
  'intel_employee_protected',
];

/**
 * Consumed events (Component Prompt 12 §5). Handlers update read models and queue work in the
 * consumer's transaction; ranking (remote calls) runs in the worker.
 */
@Injectable()
export class IntelEventHandlers {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepository,
    @Inject(CATALOGUE_REPOSITORY) private readonly catalogue: CatalogueRepository,
    @Inject(OPPORTUNITY_REPOSITORY) private readonly opportunities: OpportunityRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(ATTRITION_REPOSITORY) private readonly attrition: AttritionRepository,
    @Inject(WORK_QUEUE) private readonly work: WorkQueue,
    @Inject(INTEL_LOGGER) private readonly logger: Logger | null,
  ) {}

  handlers(): Record<string, EventHandler> {
    return {
      [CandidateSkillsUpdated.topic]: (tx, e) => this.skills(tx, e),
      [JobProfileUpdated.topic]: (tx, e) => this.jobProfile(tx, e),
      [CandidateRescored.topic]: (tx, e) => this.rescored(tx, e),
      [ErasureRequested.topic]: (tx, e) => this.erasure(tx, e),
      [TenantPurged.topic]: (tx, e) => this.purged(tx, e),
    };
  }

  private async skills(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof CandidateSkillsUpdated>;
    await setTenantContext(tx, p.tenant_id);
    await this.employees.replaceSkills(
      tx,
      p.candidate_id,
      p.skills.map((s) => ({
        skillId: s.skill_id,
        proficiency: s.proficiency,
        validated: s.is_validated,
      })),
    );
    await this.work.enqueue(tx, {
      tenantId: p.tenant_id,
      kind: 'employee',
      subjectId: p.candidate_id,
      reason: 'skills_updated',
    });
    return undefined;
  }

  /** A new profile version: employees in it get new gaps; open opportunities built on it re-rank. */
  private async jobProfile(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof JobProfileUpdated>;
    await setTenantContext(tx, p.tenant_id);
    const fresh = await this.catalogue.upsertProfile(tx, {
      jobProfileId: p.job_profile_id,
      version: p.version,
      status: p.status,
      title: p.title,
      skills: p.skills,
    });
    if (!fresh) return undefined; // an older version arrived late
    for (const id of await this.employees.byJobProfile(tx, p.job_profile_id))
      await this.work.enqueue(tx, {
        tenantId: p.tenant_id,
        kind: 'employee',
        subjectId: id,
        reason: 'job_profile_updated',
      });
    for (const o of await this.opportunities.openByJobProfile(tx, p.job_profile_id))
      await this.work.enqueue(tx, {
        tenantId: p.tenant_id,
        kind: 'opportunity',
        subjectId: o.id,
        reason: 'job_profile_updated',
      });
    return undefined;
  }

  /** matching-svc's requisition scores: kept for employees, so linked roles rank consistently. */
  private async rescored(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof CandidateRescored>;
    await setTenantContext(tx, p.tenant_id);
    const employee = await this.employees.get(tx, p.candidate_id);
    if (!employee) return undefined; // an external candidate: not ours
    await this.employees.upsertRequisitionScores(
      tx,
      p.candidate_id,
      p.scores.map((s) => ({ requisitionId: s.requisition_id, score: s.score, band: s.band })),
      new Date(p.occurred_at),
    );
    const linked = new Set<string>();
    for (const s of p.scores)
      for (const o of await this.opportunities.openByRequisition(tx, s.requisition_id))
        linked.add(o.id);
    if (linked.size > 0)
      await this.work.enqueue(tx, {
        tenantId: p.tenant_id,
        kind: 'employee',
        subjectId: p.candidate_id,
        reason: 'requisition_rescored',
      });
    return undefined;
  }

  private async erasure(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof ErasureRequested>;
    await setTenantContext(tx, p.tenant_id);
    await this.attrition.asHrbp(tx);
    const removed = {
      attrition: await this.attrition.eraseEmployee(tx, p.candidate_id),
      applications: await this.opportunities.eraseEmployee(tx, p.candidate_id),
      allocations: await this.projects.eraseEmployee(tx, p.candidate_id),
      employee: await this.employees.erase(tx, p.candidate_id),
      work: await this.work.deleteSubject(tx, p.candidate_id),
    };
    if (p.ack_required_from.includes(SERVICE_NAME)) {
      await appendOutbox(
        tx,
        ErasureAcknowledged.build({
          tenantId: p.tenant_id,
          aggregateId: p.request_id,
          payload: {
            tenant_id: p.tenant_id,
            request_id: p.request_id,
            service: SERVICE_NAME,
            occurred_at: this.clock.now().toISOString(),
          },
        }),
      );
    }
    this.logger?.info(
      { tenant_id: p.tenant_id, request_id: p.request_id, removed },
      'employee erased',
    );
    return undefined;
  }

  private async purged(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const tenantId = (e.payload as { tenant_id: string }).tenant_id;
    await setTenantContext(tx, tenantId);
    await this.attrition.asHrbp(tx);
    for (const table of [...HRBP_TABLES, ...TENANT_TABLES])
      await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    return undefined;
  }
}
