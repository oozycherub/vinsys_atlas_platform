/* eslint-disable */
// Generated from services/matching-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

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
    "/v1/candidates/{candidateId}/matches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A candidate's stored scores against open requisitions, best first. */
        get: operations["getCandidateMatches"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/job-requisitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Requisitions, newest first (cursor pagination). */
        get: operations["listRequisitions"];
        put?: never;
        /** Create a requisition (Idempotency-Key). Roles: tenant_admin, recruiter, hiring_manager; staff and services pass tenant_id. */
        post: operations["createRequisition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/job-requisitions/{requisitionId}": {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                requisitionId: components["parameters"]["RequisitionId"];
            };
            cookie?: never;
        };
        /** A requisition with its calibration state. */
        get: operations["getRequisition"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Edit fields (If-Match). Changing what it asks for marks the calibration stale. */
        patch: operations["patchRequisition"];
        trace?: never;
    };
    "/v1/job-requisitions/{requisitionId}:calibrate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Snapshot requirements (linked job profile, or `skills`), related-skill weights ρ ≤ 0.8 and the requisition embedding; then rank all candidates (rediscovery). Emits matching.requisition.calibrated.v1. */
        post: operations["calibrateRequisition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/job-requisitions/{requisitionId}:match": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ranked candidates with score, band, components and explanation. Cached 10 min per (requisition, calibration, weights_version). */
        post: operations["matchRequisition"];
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
        /** @description Each component in [0, 1]; gate is the must-have multiplier (1, 0.5, 0.25, …). */
        Components: {
            cov?: number;
            exp?: number;
            gate?: number;
            lex?: number;
            sem?: number;
            sem_cosine?: number;
        };
        CreateRequisition: {
            description?: string;
            /** Format: uuid */
            hiring_manager_id?: string | null;
            /** Format: uuid */
            job_profile_id?: string | null;
            keywords?: string[];
            location?: string | null;
            min_experience_years?: number | null;
            /** @default 1 */
            openings: number;
            /** Format: uuid */
            tenant_id?: string;
            title: string;
        };
        Explanation: {
            closest_chunks?: string[];
            /** @description Redacted résumé snippets supporting matched skills. */
            evidence?: {
                /** Format: uuid */
                skill_id?: string;
                snippet?: string;
            }[];
            gaps?: components["schemas"]["SkillLine"][];
            matched?: components["schemas"]["SkillLine"][];
            must_have_failed?: string[];
            partial?: components["schemas"]["SkillLine"][];
        };
        PatchRequisition: {
            description?: string;
            /** Format: uuid */
            hiring_manager_id?: string | null;
            /** Format: uuid */
            job_profile_id?: string | null;
            keywords?: string[];
            location?: string | null;
            min_experience_years?: number | null;
            openings?: number;
            /** @enum {string} */
            status?: "open" | "on_hold" | "closed";
            title?: string;
        };
        Problem: {
            /**
             * @example REQUISITION_NOT_FOUND
             * @example REQUISITION_NOT_CALIBRATED
             * @example REQUISITION_CLOSED
             * @example NO_REQUIREMENTS
             * @example INVALID_WEIGHTS
             * @example DEPENDENCY_UNAVAILABLE
             */
            code: string;
            detail: string;
            errors?: Record<string, never>[];
            instance: string;
            request_id?: string;
            status: number;
            title: string;
            /** Format: uri */
            type: string;
        };
        Requisition: {
            calibration?: {
                /** Format: date-time */
                calibrated_at?: string | null;
                embedding_model?: string | null;
                job_profile_version?: number | null;
                skills?: {
                    must_have?: boolean;
                    name?: string | null;
                    /** @description Number of related skills that can give partial credit. */
                    related?: number;
                    /** Format: uuid */
                    skill_id?: string;
                    target?: number;
                    weight?: number;
                }[];
                /** @enum {string|null} */
                source?: "job_profile" | "manual" | null;
                /** @enum {string} */
                status?: "uncalibrated" | "calibrated" | "stale";
                version?: number;
            };
            /** Format: date-time */
            created_at?: string;
            description?: string;
            /** Format: uuid */
            hiring_manager_id?: string | null;
            /** Format: uuid */
            job_profile_id?: string | null;
            keywords?: string[];
            location?: string | null;
            min_experience_years?: number | null;
            openings?: number;
            /** Format: uuid */
            requisition_id?: string;
            /** @enum {string} */
            status?: "open" | "on_hold" | "closed";
            /** Format: uuid */
            tenant_id?: string;
            title?: string;
            /** Format: date-time */
            updated_at?: string;
            version?: number;
        };
        ScoredCandidate: {
            /** @enum {string} */
            band?: "strong" | "good" | "partial" | "weak";
            /** Format: uuid */
            candidate_id?: string;
            components?: components["schemas"]["Components"];
            explanation?: components["schemas"]["Explanation"];
            score?: number;
        };
        SkillLine: {
            candidate?: number | null;
            must_have?: boolean;
            required?: number;
            /** Format: uuid */
            skill_id?: string;
            /** @description The related skill that supplied partial credit. */
            via?: {
                rho?: number;
                /** Format: uuid */
                skill_id?: string;
            };
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
        /** @description The requisition. */
        RequisitionWithETag: {
            headers: {
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Requisition"];
            };
        };
    };
    parameters: {
        IdempotencyKey: string;
        IfMatch: string;
        RequisitionId: string;
        /** @description Platform principals only; tenant users act on their own tenant. */
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
    getCandidateMatches: {
        parameters: {
            query?: {
                limit?: number;
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                candidateId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The candidate's matches. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        candidate_id: string;
                        items: {
                            band?: string;
                            components?: components["schemas"]["Components"];
                            /** Format: date-time */
                            computed_at?: string;
                            explanation?: components["schemas"]["Explanation"];
                            /** Format: uuid */
                            requisition_id?: string;
                            score?: number;
                            status?: string;
                            title?: string;
                            weights_version?: string;
                        }[];
                    };
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    listRequisitions: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                status?: "open" | "on_hold" | "closed";
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of requisitions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["Requisition"][];
                        next_cursor: string | null;
                    };
                };
            };
            422: components["responses"]["Problem"];
        };
    };
    createRequisition: {
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
                "application/json": components["schemas"]["CreateRequisition"];
            };
        };
        responses: {
            201: components["responses"]["RequisitionWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    getRequisition: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                requisitionId: components["parameters"]["RequisitionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RequisitionWithETag"];
            404: components["responses"]["Problem"];
        };
    };
    patchRequisition: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header: {
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                requisitionId: components["parameters"]["RequisitionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchRequisition"];
            };
        };
        responses: {
            200: components["responses"]["RequisitionWithETag"];
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    calibrateRequisition: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                requisitionId: components["parameters"]["RequisitionId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    skills?: {
                        /** @default false */
                        must_have?: boolean;
                        /** Format: uuid */
                        skill_id: string;
                        target: number;
                        weight: number;
                    }[];
                };
            };
        };
        responses: {
            /** @description The calibrated requisition. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Requisition"];
                };
            };
            404: components["responses"]["Problem"];
            /** @description NO_REQUIREMENTS, JOB_PROFILE_NOT_FOUND or REQUISITION_CLOSED. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
    matchRequisition: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                requisitionId: components["parameters"]["RequisitionId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    filters?: {
                        bands?: ("strong" | "good" | "partial" | "weak")[];
                        exclude_candidate_ids?: string[];
                        min_score?: number;
                    };
                    /** @default 50 */
                    limit?: number;
                    /**
                     * Format: uuid
                     * @description Platform principals only.
                     */
                    tenant_id?: string;
                };
            };
        };
        responses: {
            /** @description Ranked candidates. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        cached: boolean;
                        calibration_version: number;
                        /** Format: date-time */
                        computed_at: string;
                        /** Format: uuid */
                        requisition_id: string;
                        results: components["schemas"]["ScoredCandidate"][];
                        total: number;
                        weights_version: string;
                    };
                };
            };
            404: components["responses"]["Problem"];
            /** @description REQUISITION_NOT_CALIBRATED, REQUISITION_CLOSED or INVALID_WEIGHTS. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            503: components["responses"]["Problem"];
        };
    };
}
