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
  isUuid,
  NotFoundError,
  parseInput,
  type Principal,
  Roles,
} from '@atlas/platform';
import { AdminService } from '../application/admin.service';
import { SigningKeyService } from '../application/signing-key.service';
import { UserService } from '../application/user.service';
import { type SsoConnectionView, type UserPage, type UserView } from '../application/views';
import {
  etag,
  inviteBody,
  lifecycleBody,
  listUsersQuery,
  parseIfMatch,
  parseOptionalIfMatch,
  patchUserBody,
  serviceClientBody,
  ssoBody,
  tenantQuery,
} from './dto';

interface HeaderSink {
  status(code: number): unknown;
  setHeader(name: string, value: string): void;
}

function userIdParam(id: string): string {
  if (!isUuid(id)) throw new NotFoundError('USER_NOT_FOUND', 'User not found.');
  return id;
}

/** Tenant user management (docs/prompts/02-identity-svc.md §4). */
@Controller('v1')
export class UsersController {
  constructor(private readonly users: UserService) {}

  @Post('users\\:invite')
  @Roles('tenant_admin', 'super_admin')
  async invite(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<UserView> {
    const input = parseInput(inviteBody, body);
    const view = await this.users.invite(principal, {
      ...(input.tenant_id ? { tenantId: input.tenant_id } : {}),
      email: input.email,
      displayName: input.display_name,
      roles: input.roles,
      ...(input.business_unit_ids ? { businessUnitIds: input.business_unit_ids } : {}),
    });
    res.status(201);
    res.setHeader('ETag', etag(view.version));
    res.setHeader('Location', `/v1/users/${view.user_id}`);
    return view;
  }

  @Get('users')
  @Roles('tenant_admin', 'super_admin')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<UserPage> {
    const q = parseInput(listUsersQuery, query, 'query');
    return this.users.list(principal, {
      limit: q.limit,
      ...(q.tenant_id ? { tenantId: q.tenant_id } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
  }

  @Get('users/:id')
  @Roles('tenant_admin', 'super_admin')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<UserView> {
    const { tenant_id } = parseInput(tenantQuery, query, 'query');
    const view = await this.users.get(principal, userIdParam(id), tenant_id);
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Patch('users/:id')
  @Roles('tenant_admin', 'super_admin')
  async patch(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<UserView> {
    const version = parseIfMatch(ifMatch);
    const { tenant_id } = parseInput(tenantQuery, query, 'query');
    const input = parseInput(patchUserBody, body);
    const view = await this.users.patch(
      principal,
      userIdParam(id),
      {
        ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
        ...(input.roles !== undefined ? { roles: input.roles } : {}),
        ...(input.business_unit_ids !== undefined
          ? { businessUnitIds: input.business_unit_ids }
          : {}),
      },
      version,
      tenant_id,
    );
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  /** POST /v1/users/{id}:deactivate | :resendInvitation (AIP-136 custom methods). */
  @Post('users/:idAndMethod')
  @Roles('tenant_admin', 'super_admin')
  @HttpCode(200)
  async customMethod(
    @CurrentPrincipal() principal: Principal,
    @Param('idAndMethod') segment: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<UserView> {
    const separator = segment.lastIndexOf(':');
    const id = segment.slice(0, separator);
    const method = segment.slice(separator + 1);
    if (separator < 0 || !['deactivate', 'resendInvitation'].includes(method) || !isUuid(id)) {
      throw new NotFoundError('ROUTE_NOT_FOUND', `No operation matches "${segment}".`);
    }
    parseInput(lifecycleBody, body ?? {});
    const { tenant_id } = parseInput(tenantQuery, query, 'query');
    const view =
      method === 'resendInvitation'
        ? await this.users.resendInvitation(principal, id, tenant_id)
        : await this.users.deactivate(principal, id, parseOptionalIfMatch(ifMatch), tenant_id);
    res.setHeader('ETag', etag(view.version));
    return view;
  }
}

/** SSO federation config, machine clients and signing-key rotation. */
@Controller('v1')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly keys: SigningKeyService,
  ) {}

  @Get('sso-connections/:tenantId')
  @Roles('tenant_admin', 'super_admin')
  async getSso(
    @CurrentPrincipal() principal: Principal,
    @Param('tenantId') tenantId: string,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<SsoConnectionView> {
    if (!isUuid(tenantId)) throw new NotFoundError('NOT_FOUND', 'Not found.');
    const view = await this.admin.getSso(principal, tenantId);
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Put('sso-connections/:tenantId')
  @Roles('tenant_admin', 'super_admin')
  async putSso(
    @CurrentPrincipal() principal: Principal,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<SsoConnectionView> {
    if (!isUuid(tenantId)) throw new NotFoundError('NOT_FOUND', 'Not found.');
    const input = parseInput(ssoBody, body);
    const { view, created } = await this.admin.putSso(
      principal,
      tenantId,
      {
        protocol: input.protocol,
        enforced: input.enforced,
        metadata: input.metadata,
        domainHints: input.domain_hints,
        jitRole: input.jit_role,
        ...(input.protocol === 'oidc' && input.client_secret
          ? { clientSecret: input.client_secret }
          : {}),
      },
      parseOptionalIfMatch(ifMatch),
    );
    res.status(created ? 201 : 200);
    res.setHeader('ETag', etag(view.version));
    return view;
  }

  @Post('service-clients')
  @Roles('super_admin')
  async createServiceClient(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<{
    client_id: string;
    client_secret: string;
    tenant_id: string | null;
    scopes: string[];
  }> {
    const input = parseInput(serviceClientBody, body);
    const created = await this.admin.createServiceClient(principal, {
      name: input.name,
      tenantId: input.tenant_id,
      scopes: input.scopes,
      description: input.description,
    });
    res.status(201);
    res.setHeader('Cache-Control', 'no-store');
    return created;
  }

  @Post('signing-keys\\:rotate')
  @Roles('super_admin')
  @HttpCode(200)
  async rotate(): Promise<{ kid: string; activates_at: string }> {
    const { kid, activatesAt } = await this.keys.rotate();
    return { kid, activates_at: activatesAt.toISOString() };
  }
}
