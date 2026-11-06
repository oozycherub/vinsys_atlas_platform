import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { type Role } from '@atlas/contracts';
import {
  CurrentPrincipal,
  DATABASE,
  type Database,
  isUuid,
  NotFoundError,
  parseInput,
  type Principal,
  Public,
  Roles,
  ServiceUnavailableError,
} from '@atlas/platform';
import { AttritionService } from '../application/attrition.service';
import { CatalogueService } from '../application/catalogue.service';
import { DemandService } from '../application/demand.service';
import { MarketplaceService } from '../application/marketplace.service';
import { type EmployeeInput, WorkforceService } from '../application/workforce.service';
import {
  alertsQuery,
  allocationBody,
  applyBody,
  bulkEmployeesBody,
  computeBody,
  demandsQuery,
  employeeBody,
  feedQuery,
  inviteBody,
  learningItemBody,
  opportunityBody,
  policyBody,
  projectBody,
  recommendBody,
  skillGapQuery,
  tenantQuery,
  transitionBody,
  uploadBody,
} from './dto';

/** Coarse gate; services apply the fine-grained rules (owner, self, manager, scopes). */
const ANYONE: Role[] = [
  'tenant_admin',
  'hiring_manager',
  'recruiter',
  'reviewer',
  'employee',
  'super_admin',
  'service',
];

function id(raw: string, what = 'RESOURCE'): string {
  if (!isUuid(raw)) throw new NotFoundError(`${what}_NOT_FOUND`, 'Not found.');
  return raw.toLowerCase();
}
const tenant = (q: unknown) => parseInput(tenantQuery, q, 'query').tenant_id;

function toEmployeeInput(employeeId: string, raw: unknown): EmployeeInput {
  const b = parseInput(employeeBody, raw);
  return {
    employeeId,
    userId: b.user_id,
    managerUserId: b.manager_user_id,
    department: b.department,
    location: b.location,
    jobProfileId: b.job_profile_id,
    hiredAt: b.hired_at,
    roleStartedAt: b.role_started_at,
    lastPromotionAt: b.last_promotion_at,
    managerChangedAt: b.manager_changed_at,
    compaRatio: b.compa_ratio,
    engagementDelta: b.engagement_delta,
    overtimeHours4w: b.overtime_hours_4w,
    marketplaceOptIn: b.marketplace_opt_in,
    status: b.status,
    terminatedAt: b.terminated_at,
    terminationVoluntary: b.termination_voluntary,
    sourceSyncedAt: b.source_synced_at,
    protectedAttributes: b.protected_attributes,
  };
}

@Controller('v1')
export class WorkforceController {
  constructor(
    private readonly workforce: WorkforceService,
    private readonly catalogue: CatalogueService,
  ) {}

  @Put('employees/:id')
  @Roles(...ANYONE)
  async upsert(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    const employeeId = id(raw, 'EMPLOYEE');
    await this.workforce.upsert(p, tenant(q), [toEmployeeInput(employeeId, body)]);
    return { employee_id: employeeId, synced: true };
  }

  @Post('employees\\:bulkUpsert')
  @Roles(...ANYONE)
  @HttpCode(200)
  async bulk(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    const b = parseInput(bulkEmployeesBody, body);
    const rows = b.employees.map((raw, i) => {
      const { employee_id, ...rest } = raw;
      try {
        return toEmployeeInput(employee_id.toLowerCase(), rest);
      } catch (error) {
        (error as { message: string }).message = `employees[${i}]: ${(error as Error).message}`;
        throw error;
      }
    });
    return this.workforce.upsert(p, tenant(q), rows);
  }

  @Get('employees/me')
  @Roles(...ANYONE)
  me(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.workforce.me(p, tenant(q));
  }

  @Get('employees/:id')
  @Roles(...ANYONE)
  get(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.workforce.get(p, tenant(q), id(raw, 'EMPLOYEE'));
  }

  @Get('employees/:id/career-paths')
  @Roles(...ANYONE)
  careerPaths(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.workforce.careerPaths(p, tenant(q), id(raw, 'EMPLOYEE'));
  }

  @Get('intelligence/policy')
  @Roles(...ANYONE)
  async policy(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const x = await this.workforce.policy(p, tenant(q));
    return {
      applications_visible_to_manager: x.applicationsVisibleToManager,
      learning_hours_per_day: x.learningHoursPerDay,
      attrition_threshold: x.attritionThreshold,
    };
  }

