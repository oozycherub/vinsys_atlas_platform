/* eslint-disable */
// Generated from services/taxonomy-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

export type paths = {
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
    "/v1/job-families": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Job families of the tenant. */
        get: operations["listJobFamilies"];
        put?: never;
        /** Create a job family. */
        post: operations["createJobFamily"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/job-profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Job profiles, newest first. */
        get: operations["listJobProfiles"];
        put?: never;
        /** Create a draft job profile. */
        post: operations["createJobProfile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/job-profiles/{jobProfileId}": {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                jobProfileId: components["parameters"]["JobProfileId"];
            };
            cookie?: never;
        };
        /** A job profile with its required skills. */
        get: operations["getJobProfile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Edit title, description or role. */
        patch: operations["patchJobProfile"];
        trace?: never;
    };
    "/v1/job-profiles/{jobProfileId}:archive": components["pathItems"]["archiveJobProfile"];
    "/v1/job-profiles/{jobProfileId}:publish": components["pathItems"]["publishJobProfile"];
    "/v1/job-profiles/{jobProfileId}/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Replace required skills: weight (0,1], target 0–5 in 0.5 steps, must_have. */
        put: operations["putJobProfileSkills"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/job-roles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Job roles, optionally of one family. */
        get: operations["listJobRoles"];
        put?: never;
        /** Create a job role in a family. */
        post: operations["createJobRole"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skill-edges": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Add RELATED_TO (symmetric) or PREREQUISITE_OF (no cycles) between active leaf skills. */
        post: operations["addSkillEdge"];
        /** Remove an edge of the caller's scope. */
        delete: operations["removeSkillEdge"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skill-suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Weakly matched raw terms (cosine 0.70–0.82) for taxonomy admins. Per tenant. */
        get: operations["listSkillSuggestions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List skills visible to the caller (global + own tenant, minus hidden), ordered by path. */
        get: operations["listSkills"];
        put?: never;
        /** Create a node (tenant node for tenant_admin; global node for the curator). */
        post: operations["createSkill"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skills:normalize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Raw strings → canonical skills: alias (1.0), then nearest neighbour (≥ 0.82), else none.
         * @description Cosine 0.70–0.82 returns null and queues the term in the tenant's skill suggestions. Deprecated matches resolve to their successor. Hidden skills never match.
         */
        post: operations["normalizeSkills"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/skills/{skillId}": {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        /** A skill with ancestors, related skills and (if deprecated) its active successor. */
        get: operations["getSkill"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Edit name, description, classification, aliases or external id. The path is immutable.
         * @description Tenants edit only their own nodes (global → 403 GLOBAL_SKILL_READ_ONLY; use the override).
         */
        patch: operations["patchSkill"];
        trace?: never;
    };
    "/v1/skills/{skillId}:deprecate": components["pathItems"]["deprecateSkill"];
    "/v1/skills/{skillId}/override": {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        get?: never;
        /** Tenant overlay on a global skill: hide, adopt, rename, extra aliases. Roles: tenant_admin, super_admin (with tenant_id). */
        put: operations["putSkillOverride"];
        post?: never;
        /** Remove the tenant's overlay. */
        delete: operations["deleteSkillOverride"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/taxonomy-imports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload a .csv or .xlsx (≤ 5 MB, ≤ 5000 rows) and get a dry-run diff, kept for 24 h.
         * @description Columns: path, node_type, name (required); description, classification, aliases (separated by ; or |), external_id. Imports create and update; they never delete.
         */
        post: operations["uploadTaxonomyImport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/taxonomy-imports/{importId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A stored dry run or committed import. */
        get: operations["getTaxonomyImport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/taxonomy-imports/{importId}:commit": components["pathItems"]["commitImport"];
    "/v1/taxonomy:publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish pending changes as the next version; emits taxonomy.version.published.v1. */
        post: operations["publishTaxonomy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/taxonomy:reembed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Embed active skills with no vector from the current model (after a model change or outage). */
        post: operations["reembedTaxonomy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/taxonomy/version": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Published version of the caller's scope and how many skills changed since. */
        get: operations["getTaxonomyVersion"];
        put?: never;
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
        /** @enum {string} */
        Classification: "technical" | "functional" | "soft" | "tool" | "ai" | "emerging" | "unclassified";
        CreateSkillRequest: {
            aliases?: string[];
            classification?: components["schemas"]["Classification"];
            description?: string | null;
            external_id?: string | null;
            name: string;
            node_type: components["schemas"]["NodeType"];
            /** @description ltree path; depth 1–4 by node type; the parent must exist. */
            path: string;
        };
        Import: {
            /** Format: date-time */
            committed_at?: string | null;
            /** @description Per row: action create|update|unchanged|error, with changed fields or errors. */
            entries?: Record<string, never>[];
            /** Format: date-time */
            expires_at?: string;
            file_name?: string;
            /** Format: uuid */
            import_id?: string;
            row_count?: number;
            /** @enum {string} */
            status?: "dry_run" | "committed" | "failed";
            summary?: {
                create?: number;
                error?: number;
                unchanged?: number;
                update?: number;
            };
            tenant_id?: string | null;
        };
        JobProfile: {
            description?: string | null;
            /** Format: uuid */
            job_profile_id?: string;
            /** Format: uuid */
            job_role_id?: string | null;
            /** Format: date-time */
            published_at?: string | null;
            skills?: {
                must_have?: boolean;
                /** Format: uuid */
                skill_id?: string;
                target_proficiency?: number;
                weight?: number;
            }[];
            /** @enum {string} */
            status?: "draft" | "published" | "archived";
            /** Format: uuid */
            tenant_id?: string;
            title?: string;
            version?: number;
        };
        /** @enum {string} */
        NodeType: "domain" | "subdomain" | "cluster" | "skill";
        PatchSkillRequest: {
            aliases?: string[];
            classification?: components["schemas"]["Classification"];
            description?: string | null;
            external_id?: string | null;
            name?: string;
        };
        Problem: {
            /**
             * @example SKILL_NOT_FOUND
             * @example SKILL_PATH_TAKEN
             * @example PATH_DEPTH_MISMATCH
             * @example PARENT_NOT_FOUND
             * @example GLOBAL_SKILL_READ_ONLY
             * @example PREREQUISITE_CYCLE
             * @example EDGE_EXISTS
             * @example INVALID_SUCCESSOR
             * @example SKILL_DEPRECATED
             * @example IMPORT_HAS_ERRORS
             * @example IMPORT_STALE
             * @example NOTHING_TO_PUBLISH
             * @example SKILLS_REQUIRED
             * @example INVALID_WEIGHT
             * @example INVALID_TARGET_PROFICIENCY
             * @example EMBEDDINGS_UNAVAILABLE
             * @example VERSION_MISMATCH
             * @example IF_MATCH_REQUIRED
             */
            code: string;
            detail: string;
            instance: string;
            request_id?: string;
            status: number;
            title: string;
            /** Format: uri */
            type: string;
        };
        Skill: {
            aliases: string[];
            canonical_name: string;
            classification: components["schemas"]["Classification"];
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            deprecated_at?: string | null;
            description?: string | null;
            external_id?: string | null;
            /** @description The tenant's display name if renamed. */
            name: string;
            node_type: components["schemas"]["NodeType"];
            override?: {
                adopted?: boolean;
                aliases?: string[];
                display_name?: string | null;
                hidden?: boolean;
            } | null;
            path: string;
            /** Format: uuid */
            replaced_by?: string | null;
            /** @enum {string} */
            scope: "global" | "tenant";
            /** Format: uuid */
            skill_id: string;
            taxonomy_version: number;
            /** Format: uuid */
            tenant_id: string | null;
            /** Format: date-time */
            updated_at?: string;
            version: number;
        };
        SkillDetail: components["schemas"]["Skill"] & {
            ancestors?: components["schemas"]["SkillRef"][];
            related?: (components["schemas"]["SkillRef"] & {
                /** @enum {string} */
                direction?: "in" | "out" | "both";
                /** @enum {string} */
                edge_type?: "RELATED_TO" | "PREREQUISITE_OF" | "REPLACES";
                weight?: number;
            })[];
            successor?: components["schemas"]["SkillRef"] | null;
        };
        SkillRef: {
            name?: string;
            node_type?: components["schemas"]["NodeType"];
            path?: string;
            /** Format: uuid */
            skill_id?: string;
        };
    };
    responses: {
        /** @description The job profile. */
        JobProfileWithETag: {
            headers: {
                ETag: components["headers"]["ETag"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["JobProfile"];
            };
        };
        /** @description RFC 9457 problem document. */
        Problem: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The skill. */
        SkillWithETag: {
            headers: {
                ETag: components["headers"]["ETag"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Skill"];
            };
        };
    };
    parameters: {
        /** @description ETag from the last read. Missing → 428, stale → 412. */
        IfMatch: string;
        JobProfileId: string;
        SkillId: string;
        /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
        TenantId: string;
    };
    requestBodies: never;
    headers: {
        /** @description Version, e.g. "3" */
        ETag: string;
    };
    pathItems: {
        archiveJobProfile: {
            parameters: {
                query?: {
                    /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                    tenant_id?: components["parameters"]["TenantId"];
                };
                header?: never;
                path: {
                    jobProfileId: components["parameters"]["JobProfileId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** Archive (read-only afterwards). */
            post: operations["archiveJobProfile"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        commitImport: {
            parameters: {
                query?: {
                    /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                    tenant_id?: components["parameters"]["TenantId"];
                };
                header?: never;
                path: {
                    importId: string;
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** Apply a dry run atomically. Refused with errors (422) or if the taxonomy changed since (409 IMPORT_STALE). */
            post: operations["commitTaxonomyImport"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        deprecateSkill: {
            parameters: {
                query?: {
                    /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                    tenant_id?: components["parameters"]["TenantId"];
                };
                header?: never;
                path: {
                    skillId: components["parameters"]["SkillId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** Deprecate (row kept) with an optional same-type successor; emits taxonomy.skill.deprecated.v1. */
            post: operations["deprecateSkill"];
            delete?: never;
            options?: never;
            head?: never;
            patch?: never;
            trace?: never;
        };
        publishJobProfile: {
            parameters: {
                query?: {
                    /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                    tenant_id?: components["parameters"]["TenantId"];
                };
                header?: never;
                path: {
                    jobProfileId: components["parameters"]["JobProfileId"];
                };
                cookie?: never;
            };
            get?: never;
            put?: never;
            /** Publish (needs ≥ 1 skill); emits taxonomy.job_profile.updated.v1. */
            post: operations["publishJobProfile"];
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
    listJobFamilies: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description {items} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createJobFamily: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                };
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            409: components["responses"]["Problem"];
        };
    };
    listJobProfiles: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                status?: "draft" | "published" | "archived";
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description {items, next_cursor} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createJobProfile: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    /** Format: uuid */
                    job_role_id?: string | null;
                    title: string;
                };
            };
        };
        responses: {
            201: components["responses"]["JobProfileWithETag"];
        };
    };
    getJobProfile: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                jobProfileId: components["parameters"]["JobProfileId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["JobProfileWithETag"];
            404: components["responses"]["Problem"];
        };
    };
    patchJobProfile: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header: {
                /** @description ETag from the last read. Missing → 428, stale → 412. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                jobProfileId: components["parameters"]["JobProfileId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    /** Format: uuid */
                    job_role_id?: string | null;
                    title?: string;
                };
            };
        };
        responses: {
            200: components["responses"]["JobProfileWithETag"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    putJobProfileSkills: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header: {
                /** @description ETag from the last read. Missing → 428, stale → 412. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                jobProfileId: components["parameters"]["JobProfileId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    skills: {
                        /** @default false */
                        must_have?: boolean;
                        /** Format: uuid */
                        skill_id: string;
                        target_proficiency: number;
                        weight: number;
                    }[];
                };
            };
        };
        responses: {
            200: components["responses"]["JobProfileWithETag"];
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    listJobRoles: {
        parameters: {
            query?: {
                job_family_id?: string;
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description {items} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createJobRole: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    job_family_id: string;
                    level?: string | null;
                    name: string;
                };
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    addSkillEdge: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    dst: string;
                    /** @enum {string} */
                    edge_type: "RELATED_TO" | "PREREQUISITE_OF";
                    /** Format: uuid */
                    src: string;
                    /** @default 1 */
                    weight?: number;
                };
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    removeSkillEdge: {
        parameters: {
            query: {
                dst: string;
                edge_type: "RELATED_TO" | "PREREQUISITE_OF";
                src: string;
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    listSkillSuggestions: {
        parameters: {
            query?: {
                limit?: number;
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Suggestions, most frequent first. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listSkills: {
        parameters: {
            query?: {
                classification?: components["schemas"]["Classification"];
                cursor?: string;
                include_deprecated?: "true" | "false";
                limit?: number;
                node_type?: components["schemas"]["NodeType"];
                /** @description Subtree (ltree) */
                path?: string;
                /** @description Name or alias search */
                q?: string;
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of skills. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["Skill"][];
                        next_cursor: string | null;
                    };
                };
            };
            400: components["responses"]["Problem"];
        };
    };
    createSkill: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateSkillRequest"];
            };
        };
        responses: {
            201: components["responses"]["SkillWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    normalizeSkills: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * Format: uuid
                     * @description Platform principals only.
                     */
                    tenant_id?: string;
                    terms: string[];
                };
            };
        };
        responses: {
            /** @description One result per term, in order. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        results: {
                            confidence: number;
                            /** @enum {string} */
                            method: "alias" | "ann" | "none";
                            /** Format: uuid */
                            skill_id: string | null;
                            term: string;
                        }[];
                    };
                };
            };
            400: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getSkill: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The skill. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillDetail"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    patchSkill: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header: {
                /** @description ETag from the last read. Missing → 428, stale → 412. */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchSkillRequest"];
            };
        };
        responses: {
            200: components["responses"]["SkillWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    putSkillOverride: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @default false */
                    adopted?: boolean;
                    aliases?: string[];
                    display_name?: string | null;
                    /** @default false */
                    hidden?: boolean;
                };
            };
        };
        responses: {
            /** @description The skill as the tenant now sees it. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Skill"];
                };
            };
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
        };
    };
    deleteSkillOverride: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    uploadTaxonomyImport: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    file: string;
                };
            };
        };
        responses: {
            /** @description Dry run stored. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Import"];
                };
            };
            400: components["responses"]["Problem"];
        };
    };
    getTaxonomyImport: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                importId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The import. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Import"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    publishTaxonomy: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Published: {version, changed_skills}. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            422: components["responses"]["Problem"];
        };
    };
    reembedTaxonomy: {
        parameters: {
            query?: {
                limit?: number;
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description {embedded, remaining} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            503: components["responses"]["Problem"];
        };
    };
    getTaxonomyVersion: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Version info. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        pending_changes?: number;
                        published_version?: number;
                        tenant_id?: string | null;
                    };
                };
            };
        };
    };
    archiveJobProfile: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                jobProfileId: components["parameters"]["JobProfileId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["JobProfileWithETag"];
            422: components["responses"]["Problem"];
        };
    };
    commitTaxonomyImport: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                importId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Committed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Import"];
                };
            };
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    deprecateSkill: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                skillId: components["parameters"]["SkillId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    replaced_by?: string | null;
                };
            };
        };
        responses: {
            /** @description The deprecated skill with its successor. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SkillDetail"];
                };
            };
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    publishJobProfile: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant (another id gives 404). */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                jobProfileId: components["parameters"]["JobProfileId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["JobProfileWithETag"];
            422: components["responses"]["Problem"];
        };
    };
}
