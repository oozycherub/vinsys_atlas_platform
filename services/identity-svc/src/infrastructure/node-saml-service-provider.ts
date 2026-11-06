import { type CacheProvider, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import {
  type FederatedIdentity,
  type SamlProviderConfig,
  type SamlServiceProvider,
} from '../application/ports';
import { normalizeEmail } from '../domain/email';
import { IdentityDomainError } from '../domain/errors';
import { FEDERATION_STATE_TTL_MS } from '../domain/federation';

const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
];
const NAME_ATTRIBUTES = [
  'displayName',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
];

/**
 * A cache that knows exactly one request id. node-saml checks InResponseTo against it, which
 * ties the response to the AuthnRequest of this login (the id lives in federation_states).
 */
function singleRequestCache(onSave?: (id: string) => void, expected?: string): CacheProvider {
  return {
    saveAsync: (key, value) => {
      onSave?.(key);
      return Promise.resolve({ value, createdAt: Date.now() });
    },
    // node-saml reads the value as the request's creation time. The real expiry is enforced by
    // federation_states (10 minutes, single use), so "now" keeps node-saml's own check neutral.
    getAsync: (key) =>
      Promise.resolve(expected !== undefined && key === expected ? new Date().toISOString() : null),
    removeAsync: (key) => Promise.resolve(key),
  };
}

/** SAML 2.0 SP via node-saml: signed assertions required, audience = our entity id. */
export class NodeSamlServiceProvider implements SamlServiceProvider {
  async authorizeUrl(
    provider: SamlProviderConfig,
    request: { acsUrl: string; spEntityId: string; relayState: string },
  ): Promise<{ url: string; requestId: string }> {
    let requestId: string | undefined;
    const saml = this.build(
      provider,
      request,
      singleRequestCache((id) => (requestId = id)),
    );
    const url = await saml.getAuthorizeUrlAsync(request.relayState, undefined, {});
    if (!requestId) throw new Error('node-saml did not record the AuthnRequest id.');
    return { url, requestId };
  }

  async validateResponse(
    provider: SamlProviderConfig,
    request: {
      acsUrl: string;
      spEntityId: string;
      samlResponse: string;
      expectedRequestId: string;
    },
  ): Promise<FederatedIdentity> {
    const saml = this.build(
      provider,
      request,
      singleRequestCache(undefined, request.expectedRequestId),
    );
    let profile: Record<string, unknown> | null;
    try {
      ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: request.samlResponse }));
    } catch (error) {
      throw new IdentityDomainError(
        'unauthorized',
        'IDP_ERROR',
        `The SAML response was rejected: ${(error as Error).message}`,
      );
    }
    if (!profile)
      throw new IdentityDomainError(
        'unauthorized',
        'IDP_ERROR',
        'The SAML response has no assertion.',
      );
    const nameId = typeof profile['nameID'] === 'string' ? profile['nameID'] : '';
    const rawEmail =
      EMAIL_ATTRIBUTES.map((a) => profile[a]).find((v): v is string => typeof v === 'string') ??
      (String(profile['nameIDFormat']).endsWith(':emailAddress') ? nameId : undefined);
    if (!rawEmail) {
      throw new IdentityDomainError(
        'unauthorized',
        'IDP_ERROR',
        'The SAML assertion carries no email.',
      );
    }
    const displayName = NAME_ATTRIBUTES.map((a) => profile[a]).find(
      (v): v is string => typeof v === 'string',
    );
    return {
      issuer: String(profile['issuer']),
      subject: nameId,
      email: normalizeEmail(rawEmail),
      displayName: displayName ?? null,
    };
  }

  private build(
    provider: SamlProviderConfig,
    request: { acsUrl: string; spEntityId: string },
    cacheProvider: CacheProvider,
  ): SAML {
    return new SAML({
      callbackUrl: request.acsUrl,
      entryPoint: provider.entryPoint,
      issuer: request.spEntityId,
      audience: request.spEntityId,
      idpCert: provider.idpCert,
      ...(provider.idpIssuer ? { idpIssuer: provider.idpIssuer } : {}),
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      cacheProvider,
      requestIdExpirationPeriodMs: FEDERATION_STATE_TTL_MS,
      acceptedClockSkewMs: 60_000,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      disableRequestedAuthnContext: true,
    });
  }
}