  @Put('intelligence/policy')
  @Roles(...ANYONE)
  async setPolicy(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    const b = parseInput(policyBody, body);
    const x = await this.workforce.setPolicy(p, tenant(q), {
      applicationsVisibleToManager: b.applications_visible_to_manager,
      learningHoursPerDay: b.learning_hours_per_day,
      attritionThreshold: b.attrition_threshold,
    });
    return {
      applications_visible_to_manager: x.applicationsVisibleToManager,
      learning_hours_per_day: x.learningHoursPerDay,
      attrition_threshold: x.attritionThreshold,
    };
  }

  @Get('analytics/skill-gaps')
  @Roles(...ANYONE)
  skillGaps(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const x = parseInput(skillGapQuery, q, 'query');
    return this.workforce.skillGaps(p, x.tenant_id, x.group_by, Number(x.period.slice(0, -1)));
  }

  @Get('job-profile-transitions')
  @Roles(...ANYONE)
  async transitions(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return {
      transitions: (await this.catalogue.transitions(p, tenant(q))).map((t) => ({
        from_profile_id: t.from,
        to_profile_id: t.to,
        transition_type: t.type,
        typical_months: t.typicalMonths,
      })),
    };
  }

  @Put('job-profile-transitions')
  @Roles(...ANYONE)
  async putTransition(
    @CurrentPrincipal() p: Principal,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    const b = parseInput(transitionBody, body);
    await this.catalogue.putTransition(p, tenant(q), {
      from: b.from_profile_id,
      to: b.to_profile_id,
      type: b.transition_type,
      typicalMonths: b.typical_months,
    });
    return b;
  }

  @Delete('job-profile-transitions/:from/:to')
  @Roles(...ANYONE)
  @HttpCode(204)
  async deleteTransition(
    @CurrentPrincipal() p: Principal,
    @Param('from') from: string,
    @Param('to') to: string,
    @Query() q: unknown,
  ) {
    await this.catalogue.deleteTransition(
      p,
      tenant(q),
      id(from, 'TRANSITION'),
      id(to, 'TRANSITION'),
    );
  }

  @Get('learning-items')
  @Roles(...ANYONE)
  async learningItems(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return { items: await this.catalogue.learningItems(p, tenant(q)) };
  }

  @Post('learning-items')
  @Roles(...ANYONE)
  async putLearningItem(
    @CurrentPrincipal() p: Principal,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    const b = parseInput(learningItemBody, body);
    return this.catalogue.putLearningItem(p, tenant(q), {
      ...(b.item_id ? { item_id: b.item_id } : {}),
      title: b.title,
      provider: b.provider,
      url: b.url,
      skill_ids: b.skill_ids.map((s) => s.toLowerCase()),
      duration_hours: b.duration_hours,
      external_ref: b.external_ref,
    });
  }
}

@Controller('v1')
export class MarketplaceController {
  constructor(private readonly market: MarketplaceService) {}

  @Post('opportunities')
  @Roles(...ANYONE)
  create(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    return this.market.create(p, tenant(q), parseInput(opportunityBody, body));
  }

  @Get('opportunities')
  @Roles(...ANYONE)
  feed(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const x = parseInput(feedQuery, q, 'query');
    return this.market.feed(p, x.tenant_id, x.limit);
  }

  @Get('opportunities/:id')
  @Roles(...ANYONE)
  get(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.market.get(p, tenant(q), id(raw, 'OPPORTUNITY'));
  }

  @Post('opportunities/:id\\:publish')
  @Roles(...ANYONE)
  @HttpCode(200)
  publish(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.market.move(p, tenant(q), id(raw, 'OPPORTUNITY'), 'open');
  }

  @Post('opportunities/:id\\:close')
  @Roles(...ANYONE)
  @HttpCode(200)
  close(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.market.move(p, tenant(q), id(raw, 'OPPORTUNITY'), 'closed');
  }

  @Post('opportunities/:id\\:recommendCandidates')
  @Roles(...ANYONE)
  @HttpCode(200)
  recommend(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    const b = parseInput(recommendBody, body ?? {});
    return this.market.recommend(
      p,
      tenant(q),
      id(raw, 'OPPORTUNITY'),
      b.limit,
      b.include_unavailable,
    );
  }

  @Post('opportunities/:id/applications')
  @Roles(...ANYONE)
  apply(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    return this.market.apply(
      p,
      tenant(q),
      id(raw, 'OPPORTUNITY'),
      parseInput(applyBody, body ?? {}).note,
    );
  }

  @Get('opportunities/:id/applications')
  @Roles(...ANYONE)
  applications(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.market.applications(p, tenant(q), id(raw, 'OPPORTUNITY'));
  }

