/* eslint-disable */
// Generated from services/tenant-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

export type paths = {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liveness probe (no auth). */
        get: operations["liveness"];
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
        /** Readiness probe; 503 when the database is unreachable. */
        get: operations["readiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tenant-directory:resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve a slug to its cell. Role service + scope tenant-directory:read (API gateway). */
        get: operations["resolveTenant"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tenants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List tenants newest first. Roles: super_admin. */
        get: operations["listTenants"];
        put?: never;
        /** Create a tenant (status provisioning). Roles: super_admin. */
        post: operations["createTenant"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tenants/{tenantId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        /** Read one tenant. Roles: super_admin, tenant_admin (own tenant; others get 404). */
        get: operations["getTenant"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Change display_name. Roles: super_admin, tenant_admin (own). */
        patch: operations["renameTenant"];
        trace?: never;
    };
    "/v1/tenants/{tenantId}:activate": components["pathItems"]["activate"];
    "/v1/tenants/{tenantId}:offboard": components["pathItems"]["offboard"];
    "/v1/tenants/{tenantId}:purge": components["pathItems"]["purge"];
    "/v1/tenants/{tenantId}:reactivate": components["pathItems"]["reactivate"];
    "/v1/tenants/{tenantId}:rotateDataKey": components["pathItems"]["rotateDataKey"];
    "/v1/tenants/{tenantId}:suspend": components["pathItems"]["suspend"];
    "/v1/tenants/{tenantId}/data-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Wrapped DEK versions for encrypting services. Role service, scope tenant-keys:read.
         * @description Callers unwrap with their own KMS access (encryption context purpose=tenant-dek). Purged tenants have no keys (404). Responses are never cached.
         */
        get: operations["getTenantDataKeys"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tenants/{tenantId}/retention-policy": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        get?: never;
        /** Replace the retention policy. Roles: super_admin. */
        put: operations["replaceRetentionPolicy"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/tenants/{tenantId}/settings": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        /** Settings for platform services (matching weights, limits). Roles: service with tenant-settings:read. */
        get: operations["getTenantSettingsForService"];
        /**
         * Replace settings. Roles: super_admin, tenant_admin (own). Emits tenant.tenant.settings_updated.v1.
         * @description Tenant admins may resend `limits` and `features` unchanged but not alter them (403 PLATFORM_MANAGED_SETTING).
         */
        put: operations["replaceTenantSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        CreateTenantRequest: {
            /**
             * Format: email
             * @description identity-svc invites this address as the first tenant_admin. Not stored by tenant-svc.
             */
            bootstrap_admin_email?: string;
            /** @example eu-central-1 */
            data_region: string;
            display_name: string;
            /** @default pooled */
            isolation_tier: components["schemas"]["IsolationTier"];
            slug: string;
        };
        DirectoryEntry: {
            cell_id: string;
            data_region: string;
            isolation_tier: components["schemas"]["IsolationTier"];
            status: components["schemas"]["TenantStatus"];
            /** Format: uuid */
            tenant_id: string;
        };
        /** @enum {string} */
        IsolationTier: "pooled" | "dedicated";
        LifecycleRequest: {
            reason?: string;
        };
        Problem: {
            /**
             * @example TENANT_SLUG_TAKEN
             * @example TENANT_SLUG_RESERVED
             * @example TENANT_NOT_FOUND
             * @example INVALID_TENANT_TRANSITION
             * @example PURGE_GRACE_PERIOD_ACTIVE
             * @example TENANT_NOT_ACTIVE
             * @example UNSUPPORTED_DATA_REGION
             * @example VERSION_MISMATCH
             * @example IF_MATCH_REQUIRED
             * @example INVALID_SETTINGS
             * @example REASON_REQUIRED
             * @example IDEMPOTENCY_KEY_REUSED
             * @example VALIDATION_FAILED
             */
            code: string;
            detail: string;
            errors?: {
                message?: string;
                path?: string;
            }[];
            instance: string;
            request_id?: string;
            status: number;
            title: string;
            /** Format: uri */
            type: string;
        };
        RetentionPolicy: {
            assessment_reports_days: number;
            candidate_inactive_days: number;
            interview_audio_days: number;
            proctoring_frames_days: number;
        };
        Tenant: {
            cell_id: string;
            /** Format: date-time */
            created_at: string;
            data_region: string;
            dek_version: number;
            display_name: string;
            isolation_tier: components["schemas"]["IsolationTier"];
            /** Format: date-time */
            purge_not_before: string | null;
            /** Format: date-time */
            purged_at: string | null;
            retention_policy: components["schemas"]["RetentionPolicy"];
            settings: components["schemas"]["TenantSettings"];
            slug: string;
            status: components["schemas"]["TenantStatus"];
            /** Format: uuid */
            tenant_id: string;
            /** Format: date-time */
            updated_at: string;
            version: number;
        };
        TenantSettings: {
            compliance: {
                jurisdictions: string[];
            };
            /** @description Keys named <module>.<feature>.<variant>. */
            features?: {
                [key: string]: boolean;
            };
            limits: {
                api_rps: number;
                parse_concurrency: number;
                sandbox_concurrency: number;
            };
            /** @default en */
            locale: string;
            matching: {
                /** @description Must sum to 1 (±1e-6), else 400 INVALID_SETTINGS. */
                weights: {
                    cov: number;
                    exp: number;
                    lex: number;
                    sem: number;
                };
            };
        };
        /** @enum {string} */
        TenantStatus: "provisioning" | "active" | "suspended" | "offboarding" | "purged";
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
        /** @description Updated tenant. */
        TenantWithETag: {
            headers: {
                ETag: components["headers"]["ETag"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Tenant"];
            };
        };
    };
    parameters: {
        IdempotencyKey: string;
        /** @description ETag from the last read, e.g. "3". Missing → 428, stale → 412. */
        IfMatch: string;
        /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
        IfMatchOptional: string;
        TenantId: string;
    };
    requestBodies: {
        Lifecycle: {
            content: {
                "application/json": components["schemas"]["LifecycleRequest"];
            };
        };
    };
    headers: {
        /** @description Tenant version, e.g. "3" */
        ETag: string;
    };
    pathItems: {
        activate: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                    "If-Match"?: components["parameters"]["IfMatchOptional"];
                };
                path: {
                    tenantId: components["parameters"]["TenantId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** provisioning → active. Roles: super_admin. */
            post: operations["activateTenant"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        offboard: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                    "If-Match"?: components["parameters"]["IfMatchOptional"];
                };
                path: {
                    tenantId: components["parameters"]["TenantId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** active|suspended → offboarding; reason required; sets purge_not_before. Roles: super_admin. */
            post: operations["offboardTenant"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        purge: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                    "If-Match"?: components["parameters"]["IfMatchOptional"];
                };
                path: {
                    tenantId: components["parameters"]["TenantId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** offboarding → purged after the grace period; destroys every data-key version. Roles: super_admin. */
            post: operations["purgeTenant"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        reactivate: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                    "If-Match"?: components["parameters"]["IfMatchOptional"];
                };
                path: {
                    tenantId: components["parameters"]["TenantId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** suspended → active. Roles: super_admin. */
            post: operations["reactivateTenant"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        rotateDataKey: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                    "If-Match"?: components["parameters"]["IfMatchOptional"];
                };
                path: {
                    tenantId: components["parameters"]["TenantId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** Active tenants only; adds a new key version and retires (keeps) the old one. Roles: super_admin. */
            post: operations["rotateDataKeyTenant"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        suspend: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                    "If-Match"?: components["parameters"]["IfMatchOptional"];
                };
                path: {
                    tenantId: components["parameters"]["TenantId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** active → suspended; reason required. Roles: super_admin. */
            post: operations["suspendTenant"];
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
    liveness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Process is alive. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    readiness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Database reachable. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            503: components["responses"]["Problem"];
        };
    };
    resolveTenant: {
        parameters: {
            query: {
                slug: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Directory entry. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DirectoryEntry"];
                };
            };
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    listTenants: {
        parameters: {
            query?: {
                cursor?: string;
                data_region?: string;
                limit?: number;
                status?: components["schemas"]["TenantStatus"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["Tenant"][];
                        next_cursor: string | null;
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    createTenant: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateTenantRequest"];
            };
        };
        responses: {
            /** @description Created (or replayed, with Idempotent-Replayed true). */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "Idempotent-Replayed"?: "true";
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Tenant"];
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    getTenant: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Tenant"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    renameTenant: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag from the last read, e.g. "3". Missing → 428, stale → 412. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    display_name: string;
                };
            };
        };
        responses: {
            200: components["responses"]["TenantWithETag"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    getTenantDataKeys: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Live key versions, newest first. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        keys?: {
                            active?: boolean;
                            dek_version?: number;
                            kms_key_ref?: string;
                            wrapped_key?: string;
                        }[];
                        /** Format: uuid */
                        tenant_id?: string;
                    };
                };
            };
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    replaceRetentionPolicy: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag from the last read, e.g. "3". Missing → 428, stale → 412. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RetentionPolicy"];
            };
        };
        responses: {
            200: components["responses"]["TenantWithETag"];
            400: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    getTenantSettingsForService: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The settings and the tenant version they belong to. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        settings: components["schemas"]["TenantSettings"];
                        /** Format: uuid */
                        tenant_id: string;
                        version: number;
                    };
                };
            };
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    replaceTenantSettings: {
        parameters: {
            query?: never;
            header: {
                /** @description ETag from the last read, e.g. "3". Missing → 428, stale → 412. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TenantSettings"];
            };
        };
        responses: {
            200: components["responses"]["TenantWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    activateTenant: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                "If-Match"?: components["parameters"]["IfMatchOptional"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: components["requestBodies"]["Lifecycle"];
        responses: {
            200: components["responses"]["TenantWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    offboardTenant: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                "If-Match"?: components["parameters"]["IfMatchOptional"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: components["requestBodies"]["Lifecycle"];
        responses: {
            200: components["responses"]["TenantWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    purgeTenant: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                "If-Match"?: components["parameters"]["IfMatchOptional"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: components["requestBodies"]["Lifecycle"];
        responses: {
            200: components["responses"]["TenantWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    reactivateTenant: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                "If-Match"?: components["parameters"]["IfMatchOptional"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: components["requestBodies"]["Lifecycle"];
        responses: {
            200: components["responses"]["TenantWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    rotateDataKeyTenant: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                "If-Match"?: components["parameters"]["IfMatchOptional"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: components["requestBodies"]["Lifecycle"];
        responses: {
            200: components["responses"]["TenantWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    suspendTenant: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional ETag from the last read. When sent and stale → 412, so a retried call cannot apply twice. */
                "If-Match"?: components["parameters"]["IfMatchOptional"];
            };
            path: {
                tenantId: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: components["requestBodies"]["Lifecycle"];
        responses: {
            200: components["responses"]["TenantWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
}
