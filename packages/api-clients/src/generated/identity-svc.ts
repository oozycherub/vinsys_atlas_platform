/* eslint-disable */
// Generated from services/identity-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

export type paths = {
    "/.well-known/jwks.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public signing keys (ES256), including pre-published and not-yet-expired ones. Public. */
        get: operations["jwks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/.well-known/openid-configuration": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Discovery document. Public. */
        get: operations["openidConfiguration"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liveness probe. */
        get: operations["healthz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Readiness probe (database reachable). */
        get: operations["readyz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/magic-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Email a 30-minute login link. Public; 5 per email per hour.
         * @description Always 202, whether or not the email is registered. Keep `binding` in the browser and send it with the redeem call. 403 SSO_REQUIRED when the email domain belongs to an SSO-enforced tenant.
         */
        post: operations["requestMagicLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/magic-links:redeem": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Exchange a login link (plus its browser binding) for tokens. Public. */
        post: operations["redeemMagicLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/invitations:redeem": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Redeem an invitation: activates the user and signs them in. Public. */
        post: operations["redeemInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/oauth/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * OAuth 2.0 token endpoint (authorization_code + PKCE, refresh_token, client_credentials). Public / client auth.
         * @description authorization_code: exchanges a code from a federated sign-in (single use, 60 s, bound to client_id, redirect_uri and the S256 challenge). Staff get no refresh token. Refresh tokens rotate on every use; presenting a used one revokes the whole family (401 TOKEN_REUSE_DETECTED). Machine clients authenticate with HTTP Basic or body parameters.
         */
        post: operations["token"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/service-clients": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a machine client. The secret is returned once. Roles: super_admin. */
        post: operations["createServiceClient"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/signing-keys:rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pre-publish a new signing key (signs after 10 min). Roles: super_admin. */
        post: operations["rotateSigningKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sso-connections/{tenantId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenantId: string;
            };
            cookie?: never;
        };
        /** Read the SSO connection. Roles: tenant_admin (own), super_admin. */
        get: operations["getSsoConnection"];
        /**
         * Create or replace the SSO connection. Roles: tenant_admin (own), super_admin.
         * @description Replacing requires If-Match (428/412). `enforced` blocks magic-link login for workforce users.
         */
        put: operations["putSsoConnection"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sso/{slug}/acs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * SAML assertion consumer service (HTTP-POST binding). Public.
         * @description Signed assertions only; the response must answer this login's AuthnRequest.
         */
        post: operations["tenantSamlAcs"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sso/{slug}/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** OIDC redirect URI registered at the tenant IdP. Public. */
        get: operations["tenantOidcCallback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sso/{slug}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Start federated sign-in for a tenant (redirects to its IdP). Public.
         * @description OAuth authorization request of an Atlas client (RFC 6749 §4.1.1 + PKCE S256). The flow ends with a redirect to redirect_uri carrying `code` and `state`. Invalid client, redirect_uri or PKCE parameters give a problem document, never a redirect.
         */
        get: operations["startTenantSso"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/staff-accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List platform staff. Roles: super_admin. */
        get: operations["listStaffAccounts"];
        put?: never;
        /** Add a platform staff member (signs in via the workforce IdP). Roles: super_admin. */
        post: operations["createStaffAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/staff-accounts/{staffId}:disable": components["pathItems"]["disableStaff"];
    "/v1/staff/sso/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** OIDC redirect URI registered at the workforce IdP. Public. */
        get: operations["staffOidcCallback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/staff/sso/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Start platform-staff sign-in at the workforce IdP. Public. */
        get: operations["startStaffSso"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List users, newest first. Roles: tenant_admin (own tenant), super_admin (with tenant_id). */
        get: operations["listUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users:invite": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Invite a user (status invited; 72 h single-use link). Roles: tenant_admin (own tenant), super_admin.
         * @description Platform staff must pass `tenant_id`. `super_admin` and `service` can never be granted (403 ROLE_NOT_GRANTABLE).
         */
        post: operations["inviteUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/{userId}": {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
                tenant_id?: components["parameters"]["TenantIdQuery"];
            };
            header?: never;
            path: {
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        /** Read a user. Another tenant’s user gives 404. Roles: tenant_admin (own), super_admin. */
        get: operations["getUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Change display name, roles or business units. Roles: tenant_admin (own), super_admin.
         * @description Nobody can change their own roles (403 SELF_ROLE_CHANGE). Emits identity.user.roles_changed.v1 when roles change.
         */
        patch: operations["patchUser"];
        trace?: never;
    };
    "/v1/users/{userId}:deactivate": components["pathItems"]["deactivateUser"];
    "/v1/users/{userId}:resendInvitation": components["pathItems"]["resendInvitation"];
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        InviteRequest: {
            business_unit_ids?: string[];
            display_name: string;
            /** Format: email */
            email: string;
            roles: string[];
            /**
             * Format: uuid
             * @description Required for platform staff.
             */
            tenant_id?: string;
        };
        PatchUserRequest: {
            business_unit_ids?: string[];
            display_name?: string;
            roles?: string[];
        };
        Problem: {
            /**
             * @example USER_EMAIL_TAKEN
             * @example USER_NOT_FOUND
             * @example ROLE_NOT_GRANTABLE
             * @example SELF_ROLE_CHANGE
             * @example INVALID_LINK
             * @example INVITATION_EXPIRED
             * @example INVALID_GRANT
             * @example INVALID_CLIENT
             * @example INVALID_SCOPE
             * @example TOKEN_REUSE_DETECTED
             * @example TENANT_SUSPENDED
             * @example TENANT_ID_REQUIRED
             * @example SSO_REQUIRED
             * @example SSO_NOT_CONFIGURED
             * @example INVALID_REDIRECT_URI
             * @example INVALID_CODE_CHALLENGE
             * @example INVALID_STATE
             * @example USER_NOT_INVITED
             * @example STAFF_EMAIL_TAKEN
             * @example RATE_LIMITED
             * @example VERSION_MISMATCH
             * @example IF_MATCH_REQUIRED
             */
            code: string;
            detail: string;
            /** @description RFC 6749 error code on token-endpoint failures. */
            error?: string;
            instance: string;
            request_id?: string;
            status: number;
            title: string;
            /** Format: uri */
            type: string;
        };
        Slug: string;
        SsoConnection: {
            domain_hints: string[];
            enforced: boolean;
            has_client_secret?: boolean;
            jit_role?: string | null;
            metadata: Record<string, never>;
            /** @enum {string} */
            protocol: "oidc" | "saml";
            /** @description What to register at the IdP. */
            service_provider?: {
                /** Format: uri */
                oidc_redirect_uri?: string;
                /** Format: uri */
                saml_acs_url?: string;
                saml_entity_id?: string;
            } | null;
            /** Format: uuid */
            tenant_id: string;
            /** Format: date-time */
            updated_at: string;
            version: number;
        };
        SsoConnectionRequest: {
            /** @description OIDC only. Required on create; omit on replace to keep the stored secret. Never returned. */
            client_secret?: string;
            /** @description Email domains this IdP may sign in. Empty means unrestricted. */
            domain_hints?: string[];
            /** @default false */
            enforced: boolean;
            /**
             * @description Role for just-in-time provisioning of unknown SSO users; null refuses them.
             * @enum {string|null}
             */
            jit_role?: "recruiter" | "hiring_manager" | "reviewer" | "sme" | "employee" | "candidate" | null;
            /** @description oidc: {issuer, client_id}. saml: {entry_point, idp_cert (PEM), idp_issuer?}. */
            metadata: {
                client_id: string;
                /** Format: uri */
                issuer: string;
            } | {
                /** Format: uri */
                entry_point: string;
                idp_cert: string;
                idp_issuer?: string;
            };
            /** @enum {string} */
            protocol: "oidc" | "saml";
        };
        StaffAccount: {
            /** Format: date-time */
            created_at: string;
            display_name: string;
            /** Format: email */
            email: string;
            /** Format: date-time */
            last_login_at: string | null;
            roles: "super_admin"[];
            /** Format: uuid */
            staff_id: string;
            /** @enum {string} */
            status: "active" | "disabled";
        };
        /** @enum {string} */
        TenantRole: "tenant_admin" | "recruiter" | "hiring_manager" | "reviewer" | "sme" | "employee" | "candidate";
        TokenRequest: {
            client_id?: string;
            client_secret?: string;
            /** @description authorization_code grant. */
            code?: string;
            /** @description authorization_code grant: PKCE verifier (43–128 chars). */
            code_verifier?: string;
            /** @enum {string} */
            grant_type: "refresh_token" | "client_credentials" | "authorization_code";
            /** @description authorization_code grant; must equal the one used at start. */
            redirect_uri?: string;
            refresh_token?: string;
            /** @description Space-separated subset of the client's scopes. */
            scope?: string;
        };
        TokenResponse: {
            /** @description ES256 JWT (typ at+jwt); claims sub, tid, roles, bu, scopes, amr, iat, exp, jti. */
            access_token: string;
            /** @example 600 */
            expires_in: number;
            /** @description Rotating, 14 days. Format rt.<tenant_id>.<secret>. */
            refresh_token?: string;
            scope?: string;
            /** @constant */
            token_type: "Bearer";
        };
        User: {
            business_unit_ids: string[];
            /** Format: date-time */
            created_at: string;
            display_name: string;
            /** Format: email */
            email: string;
            /** Format: date-time */
            last_login_at: string | null;
            roles: components["schemas"]["TenantRole"][];
            /** @enum {string} */
            status: "invited" | "active" | "deactivated";
            /** Format: uuid */
            tenant_id: string;
            /** Format: date-time */
            updated_at: string;
            /** Format: uuid */
            user_id: string;
            version: number;
        };
    };
    responses: {
        /** @description RFC 9457 problem document. */
        Problem: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Too many requests. */
        RateLimited: {
            headers: {
                /** @description Seconds to wait. */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Redirect (Cache-Control no-store). After the state is validated, failures redirect to the client's redirect_uri with `error=access_denied` and `error_description`. */
        Redirect: {
            headers: {
                Location?: string;
                [name: string]: unknown;
            };
            content?: never;
        };
        /** @description Tokens (never cached). */
        Tokens: {
            headers: {
                "Cache-Control"?: "no-store";
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["TokenResponse"];
            };
        };
        /** @description The user. */
        UserWithETag: {
            headers: {
                ETag: components["headers"]["ETag"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["User"];
            };
        };
    };
    parameters: {
        /** @description ETag from the last read, e.g. "3". Missing → 428, stale → 412. */
        IfMatch: string;
        Slug: string;
        /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
        TenantIdQuery: string;
        UserId: string;
    };
    requestBodies: never;
    headers: {
        /** @description Resource version, e.g. "3" */
        ETag: string;
    };
    pathItems: {
        deactivateUser: {
            parameters: {
                query?: {
                    /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
                    tenant_id?: components["parameters"]["TenantIdQuery"];
                };
                header?: {
                    "If-Match"?: string;
                };
                path: {
                    userId: components["parameters"]["UserId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** Deactivate a user and revoke their refresh tokens. Roles: tenant_admin (own), super_admin. */
            post: operations["deactivateUser"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        disableStaff: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    staffId: string;
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** Disable a staff account. Roles: super_admin. */
            post: operations["disableStaffAccount"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        resendInvitation: {
            parameters: {
                query?: {
                    /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
                    tenant_id?: components["parameters"]["TenantIdQuery"];
                };
                header?: never;
                path: {
                    userId: components["parameters"]["UserId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** Send a new invitation link; earlier links stop working. Roles: tenant_admin (own), super_admin. */
            post: operations["resendInvitation"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
    };
};
export type $defs = Record<string, never>;
export interface operations {
    jwks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description JSON Web Key Set (cacheable for 5 minutes). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        keys: Record<string, never>[];
                    };
                };
            };
        };
    };
    openidConfiguration: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Provider metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, never>;
                };
            };
        };
    };
    healthz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Alive. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readyz: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ready. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            503: components["responses"]["Problem"];
        };
    };
    requestMagicLink: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                    tenant_slug: components["schemas"]["Slug"];
                };
            };
        };
        responses: {
            /** @description Accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        binding: string;
                        /** @example 1800 */
                        expires_in: number;
                    };
                };
            };
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            429: components["responses"]["RateLimited"];
        };
    };
    redeemMagicLink: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    binding: string;
                    tenant_slug: components["schemas"]["Slug"];
                    token: string;
                };
            };
        };
        responses: {
            200: components["responses"]["Tokens"];
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    redeemInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    tenant_slug: components["schemas"]["Slug"];
                    token: string;
                };
            };
        };
        responses: {
            200: components["responses"]["Tokens"];
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
        };
    };
    token: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TokenRequest"];
                "application/x-www-form-urlencoded": components["schemas"]["TokenRequest"];
            };
        };
        responses: {
            200: components["responses"]["Tokens"];
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            429: components["responses"]["RateLimited"];
        };
    };
    createServiceClient: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string;
                    name: string;
                    scopes: string[];
                    /** Format: uuid */
                    tenant_id?: string | null;
                };
            };
        };
        responses: {
            /** @description Created; store client_secret now. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example svc_gateway */
                        client_id: string;
                        client_secret: string;
                        scopes: string[];
                        tenant_id: string | null;
                    };
                };
            };
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    rotateSigningKey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successor created. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: date-time */
                        activates_at: string;
                        kid: string;
                    };
                };
            };
            403: components["responses"]["Problem"];
        };
    };
    getSsoConnection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenantId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The connection. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SsoConnection"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    putSsoConnection: {
        parameters: {
            query?: never;
            header?: {
                "If-Match"?: string;
            };
            path: {
                tenantId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SsoConnectionRequest"];
            };
        };
        responses: {
            /** @description Replaced. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SsoConnection"];
                };
            };
            /** @description Created. */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SsoConnection"];
                };
            };
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    tenantSamlAcs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/x-www-form-urlencoded": {
                    RelayState?: string;
                    SAMLResponse?: string;
                };
            };
        };
        responses: {
            303: components["responses"]["Redirect"];
            400: components["responses"]["Problem"];
        };
    };
    tenantOidcCallback: {
        parameters: {
            query?: {
                code?: string;
                error?: string;
                state?: string;
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            302: components["responses"]["Redirect"];
            400: components["responses"]["Problem"];
        };
    };
    startTenantSso: {
        parameters: {
            query: {
                client_id: string;
                code_challenge: string;
                code_challenge_method: "S256";
                redirect_uri: string;
                response_type: "code";
                state: string;
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            302: components["responses"]["Redirect"];
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    listStaffAccounts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Staff accounts. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["StaffAccount"][];
                    };
                };
            };
            403: components["responses"]["Problem"];
        };
    };
    createStaffAccount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    display_name: string;
                    /** Format: email */
                    email: string;
                };
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StaffAccount"];
                };
            };
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    staffOidcCallback: {
        parameters: {
            query?: {
                code?: string;
                error?: string;
                state?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            302: components["responses"]["Redirect"];
            400: components["responses"]["Problem"];
        };
    };
    startStaffSso: {
        parameters: {
            query: {
                client_id: string;
                code_challenge: string;
                code_challenge_method: "S256";
                redirect_uri: string;
                response_type: "code";
                state: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            302: components["responses"]["Redirect"];
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    listUsers: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
                tenant_id?: components["parameters"]["TenantIdQuery"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of users. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["User"][];
                        next_cursor: string | null;
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
        };
    };
    inviteUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InviteRequest"];
            };
        };
        responses: {
            /** @description Invited. */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    getUser: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
                tenant_id?: components["parameters"]["TenantIdQuery"];
            };
            header?: never;
            path: {
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["UserWithETag"];
            401: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    patchUser: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
                tenant_id?: components["parameters"]["TenantIdQuery"];
            };
            header: {
                /** @description ETag from the last read, e.g. "3". Missing → 428, stale → 412. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchUserRequest"];
            };
        };
        responses: {
            200: components["responses"]["UserWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    deactivateUser: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
                tenant_id?: components["parameters"]["TenantIdQuery"];
            };
            header?: {
                "If-Match"?: string;
            };
            path: {
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["UserWithETag"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    disableStaffAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                staffId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Disabled. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StaffAccount"];
                };
            };
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    resendInvitation: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users may omit it (another tenant's id gives 404). */
                tenant_id?: components["parameters"]["TenantIdQuery"];
            };
            header?: never;
            path: {
                userId: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["UserWithETag"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
}
