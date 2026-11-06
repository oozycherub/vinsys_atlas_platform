/* eslint-disable */
// Generated from services/intelligence-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

export type paths = {
    "/healthz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liveness. */
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
        /** Readiness (the database answers). */
        get: operations["readyz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/allocations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove an allocation (emits intel.allocation.changed.v1). */
        delete: operations["removeAllocation"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/analytics/skill-gaps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Heat-map cells (groups under 3 employees are suppressed), with the trend over the period. */
        get: operations["skillGaps"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/applications/{id}:{verb}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** accept, decline, withdraw or disclose. Accepting books the allocation (409 ALLOCATION_EXCEEDS_CAPACITY over 100%). */
        post: operations["decideApplication"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/attrition/alerts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Attrition alerts (HRBP: scope hrbp; audit-logged). */
        get: operations["attritionAlerts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/attrition/alerts/{id}:acknowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Acknowledge an open alert (HRBP). */
        post: operations["acknowledgeAlert"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/attrition/employees/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** An employee's recent scores and drivers (HRBP). */
        get: operations["attritionEmployee"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/attrition/model": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The active model's metrics, features, exclusions, gates and drift (HRBP). */
        get: operations["attritionModel"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/demand-batches/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** An upload's result. */
        get: operations["getDemandBatch"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/demands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Demand lines. */
        get: operations["listDemands"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/demands:upload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** A .csv or .xlsx sheet of demand lines (base64 in JSON, up to 5 MB); bad rows are reported by row. */
        post: operations["uploadDemands"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/employees:bulkUpsert": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** HRIS sync of up to 500 employees. */
        post: operations["bulkSyncEmployees"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/employees/{id}": {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /** The employee's own record, for themselves, their manager or HR admins (never risk data). */
        get: operations["getEmployee"];
        /** HRIS sync of one employee (tenant_admin, or a service with scope hris:sync). */
        put: operations["syncEmployee"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/employees/{id}/allocations": {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /** Project allocations of an employee. */
        get: operations["employeeAllocations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/employees/{id}/applications": {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /** The employee's applications; their current manager sees only disclosed ones (unless the tenant policy says otherwise). */
        get: operations["employeeApplications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/employees/{id}/career-paths": {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /** Typed paths (vertical, horizontal, diagonal) up to 3 steps, with readiness, gaps and learning. */
        get: operations["careerPaths"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/employees/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's own roster record (found by user id), with their role gap. */
        get: operations["getMyEmployee"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/fulfilment-plans:compute": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Queue a plan for intelligence-ml (CP-SAT); a queued or running plan for the same account is returned instead. */
        post: operations["computePlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/fulfilment-plans/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A plan; when done, one line per demand slot: redeploy, upskill or recruit. */
        get: operations["getPlan"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/intelligence/policy": {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Marketplace and attrition policy (managers and admins). */
        get: operations["getPolicy"];
        /** Set the policy (tenant_admin). */
        put: operations["setPolicy"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/job-profile-transitions": {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** TRANSITIONS_TO edges between job profiles. */
        get: operations["listTransitions"];
        /** Create or update an edge (tenant_admin). */
        put: operations["putTransition"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/job-profile-transitions/{from}/{to}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove an edge (tenant_admin). */
        delete: operations["deleteTransition"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/learning-items": {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The learning catalogue (an LMS integration feeds it). */
        get: operations["listLearningItems"];
        put?: never;
        /** Create or update a learning item (tenant_admin). */
        post: operations["putLearningItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/opportunities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's personalised feed (for=me): open opportunities they can take, ranked by Score_internal. */
        get: operations["feed"];
        put?: never;
        /** Create a draft role, project or gig (hiring_manager, tenant_admin). */
        post: operations["createOpportunity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/opportunities/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** An opportunity (drafts only for their owner and admins). */
        get: operations["getOpportunity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/opportunities/{id}:close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Close it. */
        post: operations["closeOpportunity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/opportunities/{id}:publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Open it (emits intel.opportunity.published.v1; the matcher ranks employees). */
        post: operations["publishOpportunity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/opportunities/{id}:recommendCandidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ranked employees with explanations (owner or admin). */
        post: operations["recommendCandidates"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/opportunities/{id}/applications": {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /** Applications and invitations to this opportunity (owner or admin). */
        get: operations["listApplications"];
        put?: never;
        /** The caller applies (opt-in needed except for projects). */
        post: operations["apply"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/opportunities/{id}/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** The owner invites an employee. */
        post: operations["invite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** A project (or client account engagement) to book time on. */
        post: operations["createProject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/projects/{id}/allocations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Book an employee (the database refuses anything over 100% on any day). */
        post: operations["allocate"];
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
        Employee: {
            compa_ratio?: number | null;
            department?: string | null;
            /**
             * Format: uuid
             * @description Bulk only: the profile-svc candidate id.
             */
            employee_id?: string;
            engagement_delta?: number | null;
            /** Format: date */
            hired_at?: string | null;
            /** Format: uuid */
            job_profile_id?: string | null;
            /** Format: date */
            last_promotion_at?: string | null;
            location?: string | null;
            /** Format: date */
            manager_changed_at?: string | null;
            manager_user_id?: string | null;
            marketplace_opt_in?: boolean;
            overtime_hours_4w?: number | null;
            /** @description Fairness-audit attributes only; never model features, readable only by the attrition audit. */
            protected_attributes?: {
                [key: string]: string;
            } | null;
            /** Format: date */
            role_started_at?: string | null;
            /** Format: date-time */
            source_synced_at?: string | null;
            /** @enum {string} */
            status?: "active" | "terminated";
            /** Format: date */
            terminated_at?: string | null;
            termination_voluntary?: boolean | null;
            user_id?: string | null;
        };
        LearningItem: {
            duration_hours: number;
            external_ref?: string | null;
            /** Format: uuid */
            item_id?: string;
            provider?: string | null;
            skill_ids: string[];
            title: string;
            /** Format: uri */
            url?: string | null;
        };
        Opportunity: {
            /** @default 100 */
            allocation_pct: number;
            description?: string;
            /** Format: date */
            end_date?: string | null;
            /** Format: uuid */
            job_profile_id?: string | null;
            location?: string | null;
            /** @default 12 */
            min_tenure_months: number;
            /**
             * Format: uuid
             * @description Required for projects and gigs.
             */
            project_id?: string | null;
            /**
             * Format: uuid
             * @description matching-svc's score for it ranks a linked role.
             */
            requisition_id?: string | null;
            skills?: components["schemas"]["Requirement"][] | null;
            /** Format: date */
            start_date: string;
            title: string;
            /** @enum {string} */
            type: "role" | "project" | "gig";
        };
        Policy: {
            applications_visible_to_manager: boolean;
            attrition_threshold: number;
            learning_hours_per_day: number;
        };
        Requirement: {
            /** @default false */
            must_have: boolean;
            /** Format: uuid */
            skill_id: string;
            target_proficiency: number;
            weight: number;
        };
        Transition: {
            /** Format: uuid */
            from_profile_id: string;
            /** Format: uuid */
            to_profile_id: string;
            /** @enum {string} */
            transition_type: "vertical" | "horizontal" | "diagonal";
            typical_months?: number | null;
        };
    };
    responses: {
        /** @description OK */
        Object: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": Record<string, never>;
            };
        };
        /** @description RFC 9457 problem document (`code` is the stable error). */
        Problem: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": {
                    code: string;
                    detail?: string;
                    request_id?: string;
                    status: number;
                    title: string;
                    type: string;
                };
            };
        };
    };
    parameters: {
        Id: string;
        /** @description Required for platform staff and services; tenant users act on their own tenant. */
        TenantId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
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
            200: components["responses"]["Object"];
            503: components["responses"]["Problem"];
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
            200: components["responses"]["Object"];
            503: components["responses"]["Problem"];
        };
    };
    removeAllocation: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    skillGaps: {
        parameters: {
            query?: {
                group_by?: "department" | "job_profile" | "location";
                period?: string;
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    decideApplication: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
                verb: "accept" | "decline" | "withdraw" | "disclose";
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    attritionAlerts: {
        parameters: {
            query?: {
                limit?: number;
                status?: "open" | "acknowledged" | "closed";
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    acknowledgeAlert: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    attritionEmployee: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    attritionModel: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    getDemandBatch: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    listDemands: {
        parameters: {
            query?: {
                account_id?: string;
                batch_id?: string;
                status?: "open" | "fulfilled" | "cancelled";
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    uploadDemands: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content_base64: string;
                    file_name: string;
                };
            };
        };
        responses: {
            202: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    bulkSyncEmployees: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    employees: components["schemas"]["Employee"][];
                };
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    getEmployee: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    syncEmployee: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Employee"];
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    employeeAllocations: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    employeeApplications: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    careerPaths: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    getMyEmployee: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    computePlan: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    account_id?: string | null;
                    /** @default 90 */
                    horizon_days?: number;
                };
            };
        };
        responses: {
            202: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    getPlan: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    getPolicy: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    setPolicy: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Policy"];
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    listTransitions: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    putTransition: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Transition"];
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    deleteTransition: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                from: string;
                to: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    listLearningItems: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    putLearningItem: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LearningItem"];
            };
        };
        responses: {
            201: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    feed: {
        parameters: {
            query: {
                for: "me";
                limit?: number;
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    createOpportunity: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Opportunity"];
            };
        };
        responses: {
            201: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    getOpportunity: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    closeOpportunity: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    publishOpportunity: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    recommendCandidates: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @default false */
                    include_unavailable?: boolean;
                    /** @default 20 */
                    limit?: number;
                };
            };
        };
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    listApplications: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    apply: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    note?: string | null;
                };
            };
        };
        responses: {
            201: components["responses"]["Object"];
            409: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    invite: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    employee_id: string;
                    note?: string | null;
                };
            };
        };
        responses: {
            201: components["responses"]["Object"];
            409: components["responses"]["Problem"];
        };
    };
    createProject: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    account_id?: string | null;
                    /** Format: date */
                    end_date?: string | null;
                    name: string;
                    /** Format: date */
                    start_date: string;
                };
            };
        };
        responses: {
            201: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    allocate: {
        parameters: {
            query?: {
                /** @description Required for platform staff and services; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    employee_id: string;
                    /** Format: date */
                    end_date?: string | null;
                    percent: number;
                    /** Format: date */
                    start_date: string;
                };
            };
        };
        responses: {
            201: components["responses"]["Object"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
}
