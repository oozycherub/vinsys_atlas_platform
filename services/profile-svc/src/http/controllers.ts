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
import { type Role, TENANT_ROLES } from '@atlas/contracts';
import {
  assertIdempotencyKey,
  CurrentPrincipal,
  DATABASE,
  type Database,
  NotFoundError,
  parseInput,
  type Principal,
  Public,
  Roles,
  Scopes,
  ServiceUnavailableError,
} from '@atlas/platform';
import { CandidateService } from '../application/candidate.service';
import { DocumentService } from '../application/document.service';
import { EvidenceService } from '../application/evidence.service';
import { PrivacyService } from '../application/privacy.service';
import { type CandidateView } from '../application/views';
import {
  attributesFrom,
  createCandidateBody,
  etag,
  evidenceBody,
  initiateUploadBody,
  listCandidatesQuery,
  parseIfMatch,
  patchCandidateBody,
  privacyRequestBody,
  skillsQuery,
  storageEventBody,
  storageKeys,
  sweepQuery,
  tenantQuery,
} from './dto';

const ANY: Role[] = [...TENANT_ROLES, 'super_admin', 'service'];
const WRITERS: Role[] = ['tenant_admin', 'recruiter', 'hiring_manager', 'super_admin', 'service'];

interface HeaderSink {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

@Controller('v1')
export class CandidatesController {
  constructor(
    private readonly candidates: CandidateService,
    private readonly evidence: EvidenceService,
  ) {}

  @Post('candidates')
  @Roles(...WRITERS)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<CandidateView> {
    const idem = assertIdempotencyKey(key);
    const input = parseInput(createCandidateBody, body);
    const result = await this.candidates.create(
      principal,
      {
        ...(input.tenant_id ? { tenantId: input.tenant_id } : {}),
        source: input.source,
        pii: input.pii,
        attributes: attributesFrom(input),
      },
      idem,
    );
    res.status(result.status);
    res.setHeader('ETag', etag(result.body.version));
    res.setHeader('Location', `/v1/candidates/${result.body.candidate_id}`);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  /** `?email=` is an exact match through the blind index (pii:read); otherwise a page. */
  @Get('candidates')
  @Roles(...ANY)
  async list(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    const q = parseInput(listCandidatesQuery, query, 'query');
    if (q.email !== undefined) {
      return {
        items: await this.candidates.findByEmail(principal, q.email, q.tenant_id),
        next_cursor: null,
      };
    }
    return this.candidates.list(
      principal,
      { limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) },
      q.tenant_id,
    );
  }

  @Get('candidates/:id')
  @Roles(...ANY)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<CandidateView> {
    const view = await this.candidates.get(
      principal,
      id,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    res.setHeader('Cache-Control', 'no-store');
    return view;
  }

  @Patch('candidates/:id')
  @Roles(...ANY)
  async patch(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<CandidateView> {
    const version = parseIfMatch(ifMatch);
    const input = parseInput(patchCandidateBody, body);
    const view = await this.candidates.patch(
      principal,
      id,
      { ...(input.pii ? { pii: input.pii } : {}), attributes: attributesFrom(input) },
      version,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Post('candidates/:id/skill-evidence')
  @Roles(...ANY)
  @HttpCode(201)
  addEvidence(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(evidenceBody, body);
    return this.evidence.record(
      principal,
      id,
      input.evidence.map((e) => ({
        skillId: e.skill_id,
        source: e.source,
        proficiency: e.proficiency,
        confidence: e.confidence,
        sourceRef: e.source_ref ?? null,
        reason: e.reason ?? null,
        ...(e.observed_at ? { observedAt: new Date(e.observed_at) } : {}),
        validUntil: e.valid_until ? new Date(e.valid_until) : null,
      })),
      input.tenant_id,
    );
  }

  @Get('candidates/:id/skills')
  @Roles(...ANY)
  skills(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const q = parseInput(skillsQuery, query, 'query');
    return this.evidence.skills(principal, id, q.include === 'evidence', q.tenant_id);
  }
}

@Controller('v1')
export class DocumentsController {
  constructor(private readonly documents: DocumentService) {}

  @Post('documents\\:initiateUpload')
  @Roles(...WRITERS)
  @HttpCode(201)
  initiate(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const input = parseInput(initiateUploadBody, body);
    return this.documents.initiateUpload(
      principal,
      {
        candidateId: input.candidate_id,
        mimeType: input.mime_type,
        byteSize: input.byte_size,
        sha256: input.sha256,
      },
      input.tenant_id,
    );
  }

  @Get('documents/:id')
  @Roles(...ANY)
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Query() query: unknown) {
    return this.documents.get(principal, id, parseInput(tenantQuery, query, 'query').tenant_id);
  }

  /** Storage notifications (S3 event → webhook/queue bridge). Service role, scope storage-events:write. */
  @Post('internal/storage-events')
  @Roles('service')
  @Scopes('storage-events:write')
  @HttpCode(200)
  async storageEvents(@Body() body: unknown) {
    const results: { key: string; status: string }[] = [];
    for (const key of storageKeys(parseInput(storageEventBody, body))) {
      results.push({ key, status: await this.documents.objectCreated(key) });
    }
    return { results };
  }
}

@Controller('v1')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Post('privacy/requests')
  @Roles('tenant_admin', 'super_admin')
  @HttpCode(201)
  request(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    const input = parseInput(privacyRequestBody, body);
    return this.privacy.request(
      principal,
      { type: input.type, candidateId: input.candidate_id },
      input.tenant_id,
    );
  }

  @Get('privacy/requests/:id')
  @Roles('tenant_admin', 'super_admin')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.privacy.get(principal, id, parseInput(tenantQuery, query, 'query').tenant_id);
  }

  /** Scheduler endpoints (per tenant): retention erasure and overdue acknowledgements. */
  @Post('privacy\\:sweepRetention')
  @Roles('service', 'super_admin')
  @HttpCode(200)
  sweepRetention(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    const q = parseInput(sweepQuery, query, 'query');
    return this.privacy.sweepRetention(principal, q.limit, q.tenant_id);
  }

  @Post('privacy\\:sweepOverdue')
  @Roles('service', 'super_admin')
  @HttpCode(200)
  sweepOverdue(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    return this.privacy.sweepOverdue(principal, parseInput(sweepQuery, query, 'query').tenant_id);
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

export { NotFoundError };