  @Post('opportunities/:id/invitations')
  @Roles(...ANYONE)
  invite(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    const b = parseInput(inviteBody, body);
    return this.market.invite(
      p,
      tenant(q),
      id(raw, 'OPPORTUNITY'),
      b.employee_id.toLowerCase(),
      b.note,
    );
  }

  @Post('applications/:idAndVerb')
  @Roles(...ANYONE)
  @HttpCode(200)
  decide(@CurrentPrincipal() p: Principal, @Param('idAndVerb') raw: string, @Query() q: unknown) {
    const [appId = '', verb = ''] = raw.split(':');
    if (!['accept', 'decline', 'withdraw', 'disclose'].includes(verb))
      throw new NotFoundError('ROUTE_NOT_FOUND', 'No such action.');
    return this.market.decide(p, tenant(q), id(appId, 'APPLICATION'), verb as 'accept');
  }

  @Get('employees/:id/applications')
  @Roles(...ANYONE)
  employeeApplications(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
  ) {
    return this.market.employeeApplications(p, tenant(q), id(raw, 'EMPLOYEE'));
  }

  @Get('employees/:id/allocations')
  @Roles(...ANYONE)
  employeeAllocations(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
  ) {
    return this.market.employeeAllocations(p, tenant(q), id(raw, 'EMPLOYEE'));
  }

  @Post('projects')
  @Roles(...ANYONE)
  project(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    return this.market.createProject(p, tenant(q), parseInput(projectBody, body));
  }

  @Post('projects/:id/allocations')
  @Roles(...ANYONE)
  allocate(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    const b = parseInput(allocationBody, body);
    return this.market.allocate(p, tenant(q), id(raw, 'PROJECT'), {
      ...b,
      employee_id: b.employee_id.toLowerCase(),
    });
  }

  @Delete('allocations/:id')
  @Roles(...ANYONE)
  @HttpCode(204)
  async removeAllocation(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
  ) {
    await this.market.removeAllocation(p, tenant(q), id(raw, 'ALLOCATION'));
  }
}

@Controller('v1')
export class PlanningController {
  constructor(
    private readonly demands: DemandService,
    private readonly attrition: AttritionService,
  ) {}

  @Post('demands\\:upload')
  @Roles(...ANYONE)
  @HttpCode(202)
  upload(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    const b = parseInput(uploadBody, body);
    return this.demands.upload(p, tenant(q), b.file_name, Buffer.from(b.content_base64, 'base64'));
  }

  @Get('demand-batches/:id')
  @Roles(...ANYONE)
  batch(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.demands.batch(p, tenant(q), id(raw, 'BATCH'));
  }

  @Get('demands')
  @Roles(...ANYONE)
  list(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const x = parseInput(demandsQuery, q, 'query');
    return this.demands.list(p, x.tenant_id, {
      ...(x.status ? { status: x.status } : {}),
      ...(x.account_id ? { accountId: x.account_id } : {}),
      ...(x.batch_id ? { batchId: x.batch_id } : {}),
    });
  }

  @Post('fulfilment-plans\\:compute')
  @Roles(...ANYONE)
  @HttpCode(202)
  compute(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    const b = parseInput(computeBody, body ?? {});
    return this.demands.compute(p, tenant(q), b.account_id, b.horizon_days);
  }

  @Get('fulfilment-plans/:id')
  @Roles(...ANYONE)
  plan(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.demands.plan(p, tenant(q), id(raw, 'PLAN'));
  }

  @Get('attrition/alerts')
  @Roles(...ANYONE)
  alerts(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const x = parseInput(alertsQuery, q, 'query');
    return this.attrition.alerts(p, x.tenant_id, x.status ?? null, x.limit);
  }

  @Post('attrition/alerts/:id\\:acknowledge')
  @Roles(...ANYONE)
  @HttpCode(200)
  acknowledge(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.attrition.acknowledge(p, tenant(q), id(raw, 'ALERT'));
  }

  @Get('attrition/employees/:id')
  @Roles(...ANYONE)
  employee(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.attrition.employee(p, tenant(q), id(raw, 'EMPLOYEE'));
  }

  @Get('attrition/model')
  @Roles(...ANYONE)
  model(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.attrition.model(p, tenant(q));
  }
}

@Controller()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get('healthz')
  @Public()
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  async readyz(): Promise<{ status: 'ready' }> {
    try {
      await this.db.ping();
    } catch {
      throw new ServiceUnavailableError('NOT_READY', 'The database is not reachable.');
    }
    return { status: 'ready' };
  }
}
