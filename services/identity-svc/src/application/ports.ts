import { type TenantStatus } from '@atlas/contracts';
import { type KeyEncryption, type Tx } from '@atlas/platform';
import { type SigningKeyMeta } from '../domain/signing-keys';
import { type RefreshTokenRecord } from '../domain/tokens';
import { type User } from '../domain/user';

/** Persistence ports. Every method runs inside a transaction owned by the application layer. */

export interface UserListFilter {
  limit: number;
  after?: { createdAt: Date; id: string };
}

/** Tenant-owned tables: callers must have set the tenant context (RLS). */
export interface UserRepository {
  insert(tx: Tx, user: User): Promise<void>;
  findById(tx: Tx, id: string, options?: { forUpdate?: boolean }): Promise<User | null>;
  findByEmail(tx: Tx, email: string): Promise<User | null>;
  list(tx: Tx, filter: UserListFilter): Promise<User[]>;
  /** Compare-and-set on `version`. */
  update(tx: Tx, user: User, expectedVersion: number): Promise<boolean>;
  /** Purge: removes every user of the current tenant (cascades to links and tokens). */
  deleteAll(tx: Tx): Promise<number>;
}

export interface LinkRecord {
  id: string;
  tenantId: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  /** Magic links only. */
  bindingHash?: Buffer;
}

export interface CredentialRepository {
  insertInvitation(
    tx: Tx,
    row: {
      id: string;
      tenantId: string;
      userId: string;
      tokenHash: Buffer;
      invitedBy: string;
      expiresAt: Date;
    },
  ): Promise<void>;
  findInvitation(tx: Tx, tokenHash: Buffer): Promise<LinkRecord | null>;
  consumeInvitation(tx: Tx, id: string, at: Date): Promise<boolean>;
  /** Marks every unused invitation of the user consumed (a newer one replaces them). */
  supersedeInvitations(tx: Tx, userId: string, at: Date): Promise<number>;

  insertMagicLink(
    tx: Tx,
    row: {
      id: string;
      tenantId: string;
      userId: string;
      tokenHash: Buffer;
      bindingHash: Buffer;
      expiresAt: Date;
    },
  ): Promise<void>;
  findMagicLink(tx: Tx, tokenHash: Buffer): Promise<LinkRecord | null>;
  consumeMagicLink(tx: Tx, id: string, at: Date): Promise<boolean>;

  insertRefreshToken(
    tx: Tx,
    row: RefreshTokenRecord & { tokenHash: Buffer; rotatedFrom: string | null },
  ): Promise<void>;
  findRefreshToken(tx: Tx, tokenHash: Buffer): Promise<RefreshTokenRecord | null>;
  markRefreshUsed(tx: Tx, id: string, at: Date): Promise<void>;
  revokeFamily(tx: Tx, familyId: string, at: Date): Promise<number>;
  revokeAllForUser(tx: Tx, userId: string, at: Date): Promise<number>;
}

export interface SsoConnection {
  tenantId: string;
  protocol: 'oidc' | 'saml';
  enforced: boolean;
  /** oidc: { issuer, client_id }; saml: { entry_point, idp_cert, idp_issuer? } */
  metadata: Record<string, unknown>;
  domainHints: readonly string[];
  /** OIDC client secret, sealed with KeyEncryption (context `sso-client-secret:<tenant>`). */
  clientSecretCiphertext: Buffer | null;
  kekRef: string | null;
  /** Role for just-in-time provisioning of unknown SSO users; null means they are refused. */
  jitRole: string | null;
  version: number;
  updatedAt: Date;
}

export interface SsoRepository {
  find(tx: Tx): Promise<SsoConnection | null>;
  upsert(tx: Tx, connection: SsoConnection, expectedVersion: number | null): Promise<boolean>;
  deleteForTenant(tx: Tx): Promise<void>;
}

/** Platform-level tables (no RLS). */
export interface TenantAccess {
  tenantId: string;
  slug: string;
  status: TenantStatus;
}

export interface TenantAccessRepository {
  findBySlug(tx: Tx, slug: string): Promise<TenantAccess | null>;
  findById(tx: Tx, tenantId: string): Promise<TenantAccess | null>;
  upsert(tx: Tx, access: TenantAccess): Promise<void>;
}

export interface StoredSigningKey extends SigningKeyMeta {
  publicJwk: Record<string, unknown>;
  privateKeyCiphertext: Buffer;
  kekRef: string;
}

export interface SigningKeyRepository {
  list(tx: Tx): Promise<StoredSigningKey[]>;
  insert(tx: Tx, key: StoredSigningKey): Promise<void>;
  retire(tx: Tx, kid: string, retiresAt: Date, publishUntil: Date): Promise<boolean>;
  /** Serialises rotations across replicas for the rest of the transaction. */
  lockForRotation(tx: Tx): Promise<void>;
}

