import { Inject, Injectable } from '@nestjs/common';
import { AllocationChanged, OpportunityPublished } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  DomainRuleError,
  ForbiddenError,
  hasAnyRole,
  newId,
  NotFoundError,
  type Principal,
  type Tx,
  withTenantTx,
} from '@atlas/platform';
import { exclusiveEnd } from '../domain/availability';
import { assertMove, canDecide, OpportunityRuleError } from '../domain/opportunity';
import { ADMINS, MANAGERS, requireRole, tenantOf, WORKFORCE } from './access';
import {
  type AllocationRow,
  type Application,
  CapacityExceededError,
  CATALOGUE_REPOSITORY,
  type CatalogueRepository,
  type Employee,
  EMPLOYEE_REPOSITORY,
  type EmployeeRepository,
  type MatchRow,
  type Opportunity,
  OPPORTUNITY_REPOSITORY,
  type OpportunityRepository,
  type OpportunityType,
  type Project,
  PROJECT_REPOSITORY,
  type ProjectRepository,
  type Requirements,
  WORK_QUEUE,
  type WorkQueue,
} from './ports';

export interface OpportunityInput {
  type: OpportunityType;
  title: string;
  description: string;
  job_profile_id: string | null;
  requisition_id: string | null;
  project_id: string | null;
  skills: Requirements | null;
  allocation_pct: number;
  start_date: string;
  end_date: string | null;
  location: string | null;
  min_tenure_months: number;
}

function view(o: Opportunity) {
  return {
    opportunity_id: o.id,
    type: o.type,
    title: o.title,
    description: o.description,
    job_profile_id: o.jobProfileId,
    requisition_id: o.requisitionId,
    project_id: o.projectId,
    skills: o.skills,
    allocation_pct: o.allocationPct,
    start_date: o.startDate,
    end_date: o.endDate,
    location: o.location,
    min_tenure_months: o.minTenureMonths,
    status: o.status,
    owner_user_id: o.ownerUserId,
    published_at: o.publishedAt?.toISOString() ?? null,
    version: o.version,
  };
}

function matchView(m: MatchRow) {
  return {
    employee_id: m.employeeId,
    score: m.score,
    availability: m.availability,
    score_internal: m.scoreInternal,
    readiness: m.readiness,
    match_pct: Math.round(m.scoreInternal * 100),
    low_confidence: m.lowConfidence,
    stale: m.stale,
    explanation: m.explanation,
    computed_at: m.computedAt.toISOString(),
  };
}

function applicationView(a: Application) {
  return {
    application_id: a.id,
    opportunity_id: a.opportunityId,
    employee_id: a.employeeId,
    kind: a.kind,
    status: a.status,
    note: a.note,
    disclosed_to_manager: a.disclosedToManager,
    allocation_id: a.allocationId,
    created_at: a.createdAt.toISOString(),
    decided_at: a.decidedAt?.toISOString() ?? null,
  };
}

const translate = (error: unknown): never => {
  if (error instanceof OpportunityRuleError) throw new DomainRuleError(error.code, error.message);
  throw error;
};

