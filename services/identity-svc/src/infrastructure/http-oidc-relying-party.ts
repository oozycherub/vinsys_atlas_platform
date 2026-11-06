import { isIP } from 'node:net';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { type Clock } from '@atlas/platform';
import {
  type FederatedIdentity,
  type OidcProviderConfig,
  type OidcRelyingParty,
} from '../application/ports';
import { IdentityDomainError } from '../domain/errors';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;

function idpError(detail: string): IdentityDomainError {
  return new IdentityDomainError(
    'unauthorized',
    'IDP_ERROR',
    `Sign-in with the identity provider failed: ${detail}`,
  );
}

/**
 * OIDC relying party over HTTP (OpenID Connect Core §3.1, PKCE S256, client_secret_basic).
 * Tenant admins configure the issuer, so every URL fetched must be HTTPS on a DNS name
 * (no IP literals or localhost) unless `allowInsecure` is set for development and tests.
 */
export class HttpOidcRelyingParty implements OidcRelyingParty {
  private readonly discoveries = new Map<string, { at: number; doc: Discovery }>();
  private readonly jwks = new Map<string, JWTVerifyGetKey>();

  constructor(
    private readonly clock: Clock,
    private readonly options: { allowInsecure: boolean; timeoutMs?: number },
  ) {}

  async authorizationUrl(
    provider: OidcProviderConfig,
    request: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
  ): Promise<string> {
    const doc = await this.discover(provider.issuer);
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: request.redirectUri,
      scope: 'openid email profile',
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode(
    provider: OidcProviderConfig,
    request: { code: string; redirectUri: string; codeVerifier: string; nonce: string },
  ): Promise<FederatedIdentity> {
    const doc = await this.discover(provider.issuer);
    const basic = Buffer.from(
      `${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret)}`,
    ).toString('base64');
    let response: Response;
    try {
      response = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: request.code,
          redirect_uri: request.redirectUri,
          code_verifier: request.codeVerifier,
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch {
      throw idpError('the token endpoint is unreachable');
    }
    if (!response.ok) throw idpError(`the token endpoint answered ${response.status}`);
    const body = (await response.json()) as { id_token?: unknown };
    if (typeof body.id_token !== 'string') throw idpError('no id_token was returned');

    let claims: Record<string, unknown>;
    try {
      const verified = await jwtVerify(body.id_token, this.keySet(doc.jwks_uri), {
        issuer: doc.issuer,
        audience: provider.clientId,
        algorithms: ['RS256', 'ES256', 'PS256', 'EdDSA'],
        currentDate: this.clock.now(),
        clockTolerance: 60,
      });
      claims = verified.payload as Record<string, unknown>;
    } catch {
      throw idpError('the ID token is invalid');
    }
    if (claims['nonce'] !== request.nonce) throw idpError('the ID token nonce does not match');
    const email = claims['email'];
    if (typeof email !== 'string' || claims['email_verified'] === false) {
      throw idpError('the ID token has no verified email');
    }
    return {
      issuer: doc.issuer,
      subject: String(claims['sub']),
      email,
      displayName: typeof claims['name'] === 'string' ? claims['name'] : null,
    };
  }

  private keySet(uri: string): JWTVerifyGetKey {
    let set = this.jwks.get(uri);
    if (!set) {
      set = createRemoteJWKSet(new URL(uri), { timeoutDuration: this.options.timeoutMs ?? 5000 });
      this.jwks.set(uri, set);
    }
    return set;
  }

  private async discover(issuer: string): Promise<Discovery> {
    const cached = this.discoveries.get(issuer);
    const now = this.clock.now().getTime();
    if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.doc;
    this.assertSafe(issuer);
    let doc: Discovery;
    try {
      const response = await fetch(
        `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
        },
      );
      if (!response.ok) throw new Error(String(response.status));
      doc = (await response.json()) as Discovery;
    } catch {
      throw idpError('the discovery document could not be loaded');
    }
    if (doc.issuer !== issuer)
      throw idpError('the discovery issuer does not match the configuration');
    for (const url of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) {
      if (typeof url !== 'string') throw idpError('the discovery document is incomplete');
      this.assertSafe(url);
    }
    this.discoveries.set(issuer, { at: now, doc });
    return doc;
  }

  /** SSRF guard for tenant-supplied URLs. DNS-rebinding defence belongs in the egress proxy. */
  private assertSafe(raw: string): void {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw idpError('a configured URL is invalid');
    }
    if (this.options.allowInsecure) return;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      url.protocol !== 'https:' ||
      isIP(host) !== 0 ||
      host === 'localhost' ||
      host.endsWith('.localhost')
    ) {
      throw idpError('identity provider URLs must be https on a public DNS name');
    }
  }
}
