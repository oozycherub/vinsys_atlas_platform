import { Body, Controller, Get, Headers, HttpCode, Inject, Ip, Post, Res } from '@nestjs/common';
import {
  BadRequestError,
  DATABASE,
  type Database,
  parseInput,
  Public,
  ServiceUnavailableError,
} from '@atlas/platform';
import { AuthService } from '../application/auth.service';
import { IDENTITY_SETTINGS, type IdentitySettings } from '../application/ports';
import { type JsonWebKeySet, SigningKeyService } from '../application/signing-key.service';
import { type TokenResponse } from '../application/views';
import {
  basicCredentials,
  invitationRedeemBody,
  magicLinkRedeemBody,
  magicLinkRequestBody,
  tokenBody,
} from './dto';

interface HeaderSink {
  setHeader(name: string, value: string): void;
}

/** Token responses must never be cached (RFC 6749 §5.1). */
function noStore(res: HeaderSink): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/** Public login flows and the OAuth token endpoint. */
@Controller('v1')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('auth/magic-links')
  @Public()
  @HttpCode(202)
  requestMagicLink(
    @Body() body: unknown,
    @Ip() ip: string,
  ): Promise<{ binding: string; expires_in: number }> {
    const input = parseInput(magicLinkRequestBody, body);
    return this.auth.requestMagicLink(input.tenant_slug, input.email, ip);
  }

  @Post('auth/magic-links\\:redeem')
  @Public()
  @HttpCode(200)
  async redeemMagicLink(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TokenResponse> {
    const input = parseInput(magicLinkRedeemBody, body);
    noStore(res);
    return this.auth.redeemMagicLink(input.tenant_slug, input.token, input.binding);
  }

  @Post('invitations\\:redeem')
  @Public()
  @HttpCode(200)
  async redeemInvitation(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TokenResponse> {
    const input = parseInput(invitationRedeemBody, body);
    noStore(res);
    return this.auth.redeemInvitation(input.tenant_slug, input.token);
  }

  /** RFC 6749 token endpoint; accepts form-encoded or JSON bodies. */
  @Post('oauth/token')
  @Public()
  @HttpCode(200)
  async token(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TokenResponse> {
    const input = parseInput(tokenBody, body);
    noStore(res);
    switch (input.grant_type) {
      case 'refresh_token':
        return this.auth.refresh(input.refresh_token);
      case 'client_credentials': {
        const basic = basicCredentials(authorization);
        const clientId = basic?.clientId ?? input.client_id;
        const clientSecret = basic?.clientSecret ?? input.client_secret;
        if (!clientId || !clientSecret) {
          throw new BadRequestError('INVALID_CLIENT', 'Client credentials are required.', {
            error: 'invalid_client',
          });
        }
        return this.auth.clientCredentials(clientId, clientSecret, input.scope);
      }
      case 'authorization_code':
        return this.auth.authorizationCode({
          code: input.code,
          codeVerifier: input.code_verifier,
          redirectUri: input.redirect_uri,
          clientId: input.client_id,
        });
    }
  }
}

/** Discovery documents and probes. */
@Controller()
export class WellKnownController {
  constructor(
    private readonly keys: SigningKeyService,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Get('.well-known/jwks.json')
  @Public()
  async jwks(@Res({ passthrough: true }) res: HeaderSink): Promise<JsonWebKeySet> {
    // Shorter than PREPUBLISH_MS, so caches always see a new key before it signs.
    res.setHeader('Cache-Control', 'public, max-age=300');
    return this.keys.jwks();
  }

  @Get('.well-known/openid-configuration')
  @Public()
  openidConfiguration(): Record<string, unknown> {
    const issuer = this.settings.issuer;
    return {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      token_endpoint: `${issuer}/v1/oauth/token`,
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      id_token_signing_alg_values_supported: ['ES256'],
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      claims_supported: ['sub', 'tid', 'roles', 'bu', 'scopes', 'amr', 'iat', 'exp', 'jti'],
    };
  }

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