/** The internal marketplace (PRD §2.5(c)): opportunities, matches, applications, allocations. */
@Injectable()
export class MarketplaceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OPPORTUNITY_REPOSITORY) private readonly opportunities: OpportunityRepository,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepository,
    @Inject(CATALOGUE_REPOSITORY) private readonly catalogue: CatalogueRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(WORK_QUEUE) private readonly work: WorkQueue,
  ) {}

  private async me(tx: Tx, p: Principal): Promise<Employee> {
    const e = await this.employees.byUser(tx, p.subject);
    if (!e || e.status !== 'active')
      throw new ForbiddenError("You are not in this tenant's workforce roster.");
    return e;
  }

  private async owned(tx: Tx, p: Principal, id: string): Promise<Opportunity> {
    const o = await this.opportunities.get(tx, id);
    if (!o) throw new NotFoundError('OPPORTUNITY_NOT_FOUND', 'Opportunity not found.');
    if (o.ownerUserId !== p.subject && !hasAnyRole(p, ADMINS))
      throw new ForbiddenError("Only the opportunity's owner or an admin can do this.");
    return o;
  }

  // --- opportunities ------------------------------------------------------------------------

  async create(p: Principal, tenant: string | undefined, input: OpportunityInput) {
    requireRole(p, MANAGERS);
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      let skills = input.skills ?? [];
      if (skills.length === 0 && input.job_profile_id) {
        skills = (await this.catalogue.profile(tx, input.job_profile_id))?.skills ?? [];
      }
      if (skills.length === 0)
        throw new DomainRuleError(
          'REQUIREMENTS_REQUIRED',
          'Give skills, or a job profile intelligence-svc knows.',
        );
      if (input.project_id && !(await this.projects.get(tx, input.project_id)))
        throw new NotFoundError('PROJECT_NOT_FOUND', 'Project not found.');
      if (input.type !== 'role' && !input.project_id)
        throw new DomainRuleError('PROJECT_REQUIRED', 'Projects and gigs book time on a project.');
      const o: Opportunity = {
        tenantId,
        id: newId(),
        type: input.type,
        title: input.title,
        description: input.description,
        jobProfileId: input.job_profile_id,
        requisitionId: input.requisition_id,
        projectId: input.project_id,
        skills,
        allocationPct: input.allocation_pct,
        startDate: input.start_date,
        endDate: input.end_date,
        location: input.location,
        minTenureMonths: input.min_tenure_months,
        status: 'draft',
        ownerUserId: p.subject,
        embedding: null,
        embeddingModel: null,
        publishedAt: null,
        createdAt: this.clock.now(),
        version: 1,
      };
      await this.opportunities.insert(tx, o);
      return view(o);
    });
  }

  async get(p: Principal, tenant: string | undefined, id: string) {
    requireRole(p, WORKFORCE);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const o = await this.opportunities.get(tx, id);
      if (!o || (o.status === 'draft' && o.ownerUserId !== p.subject && !hasAnyRole(p, ADMINS)))
        throw new NotFoundError('OPPORTUNITY_NOT_FOUND', 'Opportunity not found.');
      return view(o);
    });
  }

  async move(p: Principal, tenant: string | undefined, id: string, to: 'open' | 'closed') {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const o = await this.owned(tx, p, id);
      try {
        assertMove(o.status, to);
      } catch (error) {
        translate(error);
      }
      const now = this.clock.now();
      const moved = await this.opportunities.update(tx, id, o.version, {
        status: to,
        ...(to === 'open' ? { publishedAt: now } : {}),
      });
      if (!moved)
        throw new ConflictError('CONCURRENT_UPDATE', 'The opportunity changed; reload it.');
      if (to === 'open') {
        await appendOutbox(
          tx,
          OpportunityPublished.build({
            tenantId,
            aggregateId: id,
            payload: {
              tenant_id: tenantId,
              opportunity_id: id,
              type: o.type,
              job_profile_id: o.jobProfileId,
              requisition_id: o.requisitionId,
              allocation_pct: o.allocationPct,
              start_date: o.startDate,
              end_date: o.endDate,
              required_skills: o.skills.length,
              occurred_at: now.toISOString(),
            },
          }),
        );
      }
      await this.work.enqueue(tx, {
        tenantId,
        kind: 'opportunity',
        subjectId: id,
        reason: `status_${to}`,
      });
      return view(moved);
    });
  }

  /** The personalised feed: open opportunities this employee can take, best first. */
  async feed(p: Principal, tenant: string | undefined, limit: number) {
    requireRole(p, WORKFORCE);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const me = await this.me(tx, p);
      const rows = await this.opportunities.feed(tx, me.employeeId, limit);
      return {
        employee_id: me.employeeId,
        items: rows.map(({ opportunity, match }) => ({
          opportunity: view(opportunity),
          match_pct: Math.round(match.scoreInternal * 100),
          readiness: match.readiness,
          low_confidence: match.lowConfidence,
          gaps: (match.explanation['gaps'] as unknown[]) ?? [],
        })),
      };
    });
  }

  /** Ranked employees with explanations, for the owner (PRD §2.5b API). */
  async recommend(
    p: Principal,
    tenant: string | undefined,
    id: string,
    limit: number,
    includeUnavailable: boolean,
  ) {
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const o = await this.owned(tx, p, id);
      const rows = (await this.opportunities.matches(tx, o.id, 200))
        .filter((m) => includeUnavailable || m.availability > 0)
        .slice(0, limit);
      return { opportunity_id: o.id, status: o.status, candidates: rows.map(matchView) };
    });
  }

  // --- applications ------------------------------------------------------------------------

  async apply(p: Principal, tenant: string | undefined, id: string, note: string | null) {
    requireRole(p, WORKFORCE);
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const me = await this.me(tx, p);
      const o = await this.opportunities.get(tx, id);
      if (!o || o.status !== 'open')
        throw new NotFoundError('OPPORTUNITY_NOT_FOUND', 'No such open opportunity.');
      if (!me.marketplaceOptIn && o.type !== 'project')
        throw new DomainRuleError('NOT_OPTED_IN', 'Opt in to the marketplace to apply.');
      return applicationView(
        await this.newApplication(tx, tenantId, o, me.employeeId, 'application', note, p.subject),
      );
    });
  }

  async invite(
    p: Principal,
    tenant: string | undefined,
    id: string,
    employeeId: string,
    note: string | null,
  ) {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const o = await this.owned(tx, p, id);
      if (o.status !== 'open')
        throw new DomainRuleError('OPPORTUNITY_NOT_OPEN', 'Publish the opportunity first.');
      const e = await this.employees.get(tx, employeeId);
      if (!e || e.status !== 'active')
        throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      return applicationView(
        await this.newApplication(tx, tenantId, o, employeeId, 'invitation', note, p.subject),
      );
    });
  }

  private async newApplication(
    tx: Tx,
    tenantId: string,
    o: Opportunity,
    employeeId: string,
    kind: Application['kind'],
    note: string | null,
    by: string,
  ): Promise<Application> {
    const a: Application = {
      tenantId,
      id: newId(),
      opportunityId: o.id,
      employeeId,
      kind,
      status: 'pending',
      note,
      disclosedToManager: false,
      createdBy: by,
      decidedBy: null,
      decidedAt: null,
      allocationId: null,
      createdAt: this.clock.now(),
    };
    if (!(await this.opportunities.insertApplication(tx, a)))
      throw new ConflictError(
        'ALREADY_APPLIED',
        'This employee already has an application or invitation here.',
      );
    return a;
  }

  async applications(p: Principal, tenant: string | undefined, id: string) {
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const o = await this.owned(tx, p, id);
      return {
        opportunity_id: o.id,
        applications: (await this.opportunities.applications(tx, { opportunityId: o.id })).map(
          applicationView,
        ),
      };
    });
  }

  /**
   * An employee's applications: all of them for the employee and HR; for their *current*
   * manager only those the employee disclosed, unless the tenant's policy says otherwise
   * (PRD §2.5d privacy of internal job seeking).
   */
  async employeeApplications(p: Principal, tenant: string | undefined, employeeId: string) {
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const e = await this.employees.get(tx, employeeId);
      if (!e) throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      const self = e.userId === p.subject;
      const manager = e.managerUserId === p.subject;
      if (!self && !manager && !hasAnyRole(p, ADMINS))
        throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      let rows = await this.opportunities.applications(tx, { employeeId });
      if (!self && !hasAnyRole(p, ADMINS)) {
        const policy = await this.employees.policy(tx);
        if (!policy.applicationsVisibleToManager) rows = rows.filter((a) => a.disclosedToManager);
      }
      return { employee_id: employeeId, applications: rows.map(applicationView) };
    });
  }

  async decide(
    p: Principal,
    tenant: string | undefined,
    applicationId: string,
    action: 'accept' | 'decline' | 'withdraw' | 'disclose',
  ) {
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const a = await this.opportunities.application(tx, applicationId);
      if (!a) throw new NotFoundError('APPLICATION_NOT_FOUND', 'Application not found.');
      const o = await this.opportunities.get(tx, a.opportunityId);
      if (!o) throw new NotFoundError('APPLICATION_NOT_FOUND', 'Application not found.');
      const me = await this.employees.byUser(tx, p.subject);
      const actor =
        me?.employeeId === a.employeeId
          ? 'employee'
          : o.ownerUserId === p.subject || hasAnyRole(p, ADMINS)
            ? 'owner'
            : null;
      if (actor === null)
        throw new NotFoundError('APPLICATION_NOT_FOUND', 'Application not found.');
      if (action === 'disclose') {
        if (actor !== 'employee')
          throw new ForbiddenError('Only the employee can disclose their application.');
        const done = await this.opportunities.updateApplication(tx, a.id, a.status, {
          disclosedToManager: true,
        });
        return applicationView(done ?? a);
      }
      if (a.status !== 'pending')
        throw new DomainRuleError('APPLICATION_DECIDED', `The application is already ${a.status}.`);
      if (!canDecide(a.kind, action, actor))
        throw new ForbiddenError(`You cannot ${action} this ${a.kind}.`);
      const now = this.clock.now();
      let allocationId: string | null = null;
      if (action === 'accept') {
        if (o.status !== 'open')
          throw new DomainRuleError('OPPORTUNITY_NOT_OPEN', 'The opportunity is no longer open.');
        if (o.projectId) {
          allocationId = (
            await this.book(
              tx,
              tenantId,
              {
                projectId: o.projectId,
                employeeId: a.employeeId,
                percent: o.allocationPct,
                start: o.startDate,
                end: exclusiveEnd({ start: o.startDate, end: o.endDate }),
                source: 'opportunity',
                opportunityId: o.id,
              },
              p.subject,
            )
          ).id;
        }
      }
      const status =
        action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'withdrawn';
      const done = await this.opportunities.updateApplication(tx, a.id, 'pending', {
        status,
        decidedBy: p.subject,
        decidedAt: now,
        allocationId,
      });
      if (!done)
        throw new ConflictError('CONCURRENT_UPDATE', 'The application changed; reload it.');
      return applicationView(done);
    });
  }

  // --- projects and allocations -------------------------------------------------------------

  async createProject(
    p: Principal,
    tenant: string | undefined,
    input: { name: string; account_id: string | null; start_date: string; end_date: string | null },
  ) {
    requireRole(p, MANAGERS);
    const tenantId = tenantOf(p, tenant);
    const project: Project = {
      tenantId,
      id: newId(),
      name: input.name,
      accountId: input.account_id,
      startDate: input.start_date,
      endDate: input.end_date,
      status: 'active',
      createdBy: p.subject,
    };
    await withTenantTx(this.db, tenantId, (tx) => this.projects.insert(tx, project));
    return { project_id: project.id, ...input, status: project.status };
  }

  async allocate(
    p: Principal,
    tenant: string | undefined,
    projectId: string,
    input: { employee_id: string; percent: number; start_date: string; end_date: string | null },
  ) {
    requireRole(p, MANAGERS);
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      if (!(await this.projects.get(tx, projectId)))
        throw new NotFoundError('PROJECT_NOT_FOUND', 'Project not found.');
      if (!(await this.employees.get(tx, input.employee_id)))
        throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      const a = await this.book(
        tx,
        tenantId,
        {
          projectId,
          employeeId: input.employee_id,
          percent: input.percent,
          start: input.start_date,
          end: exclusiveEnd({ start: input.start_date, end: input.end_date }),
          source: 'manual',
          opportunityId: null,
        },
        p.subject,
      );
      return {
        allocation_id: a.id,
        project_id: projectId,
        employee_id: a.employeeId,
        percent: a.percent,
        start_date: a.start,
        end_date: input.end_date,
      };
    });
  }

  async removeAllocation(p: Principal, tenant: string | undefined, allocationId: string) {
    requireRole(p, MANAGERS);
    const tenantId = tenantOf(p, tenant);
    await withTenantTx(this.db, tenantId, async (tx) => {
      const a = await this.projects.removeAllocation(tx, allocationId);
      if (!a) throw new NotFoundError('ALLOCATION_NOT_FOUND', 'Allocation not found.');
      await this.announce(tx, tenantId, a, 'deleted');
    });
  }

  async employeeAllocations(p: Principal, tenant: string | undefined, employeeId: string) {
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const e = await this.employees.get(tx, employeeId);
      if (!e) throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      if (e.userId !== p.subject && e.managerUserId !== p.subject && !hasAnyRole(p, MANAGERS))
        throw new NotFoundError('EMPLOYEE_NOT_FOUND', 'Employee not found.');
      const rows = (await this.projects.allocations(tx, [employeeId])).get(employeeId) ?? [];
      return {
        employee_id: employeeId,
        allocations: rows.map((a) => ({
          allocation_id: a.id,
          project_id: a.projectId,
          percent: a.percent,
          start_date: a.start,
          end_exclusive: a.end,
          source: a.source,
        })),
      };
    });
  }

  /** Books time; the database refuses anything over 100% on any day (trigger, ADR-0009 §3). */
  private async book(
    tx: Tx,
    tenantId: string,
    input: Omit<AllocationRow, 'id'>,
    by: string,
  ): Promise<AllocationRow> {
    const a: AllocationRow = { ...input, id: newId() };
    try {
      await this.projects.allocate(tx, a, by);
    } catch (error) {
      if (error instanceof CapacityExceededError)
        throw new ConflictError(
          'ALLOCATION_EXCEEDS_CAPACITY',
          'This booking would take the employee over 100%.',
        );
      throw error;
    }
    await this.announce(tx, tenantId, a, 'created');
    return a;
  }

  private async announce(
    tx: Tx,
    tenantId: string,
    a: AllocationRow,
    change: 'created' | 'deleted',
  ) {
    const end =
      a.end === null
        ? null
        : new Date(new Date(`${a.end}T00:00:00Z`).getTime() - 86_400_000)
            .toISOString()
            .slice(0, 10);
    await appendOutbox(
      tx,
      AllocationChanged.build({
        tenantId,
        aggregateId: a.employeeId,
        payload: {
          tenant_id: tenantId,
          employee_id: a.employeeId,
          allocation_id: a.id,
          project_id: a.projectId,
          change,
          percent: a.percent,
          start_date: a.start,
          end_date: end,
          occurred_at: this.clock.now().toISOString(),
        },
      }),
    );
    // Availability changed: re-score this employee's matches only (PRD §2.5(c) step 4).
    await this.work.enqueue(tx, {
      tenantId,
      kind: 'employee',
      subjectId: a.employeeId,
      reason: 'allocation_changed',
    });
  }
}
