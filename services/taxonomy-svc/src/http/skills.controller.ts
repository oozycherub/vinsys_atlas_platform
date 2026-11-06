import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type Role, TENANT_ROLES } from '@atlas/contracts';
import {
  BadRequestError,
  CurrentPrincipal,
  DATABASE,
  type Database,
  NotFoundError,
  parseInput,
  type Principal,
  Public,
  Roles,
  ServiceUnavailableError,
} from '@atlas/platform';
import { ImportService, type ImportView } from '../application/import.service';
import { NormalizeService } from '../application/normalize.service';
import { SUGGESTION_REPOSITORY, type SuggestionRepository } from '../application/ports';
import { inScope, writeScope } from '../application/scope';
import { SkillService } from '../application/skill.service';
import { type Page, type SkillDetailView, type SkillView } from '../application/views';
import { type NormalizeResult } from '../domain/normalize';
import {
  createSkillBody,
  customMethod,
  deprecateBody,
  edgeBody,
  edgeQuery,
  etag,
  listSkillsQuery,
  normalizeBody,
  overrideBody,
  parseIfMatch,
  parseOptionalIfMatch,
  patchSkillBody,
  reembedQuery,
  suggestionsQuery,
  tenantQuery,
} from './dto';

/** Reads: any tenant user, platform staff and service principals. Writes: admins and the curator. */
export const READ_ROLES: Role[] = [...TENANT_ROLES, 'super_admin', 'service'];
export const WRITE_ROLES: Role[] = ['tenant_admin', 'super_admin'];
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

interface HeaderSink {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

@Controller('v1')
export class SkillsController {
  constructor(
    private readonly skills: SkillService,
    private readonly normalizer: NormalizeService,
  ) {}

  @Get('skills')
  @Roles(...READ_ROLES)
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<Page<SkillView>> {
    const q = parseInput(listSkillsQuery, query, 'query');
    return this.skills.list(
      principal,
      {
        ...(q.path ? { path: q.path } : {}),
        ...(q.q ? { q: q.q } : {}),
        ...(q.classification ? { classification: q.classification } : {}),
        ...(q.node_type ? { nodeType: q.node_type } : {}),
        includeDeprecated: q.include_deprecated === 'true',
        limit: q.limit,
        ...(q.cursor ? { cursor: q.cursor } : {}),
      },
      q.tenant_id,
    );
  }

