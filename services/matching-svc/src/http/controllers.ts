import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  assertIdempotencyKey,
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
import { READERS, WRITERS } from '../application/access';
import { MatchService } from '../application/match.service';
import { RequisitionService } from '../application/requisition.service';
import { type RequisitionView } from '../application/views';
import {
  calibrateBody,
  candidateMatchesQuery,
  createRequisitionBody,
  etag,
  listQuery,
  matchBody,
  parseIfMatch,
  patchRequisitionBody,
  tenantQuery,
} from './dto';

interface HeaderSink {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

function id(raw: string): string {
  if (!isUuid(raw))
    throw new NotFoundError('REQUISITION_NOT_FOUND', 'No such requisition in this tenant.');
  return raw;
}

@Controller('v1')
export class RequisitionsController {
  constructor(
    private readonly requisitions: RequisitionService,
    private readonly matches: MatchService,
  ) {}

  @Post('job-requisitions')
  @Roles(...WRITERS)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<RequisitionView> {
    const idem = assertIdempotencyKey(key);
    const result = await this.requisitions.create(
      principal,
      parseInput(createRequisitionBody, body),
      idem,
    );
    res.status(result.status);
    res.setHeader('ETag', etag(result.body.version));
    res.setHeader('Location', `/v1/job-requisitions/${result.body.requisition_id}`);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('job-requisitions')
  @Roles(...READERS)
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    return this.requisitions.list(principal, parseInput(listQuery, query, 'query'));
  }

  @Get('job-requisitions/:id')
  @Roles(...READERS)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<RequisitionView> {
    const view = await this.requisitions.get(
      principal,
      id(raw),
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Patch('job-requisitions/:id')
  @Roles(...WRITERS)
  async patch(
    @CurrentPrincipal() principal: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<RequisitionView> {
    const expected = parseIfMatch(ifMatch);
    const b = parseInput(patchRequisitionBody, body);
    const view = await this.requisitions.patch(
      principal,
      id(raw),
      {
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.openings !== undefined ? { openings: b.openings } : {}),
        ...(b.location !== undefined ? { location: b.location } : {}),
        ...(b.hiring_manager_id !== undefined ? { hiringManagerId: b.hiring_manager_id } : {}),
        ...(b.job_profile_id !== undefined ? { jobProfileId: b.job_profile_id } : {}),
        ...(b.min_experience_years !== undefined
          ? { minExperienceYears: b.min_experience_years }
          : {}),
        ...(b.keywords !== undefined ? { keywords: b.keywords } : {}),
        ...(b.status !== undefined ? { status: b.status } : {}),
      },
      expected,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Post('job-requisitions/:id\\:calibrate')
  @HttpCode(200)
  @Roles(...WRITERS)
  calibrate(
    @CurrentPrincipal() principal: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ): Promise<RequisitionView> {
    const b = parseInput(calibrateBody, body ?? {});
    return this.requisitions.calibrate(
      principal,
      id(raw),
      b.skills?.map((s) => ({ ...s })),
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
  }

  @Post('job-requisitions/:id\\:match')
  @HttpCode(200)
  @Roles(...WRITERS)
  match(@CurrentPrincipal() principal: Principal, @Param('id') raw: string, @Body() body: unknown) {
    const b = parseInput(matchBody, body ?? {});
    return this.matches.match(principal, id(raw), {
      ...(b.tenant_id ? { tenant_id: b.tenant_id } : {}),
      limit: b.limit,
      filters: b.filters,
    });
  }

  @Get('candidates/:id/matches')
  @Roles(...READERS)
  candidateMatches(
    @CurrentPrincipal() principal: Principal,
    @Param('id') raw: string,
    @Query() query: unknown,
  ) {
    if (!isUuid(raw)) throw new NotFoundError('CANDIDATE_NOT_FOUND', 'No such candidate.');
    return this.matches.candidateMatches(
      principal,
      raw,
      parseInput(candidateMatchesQuery, query, 'query'),
    );
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