export interface ServiceClient {
  clientId: string;
  tenantId: string | null;
  secretHash: string;
  scopes: readonly string[];
  description: string;
  disabledAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface ServiceClientRepository {
  find(tx: Tx, clientId: string): Promise<ServiceClient | null>;
  insert(tx: Tx, client: ServiceClient): Promise<void>;
}

export type SubjectKind = 'tenant' | 'staff';

export interface FederationState {
  stateHash: Buffer;
  kind: SubjectKind;
  tenantId: string | null;
  protocol: 'oidc' | 'saml';
  nonce: string | null;
  idpCodeVerifier: string | null;
  samlRequestId: string | null;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface AuthorizationCode {
  codeHash: Buffer;
  kind: SubjectKind;
  tenantId: string | null;
  subjectId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  amr: readonly string[];
  expiresAt: Date;
  consumedAt: Date | null;
}

/** Platform-level tables for in-flight federated logins and Atlas authorization codes. */
export interface FederationRepository {
  insertState(tx: Tx, state: FederationState): Promise<void>;
  /** Locks the row (FOR UPDATE). */
  findState(tx: Tx, stateHash: Buffer): Promise<FederationState | null>;
  consumeState(tx: Tx, stateHash: Buffer, at: Date): Promise<boolean>;
  insertCode(tx: Tx, code: AuthorizationCode): Promise<void>;
  findCode(tx: Tx, codeHash: Buffer): Promise<AuthorizationCode | null>;
  consumeCode(tx: Tx, codeHash: Buffer, at: Date): Promise<boolean>;
}

export interface StaffAccount {
  id: string;
  email: string;
  displayName: string;
  roles: readonly 'super_admin'[];
  status: 'active' | 'disabled';
  lastLoginAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface StaffRepository {
  findByEmail(tx: Tx, email: string): Promise<StaffAccount | null>;
  findById(tx: Tx, id: string): Promise<StaffAccount | null>;
  list(tx: Tx): Promise<StaffAccount[]>;
  insert(tx: Tx, account: StaffAccount): Promise<boolean>;
  setStatus(tx: Tx, id: string, status: StaffAccount['status']): Promise<boolean>;
  recordLogin(tx: Tx, id: string, at: Date): Promise<void>;
}

/** Who the IdP says signed in. */
export interface FederatedIdentity {
  issuer: string;
  subject: string;
  email: string;
  displayName: string | null;
}

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** Atlas as an OIDC relying party towards a tenant's (or the workforce) IdP. */
export interface OidcRelyingParty {
  authorizationUrl(
    provider: OidcProviderConfig,
    request: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
  ): Promise<string>;
  /** Exchanges the code and validates the ID token (signature, iss, aud, exp, nonce). */
  exchangeCode(
    provider: OidcProviderConfig,
    request: { code: string; redirectUri: string; codeVerifier: string; nonce: string },
  ): Promise<FederatedIdentity>;
}

export interface SamlProviderConfig {
  entryPoint: string;
  idpCert: string;
  idpIssuer: string | null;
}

/** Atlas as a SAML 2.0 service provider (HTTP-Redirect AuthnRequest, HTTP-POST response). */
export interface SamlServiceProvider {
  authorizeUrl(
    provider: SamlProviderConfig,
    request: { acsUrl: string; spEntityId: string; relayState: string },
  ): Promise<{ url: string; requestId: string }>;
  /** Validates signature, audience, conditions and that the response answers `expectedRequestId`. */
  validateResponse(
    provider: SamlProviderConfig,
    request: {
      acsUrl: string;
      spEntityId: string;
      samlResponse: string;
      expectedRequestId: string;
    },
  ): Promise<FederatedIdentity>;
}

/** Sends invitation and login links. Production: notification-svc (brick 13). */
export interface LinkDelivery {
  send(message: {
    kind: 'invitation' | 'magic_link';
    tenantId: string;
    email: string;
    url: string;
    expiresAt: Date;
  }): Promise<void>;
}

export interface IdentitySettings {
  issuer: string;
  audience: string;
  /** e.g. `https://{slug}.atlas.app`; `{slug}` is replaced with the tenant slug. */
  appBaseUrl: string;
  /** Seals private signing keys and SSO client secrets (local KEK in development, AWS KMS in production). */
  keys: KeyEncryption;
  /** Atlas's own OAuth clients (public, PKCE). `{slug}` in a redirect URI matches the tenant slug. */
  oauthClients: Readonly<Record<string, { redirectUris: readonly string[] }>>;
  /** Workforce IdP for platform staff; staff sign-in is disabled without it. */
  staffIdp: (OidcProviderConfig & { allowedDomains: readonly string[] }) | null;
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const CREDENTIAL_REPOSITORY = Symbol('CREDENTIAL_REPOSITORY');
export const SSO_REPOSITORY = Symbol('SSO_REPOSITORY');
export const TENANT_ACCESS_REPOSITORY = Symbol('TENANT_ACCESS_REPOSITORY');
export const SIGNING_KEY_REPOSITORY = Symbol('SIGNING_KEY_REPOSITORY');
export const SERVICE_CLIENT_REPOSITORY = Symbol('SERVICE_CLIENT_REPOSITORY');
export const LINK_DELIVERY = Symbol('LINK_DELIVERY');
export const FEDERATION_REPOSITORY = Symbol('FEDERATION_REPOSITORY');
export const STAFF_REPOSITORY = Symbol('STAFF_REPOSITORY');
export const OIDC_RELYING_PARTY = Symbol('OIDC_RELYING_PARTY');
export const SAML_SERVICE_PROVIDER = Symbol('SAML_SERVICE_PROVIDER');
export const IDENTITY_SETTINGS = Symbol('IDENTITY_SETTINGS');