  @Post('skills\\:normalize')
  @Roles(...READ_ROLES)
  @HttpCode(200)
  async normalize(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<{ results: NormalizeResult[] }> {
    const input = parseInput(normalizeBody, body);
    return { results: await this.normalizer.normalize(principal, input.terms, input.tenant_id) };
  }

  @Get('skills/:id')
  @Roles(...READ_ROLES)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<SkillDetailView> {
    const view = await this.skills.get(
      principal,
      id,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Post('skills')
  @Roles(...WRITE_ROLES)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<SkillView> {
    const input = parseInput(createSkillBody, body);
    const view = await this.skills.create(
      principal,
      {
        nodeType: input.node_type,
        path: input.path,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.classification ? { classification: input.classification } : {}),
        ...(input.aliases ? { aliases: input.aliases } : {}),
        ...(input.external_id !== undefined ? { externalId: input.external_id } : {}),
      },
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.status(201);
    res.setHeader('ETag', etag(view.version));
    res.setHeader('Location', `/v1/skills/${view.skill_id}`);
    return view;
  }

  @Patch('skills/:id')
  @Roles(...WRITE_ROLES)
  async patch(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<SkillView> {
    const version = parseIfMatch(ifMatch);
    const input = parseInput(patchSkillBody, body);
    const view = await this.skills.patch(
      principal,
      id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.classification !== undefined ? { classification: input.classification } : {}),
        ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
        ...(input.external_id !== undefined ? { externalId: input.external_id } : {}),
      },
      version,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  /** POST /v1/skills/{id}:deprecate {replaced_by} */
  @Post('skills/:idAndMethod')
  @Roles(...WRITE_ROLES)
  @HttpCode(200)
  async deprecate(
    @CurrentPrincipal() principal: Principal,
    @Param('idAndMethod') segment: string,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<SkillDetailView> {
    const { id, method } = customMethod(segment);
    if (method !== 'deprecate')
      throw new NotFoundError('ROUTE_NOT_FOUND', `No operation matches "${segment}".`);
    const input = parseInput(deprecateBody, body ?? {});
    return this.skills.deprecate(
      principal,
      id,
      input.replaced_by,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
  }

  @Put('skills/:id/override')
  @Roles(...WRITE_ROLES)
  async putOverride(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<SkillView> {
    const input = parseInput(overrideBody, body);
    return this.skills.putOverride(
      principal,
      id,
      {
        hidden: input.hidden,
        adopted: input.adopted,
        displayName: input.display_name,
        aliases: input.aliases,
      },
      parseOptionalIfMatch(ifMatch),
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
  }

  @Delete('skills/:id/override')
  @Roles(...WRITE_ROLES)
  @HttpCode(204)
  async deleteOverride(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<void> {
    await this.skills.deleteOverride(
      principal,
      id,
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
  }

  @Post('skill-edges')
  @Roles(...WRITE_ROLES)
  async addEdge(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<{
    tenant_id: string | null;
    src: string;
    dst: string;
    edge_type: string;
    weight: number;
  }> {
    const input = parseInput(edgeBody, body);
    const edge = await this.skills.addEdge(
      principal,
      { src: input.src, dst: input.dst, edgeType: input.edge_type, weight: input.weight },
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.status(201);
    return {
      tenant_id: edge.tenantId,
      src: edge.src,
      dst: edge.dst,
      edge_type: edge.edgeType,
      weight: edge.weight,
    };
  }

  @Delete('skill-edges')
  @Roles(...WRITE_ROLES)
  @HttpCode(204)
  async removeEdge(
    @CurrentPrincipal() principal: Principal,
    @Query() query: unknown,
  ): Promise<void> {
    const q = parseInput(edgeQuery, query, 'query');
    await this.skills.removeEdge(
      principal,
      { src: q.src, dst: q.dst, edgeType: q.edge_type },
      q.tenant_id,
    );
  }
}

@Controller('v1')
export class TaxonomyController {
  constructor(
    private readonly skills: SkillService,
    private readonly imports: ImportService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SUGGESTION_REPOSITORY) private readonly suggestions: SuggestionRepository,
  ) {}

  @Get('taxonomy/version')
  @Roles(...READ_ROLES)
  version(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    return this.skills.versionInfo(principal, parseInput(tenantQuery, query, 'query').tenant_id);
  }

  @Post('taxonomy\\:publish')
  @Roles(...WRITE_ROLES)
  @HttpCode(200)
  publish(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    return this.skills.publish(principal, parseInput(tenantQuery, query, 'query').tenant_id);
  }

  @Post('taxonomy\\:reembed')
  @Roles(...WRITE_ROLES)
  @HttpCode(200)
  reembed(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    const q = parseInput(reembedQuery, query, 'query');
    return this.skills.reembed(principal, q.limit, q.tenant_id);
  }

  /** Weakly matched raw terms (cosine 0.70–0.82) for the tenant's taxonomy admins. */
  @Get('skill-suggestions')
  @Roles(...WRITE_ROLES)
  async listSuggestions(@CurrentPrincipal() principal: Principal, @Query() query: unknown) {
    const q = parseInput(suggestionsQuery, query, 'query');
    const scope = writeScope(principal, q.tenant_id);
    if (!scope.tenantId)
      throw new NotFoundError('TENANT_ID_REQUIRED', 'Suggestions are per tenant: pass tenant_id.');
    const items = await inScope(this.db, scope, (tx) => this.suggestions.list(tx, q.limit));
    return {
      items: items.map((s) => ({
        term: s.term,
        best_skill_id: s.bestSkillId,
        best_score: s.bestScore,
        occurrences: s.occurrences,
        last_seen_at: s.lastSeenAt.toISOString(),
      })),
    };
  }

  /** Multipart upload (field `file`, .csv or .xlsx, ≤ 5 MB) → stored dry-run diff. */
  @Post('taxonomy-imports')
  @Roles(...WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(
    @CurrentPrincipal() principal: Principal,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<ImportView> {
    if (!file)
      throw new BadRequestError(
        'FILE_REQUIRED',
        'Upload the spreadsheet in the multipart field "file".',
      );
    const view = await this.imports.dryRun(
      principal,
      { name: file.originalname, mimeType: file.mimetype, content: file.buffer },
      parseInput(tenantQuery, query, 'query').tenant_id,
    );
    res.status(201);
    res.setHeader('Location', `/v1/taxonomy-imports/${view.import_id}`);
    return view;
  }

  @Get('taxonomy-imports/:id')
  @Roles(...WRITE_ROLES)
  getImport(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    return this.imports.get(principal, id, parseInput(tenantQuery, query, 'query').tenant_id);
  }

  /** POST /v1/taxonomy-imports/{id}:commit */
  @Post('taxonomy-imports/:idAndMethod')
  @Roles(...WRITE_ROLES)
  @HttpCode(200)
  commit(
    @CurrentPrincipal() principal: Principal,
    @Param('idAndMethod') segment: string,
    @Query() query: unknown,
  ) {
    const { id, method } = customMethod(segment);
    if (method !== 'commit')
      throw new NotFoundError('ROUTE_NOT_FOUND', `No operation matches "${segment}".`);
    return this.imports.commit(principal, id, parseInput(tenantQuery, query, 'query').tenant_id);
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
