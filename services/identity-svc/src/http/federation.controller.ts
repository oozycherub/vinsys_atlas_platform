import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  CurrentPrincipal,
  isUuid,
  NotFoundError,
  parseInput,
  type Principal,
  Public,
  Roles,
} from '@atlas/platform';
import { AdminService } from '../application/admin.service';
import { type AuthorizeRequest, FederationService } from '../application/federation.service';
import { type StaffAccountView } from '../application/views';
import { authorizeQuery, callbackQuery, samlAcsBody, staffBody } from './dto';

interface RedirectSink {
  setHeader(name: string, value: string): void;
  redirect(status: number, url: string): void;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

function slugParam(slug: string): string {
  if (!SLUG.test(slug)) throw new NotFoundError('TENANT_NOT_FOUND', 'Unknown organisation.');
  return slug;
}

function authorizeRequest(query: unknown): AuthorizeRequest {
  const q = parseInput(authorizeQuery, query, 'query');
  return {
    clientId: q.client_id,
    redirectUri: q.redirect_uri,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
    state: q.state,
  };
}

/** Redirects in a login flow carry one-time values: never cache them. */
function go(res: RedirectSink, url: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, url);
}

/**
 * Browser-facing federated sign-in. Start with the OAuth parameters of Atlas's own client
 * (PKCE S256); the flow ends with a redirect to that client carrying `code` and `state`,
 * which the client exchanges at POST /v1/oauth/token (grant authorization_code).
 */
@Controller('v1')
export class FederationController {
  constructor(private readonly federation: FederationService) {}

  @Get('sso/:slug/start')
  @Public()
  async start(
    @Param('slug') slug: string,
    @Query() query: unknown,
    @Res() res: RedirectSink,
  ): Promise<void> {
    go(res, await this.federation.startTenant(slugParam(slug), authorizeRequest(query)));
  }

  @Get('sso/:slug/callback')
  @Public()
  async callback(
    @Param('slug') slug: string,
    @Query() query: unknown,
    @Res() res: RedirectSink,
  ): Promise<void> {
    const q = parseInput(callbackQuery, query, 'query');
    go(res, await this.federation.oidcCallbackTenant(slugParam(slug), q));
  }

  /** SAML HTTP-POST binding (form-encoded SAMLResponse + RelayState). */
  @Post('sso/:slug/acs')
  @Public()
  async acs(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Res() res: RedirectSink,
  ): Promise<void> {
    const form = parseInput(samlAcsBody, body ?? {});
    // 303: the browser must follow with GET after a POST.
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, await this.federation.samlAcs(slugParam(slug), form));
  }

  @Get('staff/sso/start')
  @Public()
  async staffStart(@Query() query: unknown, @Res() res: RedirectSink): Promise<void> {
    go(res, await this.federation.startStaff(authorizeRequest(query)));
  }

  @Get('staff/sso/callback')
  @Public()
  async staffCallback(@Query() query: unknown, @Res() res: RedirectSink): Promise<void> {
    go(res, await this.federation.oidcCallbackStaff(parseInput(callbackQuery, query, 'query')));
  }
}

/** Platform staff accounts (super_admin). Staff sign in only through the workforce IdP. */
@Controller('v1')
export class StaffController {
  constructor(private readonly admin: AdminService) {}

  @Get('staff-accounts')
  @Roles('super_admin')
  async list(): Promise<{ items: StaffAccountView[] }> {
    return { items: await this.admin.listStaff() };
  }

  @Post('staff-accounts')
  @Roles('super_admin')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<StaffAccountView> {
    const input = parseInput(staffBody, body);
    return this.admin.createStaff(principal, {
      email: input.email,
      displayName: input.display_name,
    });
  }

  /** POST /v1/staff-accounts/{id}:disable */
  @Post('staff-accounts/:idAndMethod')
  @Roles('super_admin')
  @HttpCode(200)
  disable(
    @CurrentPrincipal() principal: Principal,
    @Param('idAndMethod') segment: string,
  ): Promise<StaffAccountView> {
    const [id, method] = segment.split(':');
    if (method !== 'disable' || !id || !isUuid(id)) {
      throw new NotFoundError('ROUTE_NOT_FOUND', `No operation matches "${segment}".`);
    }
    return this.admin.disableStaff(principal, id);
  }
}
