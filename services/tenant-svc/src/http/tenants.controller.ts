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
  assertIdempotencyKey,
  CurrentPrincipal,
  isUuid,
  NotFoundError,
  parseInput,
  type Principal,
  Roles,
} from '@atlas/platform';
import { TenantService } from '../application/tenant.service';
import { type TenantPage, type TenantView } from '../application/tenant-view';
import { LIFECYCLE_ACTIONS, type LifecycleAction } from '../domain/tenant';
import {
  createTenantBody,
  etag,
  lifecycleBody,
  listTenantsQuery,
  parseIfMatch,
  parseOptionalIfMatch,
  patchTenantBody,
  retentionPolicyBody,
  settingsBody,
} from './dto';

interface HeaderSink {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

const CUSTOM_METHODS = [...LIFECYCLE_ACTIONS, 'rotateDataKey'] as const;
type CustomMethod = (typeof CUSTOM_METHODS)[number];

/** Splits `{uuid}:{verb}` (AIP-136 custom methods) from a single path segment. */
function parseCustomMethod(segment: string): { tenantId: string; method: CustomMethod } {
  const separator = segment.lastIndexOf(':');
  const tenantId = segment.slice(0, separator);
  const method = segment.slice(separator + 1) as CustomMethod;
  if (separator < 0 || !isUuid(tenantId) || !CUSTOM_METHODS.includes(method)) {
    throw new NotFoundError('ROUTE_NOT_FOUND', `No operation matches "${segment}".`);
  }
  return { tenantId, method };
}

function tenantIdParam(id: string): string {
  if (!isUuid(id)) throw new NotFoundError('TENANT_NOT_FOUND', 'Tenant not found.');
  return id;
}

@Controller('v1/tenants')
export class TenantsController {
  constructor(private readonly service: TenantService) {}

  @Post()
  @Roles('super_admin')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TenantView> {
    const key = assertIdempotencyKey(idempotencyKey);
    const input = parseInput(createTenantBody, body);
    const result = await this.service.create(
      principal,
      {
        slug: input.slug,
        displayName: input.display_name,
        dataRegion: input.data_region,
        isolationTier: input.isolation_tier,
        ...(input.bootstrap_admin_email
          ? { bootstrapAdminEmail: input.bootstrap_admin_email }
          : {}),
      },
      key,
    );
    res.status(result.status);
    res.setHeader('ETag', etag(result.body.version));
    res.setHeader('Location', `/v1/tenants/${result.body.tenant_id}`);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get()
  @Roles('super_admin')
  list(@Query() query: unknown): Promise<TenantPage> {
    const q = parseInput(listTenantsQuery, query, 'query');
    return this.service.list({
      limit: q.limit,
      ...(q.status ? { status: q.status } : {}),
      ...(q.data_region ? { dataRegion: q.data_region } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
  }

  @Get(':id')
  @Roles('super_admin', 'tenant_admin')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TenantView> {
    const view = await this.service.get(principal, tenantIdParam(id));
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Patch(':id')
  @Roles('super_admin', 'tenant_admin')
  async patch(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TenantView> {
    const version = parseIfMatch(ifMatch);
    const input = parseInput(patchTenantBody, body);
    const view = await this.service.rename(
      principal,
      tenantIdParam(id),
      input.display_name,
      version,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Put(':id/settings')
  @Roles('super_admin', 'tenant_admin')
  async putSettings(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TenantView> {
    const version = parseIfMatch(ifMatch);
    const settings = parseInput(settingsBody, body);
    const view = await this.service.replaceSettings(
      principal,
      tenantIdParam(id),
      settings,
      version,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Put(':id/retention-policy')
  @Roles('super_admin')
  async putRetentionPolicy(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TenantView> {
    const version = parseIfMatch(ifMatch);
    const policy = parseInput(retentionPolicyBody, body);
    const view = await this.service.replaceRetentionPolicy(
      principal,
      tenantIdParam(id),
      policy,
      version,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  /** POST /v1/tenants/{id}:activate | :suspend | :reactivate | :offboard | :purge | :rotateDataKey */
  @Post(':idAndMethod')
  @Roles('super_admin')
  @HttpCode(200)
  async customMethod(
    @CurrentPrincipal() principal: Principal,
    @Param('idAndMethod') segment: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TenantView> {
    const { tenantId, method } = parseCustomMethod(segment);
    const version = parseOptionalIfMatch(ifMatch);
    const view =
      method === 'rotateDataKey'
        ? await this.service.rotateDataKey(principal, tenantId, version)
        : await this.service.changeLifecycle(
            principal,
            tenantId,
            method satisfies LifecycleAction,
            parseInput(lifecycleBody, body ?? {}).reason ?? null,
            version,
          );
    res.setHeader('ETag', etag(view.version));
    return view;
  }
}
