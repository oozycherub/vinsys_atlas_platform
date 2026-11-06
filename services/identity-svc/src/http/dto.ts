import { PreconditionFailedError, PreconditionRequiredError } from '@atlas/platform';
import { z } from 'zod';

/** Request schemas for the HTTP adapter (mirrors openapi.yaml). Unknown fields are rejected. */
const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/);
const secret = z.string().min(20).max(200);
const roles = z.array(z.string().max(40)).min(1).max(10);
const businessUnits = z.array(z.string().uuid()).max(100);

export const inviteBody = z
  .object({
    tenant_id: z.string().uuid().optional(),
    email: z.string().max(254),
    display_name: z.string().min(1).max(200),
    roles,
    business_unit_ids: businessUnits.optional(),
  })
  .strict();

export const patchUserBody = z
  .object({
    display_name: z.string().min(1).max(200).optional(),
    roles: roles.optional(),
    business_unit_ids: businessUnits.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'At least one field is required.');

export const tenantQuery = z.object({ tenant_id: z.string().uuid().optional() }).strict();

export const listUsersQuery = z
  .object({
    tenant_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const magicLinkRequestBody = z
  .object({ tenant_slug: slug, email: z.string().max(254) })
  .strict();

export const magicLinkRedeemBody = z
  .object({ tenant_slug: slug, token: secret, binding: secret })
  .strict();

export const invitationRedeemBody = z.object({ tenant_slug: slug, token: secret }).strict();

/** RFC 6749 token request (form or JSON). Unknown parameters are ignored per §3.2. */
export const tokenBody = z.discriminatedUnion('grant_type', [
  z.object({ grant_type: z.literal('refresh_token'), refresh_token: z.string().max(200) }),
  z.object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string().max(100).optional(),
    client_secret: z.string().max(200).optional(),
    scope: z.string().max(1000).optional(),
  }),
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1).max(200),
    code_verifier: z.string().min(1).max(200),
    redirect_uri: z.string().max(500),
    client_id: z.string().min(1).max(100),
  }),
]);

const ssoCommon = {
  enforced: z.boolean().default(false),
  domain_hints: z
    .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i))
    .max(50)
    .default([]),
  /** Just-in-time provisioning role for unknown SSO users; null refuses them. */
  jit_role: z
    .enum(['recruiter', 'hiring_manager', 'reviewer', 'sme', 'employee', 'candidate'])
    .nullable()
    .default(null),
};

/** OIDC needs an issuer and client; SAML an entry point and the IdP signing certificate. */
export const ssoBody = z.discriminatedUnion('protocol', [
  z
    .object({
      protocol: z.literal('oidc'),
      metadata: z
        .object({ issuer: z.string().url().max(500), client_id: z.string().min(1).max(200) })
        .strict(),
      client_secret: z.string().min(1).max(500).optional(),
      ...ssoCommon,
    })
    .strict(),
  z
    .object({
      protocol: z.literal('saml'),
      metadata: z
        .object({
          entry_point: z.string().url().max(500),
          idp_cert: z.string().min(100).max(20_000),
          idp_issuer: z.string().max(500).optional(),
        })
        .strict(),
      ...ssoCommon,
    })
    .strict(),
]);

/** OAuth authorization request for Atlas's own clients (RFC 6749 §4.1.1 + RFC 7636). */
export const authorizeQuery = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(100),
  redirect_uri: z.string().url().max(500),
  code_challenge: z.string().max(128),
  code_challenge_method: z.string().max(10).optional(),
  state: z.string().min(1).max(500),
});

export const callbackQuery = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});

export const samlAcsBody = z.object({
  SAMLResponse: z.string().max(500_000).optional(),
  RelayState: z.string().max(200).optional(),
});

export const staffBody = z
  .object({ email: z.string().max(254), display_name: z.string().min(1).max(200) })
  .strict();

export const serviceClientBody = z
  .object({
    name: z.string().regex(/^[a-z0-9-]{3,60}$/),
    tenant_id: z.string().uuid().nullable().default(null),
    scopes: z.array(z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/)).max(50),
    description: z.string().max(500).default(''),
  })
  .strict();

export const lifecycleBody = z.object({}).strict().default({});

/** Parses `If-Match: "7"` into a version. Missing → 428, malformed → 412. */
export function parseIfMatch(header: string | undefined): number {
  if (!header) {
    throw new PreconditionRequiredError(
      'IF_MATCH_REQUIRED',
      'Send If-Match with the ETag from your last read.',
    );
  }
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(header.trim());
  if (!match?.[1]) {
    throw new PreconditionFailedError(
      'VERSION_MISMATCH',
      'If-Match does not match the current ETag.',
    );
  }
  return Number(match[1]);
}

export function parseOptionalIfMatch(header: string | undefined): number | undefined {
  return header ? parseIfMatch(header) : undefined;
}

export function etag(version: number): string {
  return `"${version}"`;
}

/** Client credentials from `Authorization: Basic` (RFC 6749 §2.3.1), if present. */
export function basicCredentials(
  header: string | undefined,
): { clientId: string; clientSecret: string } | null {
  const match = header ? /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header) : null;
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 1) return null;
  return {
    clientId: decodeURIComponent(decoded.slice(0, colon)),
    clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
  };
}
