import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { type Clock } from '../clock';
import { UnauthorizedError } from '../errors';
import { type Principal, tokenClaimsSchema } from './principal';

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  /** Production: identity-svc / IdP JWKS endpoint (RS256/ES256). */
  jwksUrl?: string;
  /** Local development and tests only: shared HS256 secret (≥ 32 chars). */
  sharedSecret?: string;
  clockToleranceSec?: number;
  /** Time source for exp/nbf checks; defaults to the system clock. */
  clock?: Clock;
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Verifies bearer JWTs (signature, issuer, audience, expiry) and maps claims to a Principal. */
export class JwtVerifier implements TokenVerifier {
  private readonly key: JWTVerifyGetKey | Uint8Array;
  private readonly algorithms: string[];

  constructor(private readonly options: JwtVerifierOptions) {
    if (options.jwksUrl) {
      this.key = createRemoteJWKSet(new URL(options.jwksUrl));
      this.algorithms = ['RS256', 'ES256'];
    } else if (options.sharedSecret && options.sharedSecret.length >= 32) {
      this.key = new TextEncoder().encode(options.sharedSecret);
      this.algorithms = ['HS256'];
    } else {
      throw new Error('JwtVerifier needs jwksUrl, or a sharedSecret of at least 32 characters.');
    }
  }

  async verify(token: string): Promise<Principal> {
    let payload: unknown;
    try {
      const verifyOptions = {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.algorithms,
        clockTolerance: this.options.clockToleranceSec ?? 30,
        ...(this.options.clock ? { currentDate: this.options.clock.now() } : {}),
      };
      const result =
        this.key instanceof Uint8Array
          ? await jwtVerify(token, this.key, verifyOptions)
          : await jwtVerify(token, this.key, verifyOptions);
      payload = result.payload;
    } catch {
      throw new UnauthorizedError('The bearer token is invalid or expired.');
    }
    const claims = tokenClaimsSchema.safeParse(payload);
    if (!claims.success)
      throw new UnauthorizedError('The bearer token is missing required claims.');
    return {
      subject: claims.data.sub,
      tenantId: claims.data.tid ?? null,
      roles: claims.data.roles,
      scopes: claims.data.scopes,
    };
  }
}

/**
 * Accepts a token if any verifier does, trying them in order. identity-svc uses it to accept its
 * own tokens plus platform-staff tokens from the workforce IdP.
 */
export class AnyOfVerifier implements TokenVerifier {
  constructor(private readonly verifiers: readonly TokenVerifier[]) {
    if (verifiers.length === 0) throw new Error('AnyOfVerifier needs at least one verifier.');
  }

  async verify(token: string): Promise<Principal> {
    let last: unknown;
    for (const verifier of this.verifiers) {
      try {
        return await verifier.verify(token);
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new UnauthorizedError();
  }
}
