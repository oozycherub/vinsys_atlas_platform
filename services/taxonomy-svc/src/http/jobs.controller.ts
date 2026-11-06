import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  CurrentPrincipal,
  NotFoundError,
  parseInput,
  type Principal,
  Roles,
} from '@atlas/platform';
import { JobService } from '../application/job.service';
import { type JobProfileView, type Page } from '../application/views';
import {
  createProfileBody,
  customMethod,
  etag,
  familyBody,
  listProfilesQuery,
  parseIfMatch,
  parseOptionalIfMatch,
  patchProfileBody,
  profileSkillsBody,
  roleBody,
  rolesQuery,
  tenantQuery,
} from './dto';
import { READ_ROLES, WRITE_ROLES } from './skills.controller';

interface HeaderSink {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

/** Job families → roles → profiles with required skills (tenant-scoped). */
@Controller('v1')
export class JobsController {
  constructor(private readonly jobs: JobService) {}

  @Post('job-families')
  @Roles(...WRITE_ROLES)
  createFamily(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    return this.jobs.createFamily(
      principal,
      parseInput(familyBody, body).name,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
  }

  @Get('job-families')
  @Roles(...READ_ROLES)
  listFamilies(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    return this.jobs.listFamilies(principal, parseInput(tenantQuery, query, 'query').tenant_id);
  }

  @Post('job-roles')
  @Roles(...WRITE_ROLES)
  createRole(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    const input = parseInput(roleBody, body);
    return this.jobs.createRole(
      principal,
      { jobFamilyId: input.job_family_id, name: input.name, level: input.level },
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
  }

  @Get('job-roles')
  @Roles(...READ_ROLES)
  listRoles(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    const q = parseInput(rolesQuery, query, 'query');
    return this.jobs.listRoles(principal, q.job_family_id, q.tenant_id);
  }

  @Post('job-profiles')
  @Roles(...WRITE_ROLES)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<JobProfileView> {
    const input = parseInput(createProfileBody, body);
    const view = await this.jobs.create(
      principal,
      { title: input.title, description: input.description, jobRoleId: input.job_role_id },
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.status(201);
    res.setHeader('ETag', etag(view.version));
    res.setHeader('Location', `/v1/job-profiles/${view.job_profile_id}`);
    return view;
  }

  @Get('job-profiles')
  @Roles(...READ_ROLES)
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<Page<JobProfileView>> {
    const q = parseInput(listProfilesQuery, query, 'query');
    return this.jobs.list(
      principal,
      {
        limit: q.limit,
        ...(q.status ? { status: q.status } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
      },
      q.tenant_id,
    );
  }

  @Get('job-profiles/:id')
  @Roles(...READ_ROLES)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<JobProfileView> {
    const view = await this.jobs.get(
      principal,
      id,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Patch('job-profiles/:id')
  @Roles(...WRITE_ROLES)
  async patch(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<JobProfileView> {
    const version = parseIfMatch(ifMatch);
    const input = parseInput(patchProfileBody, body);
    const view = await this.jobs.patch(
      principal,
      id,
      {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.job_role_id !== undefined ? { jobRoleId: input.job_role_id } : {}),
      },
      version,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Put('job-profiles/:id/skills')
  @Roles(...WRITE_ROLES)
  async putSkills(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<JobProfileView> {
    const version = parseIfMatch(ifMatch);
    const input = parseInput(profileSkillsBody, body);
    const view = await this.jobs.setSkills(
      principal,
      id,
      input.skills.map((s) => ({
        skillId: s.skill_id,
        weight: s.weight,
        targetProficiency: s.target_proficiency,
        mustHave: s.must_have,
      })),
      version,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  /** POST /v1/job-profiles/{id}:publish | :archive */
  @Post('job-profiles/:idAndMethod')
  @Roles(...WRITE_ROLES)
  @HttpCode(200)
  async lifecycle(
    @CurrentPrincipal() principal: Principal,
    @Param('idAndMethod') segment: string,
    @Query() query: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<JobProfileView> {
    const { id, method } = customMethod(segment);
    const tenantId = parseInput(tenantQuery, query, 'query').tenant_id;
    const version = parseOptionalIfMatch(ifMatch);
    let view: JobProfileView;
    if (method === 'publish') view = await this.jobs.publish(principal, id, version, tenantId);
    else if (method === 'archive') view = await this.jobs.archive(principal, id, version, tenantId);
    else throw new NotFoundError('ROUTE_NOT_FOUND', `No operation matches "${segment}".`);
    res.setHeader('ETag', etag(view.version));
    return view;
  }
}
