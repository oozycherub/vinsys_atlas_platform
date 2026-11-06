import { type User, type UserStatus } from '../domain/user';
import { type SsoConnection, type StaffAccount } from './ports';

/** Public representation (snake_case, ISO dates). */
export interface UserView {
  user_id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  roles: string[];
  business_unit_ids: string[];
  status: UserStatus;
  last_login_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function toUserView(user: User): UserView {
  return {
    user_id: user.id,
    tenant_id: user.tenantId,
    email: user.email,
    display_name: user.displayName,
    roles: [...user.roles],
    business_unit_ids: [...user.businessUnitIds],
    status: user.status,
    last_login_at: user.lastLoginAt?.toISOString() ?? null,
    version: user.version,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}

export interface UserPage {
  items: UserView[];
  next_cursor: string | null;
}

/** OAuth 2.0 token response (RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export interface ServiceProviderEndpoints {
  oidc_redirect_uri: string;
  saml_acs_url: string;
  saml_entity_id: string;
}

/** The client secret is write-only: the view only says whether one is stored. */
export interface SsoConnectionView {
  tenant_id: string;
  protocol: 'oidc' | 'saml';
  enforced: boolean;
  metadata: Record<string, unknown>;
  domain_hints: string[];
  has_client_secret: boolean;
  jit_role: string | null;
  /** What the tenant registers at its IdP. */
  service_provider: ServiceProviderEndpoints | null;
  version: number;
  updated_at: string;
}

export function toSsoView(
  c: SsoConnection,
  endpoints: ServiceProviderEndpoints | null,
): SsoConnectionView {
  return {
    tenant_id: c.tenantId,
    protocol: c.protocol,
    enforced: c.enforced,
    metadata: c.metadata,
    domain_hints: [...c.domainHints],
    has_client_secret: c.clientSecretCiphertext !== null,
    jit_role: c.jitRole,
    service_provider: endpoints,
    version: c.version,
    updated_at: c.updatedAt.toISOString(),
  };
}

export interface StaffAccountView {
  staff_id: string;
  email: string;
  display_name: string;
  roles: string[];
  status: 'active' | 'disabled';
  last_login_at: string | null;
  created_at: string;
}

export function toStaffView(a: StaffAccount): StaffAccountView {
  return {
    staff_id: a.id,
    email: a.email,
    display_name: a.displayName,
    roles: [...a.roles],
    status: a.status,
    last_login_at: a.lastLoginAt?.toISOString() ?? null,
    created_at: a.createdAt.toISOString(),
  };
}
