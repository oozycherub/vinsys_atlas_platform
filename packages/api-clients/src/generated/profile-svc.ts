/* eslint-disable */
// Generated from services/profile-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

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
    "/v1/candidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A page of candidates (no PII), or an exact email match via the blind index (pii:read). */
        get: operations["listCandidates"];
        put?: never;
        /** Create a candidate (Idempotency-Key). The response never echoes PII. */
        post: operations["createCandidate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/candidates/{candidateId}": {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                candidateId: components["parameters"]["CandidateId"];
            };
            cookie?: never;
        };
        /** A candidate; PII decrypted only for pii:read. */
        get: operations["getCandidate"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update attributes, PII (pii:read) or legal hold (tenant_admin). */
        patch: operations["patchCandidate"];
        trace?: never;
    };
    "/v1/candidates/{candidateId}/skill-evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record evidence: self (own profile, reason required), manager/multi_rater (tenant_admin, hiring_manager), system sources (service). */
        post: operations["addSkillEvidence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/candidates/{candidateId}/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fused current proficiencies (optionally with the evidence ledger). */
        get: operations["getCandidateSkills"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/documents:initiateUpload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Presigned PUT (15 min) bound to type, size and SHA-256. Max 10 MB. */
        post: operations["initiateUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/documents/{documentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Document metadata and parse status. */
        get: operations["getDocument"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/storage-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * S3/MinIO ObjectCreated notifications. Role service, scope storage-events:write.
         * @description Verifies size and real content type (magic bytes); mismatches are quarantined. Repeats are no-ops.
         */
        post: operations["storageEvents"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/privacy:sweepOverdue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Scheduler: flag erasures whose acknowledgements are past 7 days. */
        post: operations["sweepOverdue"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/privacy:sweepRetention": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Scheduler: erase inactive candidates past retention (not employees, not legal holds). */
        post: operations["sweepRetention"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/privacy/requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Access (encrypted export) or erasure (rows, objects, fan-out, certificate). Roles: tenant_admin, super_admin. */
        post: operations["createPrivacyRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/privacy/requests/{requestId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Status, certificate (erasure) or export (access). */
        get: operations["getPrivacyRequest"];
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
        Candidate: {
            /** Format: uuid */
            candidate_id?: string;
            legal_hold?: boolean;
            pii?: components["schemas"]["Pii"] | null;
            pii_redacted?: boolean;
            /** @description Redacted parsed profile (no PII). */
            profile?: Record<string, never>;
            source?: string;
            /** Format: uuid */
            tenant_id?: string;
            version?: number;
        };
        CandidateAttributes: {
            /** @description Must not contain PII. */
            consent?: Record<string, never>;
            current_title?: string | null;
            department?: string | null;
            external_ref?: string | null;
            /** Format: uuid */
            job_profile_id?: string | null;
            location_country?: string | null;
            marketplace_opt_in?: boolean;
            total_experience_months?: number | null;
            /** Format: uuid */
            user_id?: string | null;
        };
        CreateCandidateRequest: components["schemas"]["CandidateAttributes"] & {
            pii: components["schemas"]["Pii"];
            /** @enum {string} */
            source: "external_applicant" | "employee" | "referral" | "sourced" | "rediscovered";
            /** Format: uuid */
            tenant_id?: string;
        };
        CurrentSkill: {
            calibration_needed?: boolean;
            /** Format: date-time */
            computed_at?: string;
            evidence_count?: number;
            is_validated?: boolean;
            proficiency?: number;
            /** Format: uuid */
            skill_id?: string;
        };
        EvidenceInput: {
            /** @default 1 */
            confidence: number;
            /** Format: date-time */
            observed_at?: string;
            proficiency: number;
            /** @description Required for self. */
            reason?: string | null;
            /** Format: uuid */
            skill_id: string;
            /** @enum {string} */
            source: "assessment" | "certification" | "manager" | "ai_interview" | "multi_rater" | "project_inference" | "resume_inference" | "learning_completion" | "self";
            /** Format: uuid */
            source_ref?: string | null;
            /** Format: date-time */
            valid_until?: string | null;
        };
        PatchCandidateRequest: components["schemas"]["CandidateAttributes"] & {
            /** @description tenant_admin only. */
            legal_hold?: boolean;
            /** @description Partial PII; omitted fields keep their value. */
            pii?: Record<string, never>;
        };
        Pii: {
            address?: string | null;
            /** Format: date */
            dob?: string | null;
            /** Format: email */
            email?: string | null;
            full_name: string;
            phone?: string | null;
        };
        PrivacyRequest: {
            ack_required_from?: string[];
            acks?: Record<string, never>[];
            /** Format: uuid */
            candidate_id?: string;
            certificate?: Record<string, never> | null;
            /** @description Access requests only. */
            export?: Record<string, never>;
            /** Format: uuid */
            request_id?: string;
            /** @enum {string} */
            status?: "completed" | "awaiting_acks" | "overdue";
            /** @enum {string} */
            type?: "access" | "erasure";
        };
        Problem: {
            /** Format: uuid */
            candidate_id?: string;
            /**
             * @example CANDIDATE_NOT_FOUND
             * @example CANDIDATE_EMAIL_TAKEN
             * @example PII_IN_PROFILE
             * @example DOCUMENT_DUPLICATE
             * @example DOCUMENT_TOO_LARGE
             * @example UNSUPPORTED_MIME_TYPE
             * @example SOURCE_NOT_ALLOWED
             * @example REASON_REQUIRED
             * @example SKILL_NOT_FOUND
             * @example LEGAL_HOLD
             * @example TENANT_ID_REQUIRED
             * @example TAXONOMY_UNAVAILABLE
             */
            code: string;
            detail: string;
            /** Format: uuid */
            document_id?: string;
            instance: string;
            status: number;
            title: string;
            /** Format: uri */
            type: string;
        };
    };
    responses: {
        /** @description The candidate. */
        CandidateWithETag: {
            headers: {
                "Cache-Control"?: string;
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Candidate"];
            };
        };
        /** @description The privacy request. */
        PrivacyRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["PrivacyRequest"];
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
    };
    parameters: {
        CandidateId: string;
        IdempotencyKey: string;
        IfMatch: string;
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
    listCandidates: {
        parameters: {
            query?: {
                cursor?: string;
                email?: string;
                limit?: number;
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Candidates. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items?: components["schemas"]["Candidate"][];
                        next_cursor?: string | null;
                    };
                };
            };
            403: components["responses"]["Problem"];
        };
    };
    createCandidate: {
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
                "application/json": components["schemas"]["CreateCandidateRequest"];
            };
        };
        responses: {
            201: components["responses"]["CandidateWithETag"];
            400: components["responses"]["Problem"];
            /** @description CANDIDATE_EMAIL_TAKEN (with candidate_id) or another unique conflict. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            422: components["responses"]["Problem"];
        };
    };
    getCandidate: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                candidateId: components["parameters"]["CandidateId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["CandidateWithETag"];
            404: components["responses"]["Problem"];
        };
    };
    patchCandidate: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header: {
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                candidateId: components["parameters"]["CandidateId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PatchCandidateRequest"];
            };
        };
        responses: {
            200: components["responses"]["CandidateWithETag"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
            412: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    addSkillEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                candidateId: components["parameters"]["CandidateId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    evidence: components["schemas"]["EvidenceInput"][];
                    /** Format: uuid */
                    tenant_id?: string;
                };
            };
        };
        responses: {
            /** @description The recomputed skills. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        skills?: components["schemas"]["CurrentSkill"][];
                    };
                };
            };
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    getCandidateSkills: {
        parameters: {
            query?: {
                include?: "evidence";
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                candidateId: components["parameters"]["CandidateId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Skills. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        candidate_id?: string;
                        evidence?: Record<string, never>[];
                        skills?: components["schemas"]["CurrentSkill"][];
                    };
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    initiateUpload: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    byte_size: number;
                    /** Format: uuid */
                    candidate_id: string;
                    /** @enum {string} */
                    mime_type: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/msword" | "image/png" | "image/jpeg" | "text/plain";
                    sha256: string;
                    /** Format: uuid */
                    tenant_id?: string;
                };
            };
        };
        responses: {
            /** @description Upload with these headers to upload_url. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        document_id?: string;
                        /** Format: date-time */
                        expires_at?: string;
                        upload_headers?: {
                            [key: string]: string;
                        };
                        /** Format: uri */
                        upload_url?: string;
                    };
                };
            };
            400: components["responses"]["Problem"];
            /** @description DOCUMENT_DUPLICATE with the existing document_id. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getDocument: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                documentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The document. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    storageEvents: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    keys: string[];
                } | {
                    Records: Record<string, never>[];
                };
            };
        };
        responses: {
            /** @description Per key: uploaded | quarantined | ignored | <current status>. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Problem"];
        };
    };
    sweepOverdue: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description {overdue: [request_id]} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    sweepRetention: {
        parameters: {
            query?: {
                limit?: number;
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description {erased: [candidate_id]} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createPrivacyRequest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    candidate_id: string;
                    /** Format: uuid */
                    tenant_id?: string;
                    /** @enum {string} */
                    type: "access" | "erasure";
                };
            };
        };
        responses: {
            201: components["responses"]["PrivacyRequest"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    getPrivacyRequest: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                requestId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["PrivacyRequest"];
            404: components["responses"]["Problem"];
        };
    };
}
