/* eslint-disable */
// Generated from services/interview-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

export type paths = {
    "/v1/interview-sessions/{session_id}:join": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Join */
        post: operations["join_v1_interview_sessions__session_id__join_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/interview-sessions/{session_id}/evaluation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Evaluation */
        get: operations["evaluation_v1_interview_sessions__session_id__evaluation_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/interview-sessions/{session_id}/evaluation:override": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Override */
        post: operations["override_v1_interview_sessions__session_id__evaluation_override_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/interview-sessions/{session_id}/transcript": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Transcript */
        get: operations["transcript_v1_interview_sessions__session_id__transcript_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/interviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Interview */
        post: operations["create_interview_v1_interviews_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/interviews/{interview_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Interview */
        get: operations["get_interview_v1_interviews__interview_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/interviews/{interview_id}:publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish Interview */
        post: operations["publish_interview_v1_interviews__interview_id__publish_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/interviews/{interview_id}/plan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update Plan */
        put: operations["update_plan_v1_interviews__interview_id__plan_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/interviews/{interview_id}/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Session */
        post: operations["create_session_v1_interviews__interview_id__sessions_post"];
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
        /** CreateInterview */
        CreateInterview: {
            /** Job Profile Id */
            job_profile_id: string;
            /**
             * Language
             * @default en
             */
            language: string;
            /**
             * Max Minutes
             * @default 20
             */
            max_minutes: number;
            /**
             * Mode
             * @enum {string}
             */
            mode: "voice" | "text";
            /**
             * Plan
             * @description A plan to use as-is; omitted, one is generated from the profile.
             */
            plan?: {
                [key: string]: unknown;
            } | null;
            /**
             * Questions Per Skill
             * @default 1
             */
            questions_per_skill: number;
            thresholds?: components["schemas"]["Thresholds"] | null;
            /** Title */
            title?: string | null;
        };
        /** CreateSession */
        CreateSession: {
            /** Assessment Id */
            assessment_id: string;
            /** Assessment Session Id */
            assessment_session_id: string;
            /** Candidate Id */
            candidate_id: string;
            /** Question Id */
            question_id: string;
            /** Tenant Id */
            tenant_id: string;
        };
        /** OverrideBody */
        OverrideBody: {
            /** Reason */
            reason: string;
            /** Recommendation */
            recommendation?: ("advance" | "hold" | "do_not_advance") | null;
            /** Scores */
            scores?: {
                [key: string]: number | null;
            };
        };
        /** PlanBody */
        PlanBody: {
            /** Plan */
            plan: {
                [key: string]: unknown;
            };
        };
        /** @description RFC 9457 problem document; `code` is the stable machine-readable error. */
        Problem: {
            code: string;
            detail?: string;
            instance?: string;
            request_id?: string;
            status: number;
            title: string;
            /** Format: uri */
            type: string;
        } & {
            [key: string]: unknown;
        };
        /** Thresholds */
        Thresholds: {
            /**
             * Advance
             * @default 3.5
             */
            advance: number;
            /**
             * Hold
             * @default 2.5
             */
            hold: number;
        };
    };
    responses: {
        /** @description Invalid request (VALIDATION_FAILED, INVALID_PLAN, TENANT_REQUIRED and others). */
        400: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Missing or invalid bearer or interview token. */
        401: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The caller lacks the role, scope or tenant. */
        403: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Interview, session, job profile or evaluation not found (EVALUATION_NOT_READY). */
        404: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description INTERVIEW_NOT_PUBLISHED, NOTHING_TO_PUBLISH, INTERVIEW_ENDED, CONCURRENT_UPDATE. */
        409: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description JOB_PROFILE_WITHOUT_SKILLS. */
        422: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description PLAN_GENERATION_FAILED: the generated plan did not pass validation. */
        502: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description A dependency (llm-gateway, taxonomy-svc, tenant-svc) is unavailable. */
        503: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    join_v1_interview_sessions__session_id__join_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            409: components["responses"]["409"];
        };
    };
    evaluation_v1_interview_sessions__session_id__evaluation_get: {
        parameters: {
            query?: {
                tenant_id?: string | null;
            };
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
        };
    };
    override_v1_interview_sessions__session_id__evaluation_override_post: {
        parameters: {
            query?: {
                tenant_id?: string | null;
            };
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OverrideBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
        };
    };
    transcript_v1_interview_sessions__session_id__transcript_get: {
        parameters: {
            query?: {
                tenant_id?: string | null;
            };
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
        };
    };
    create_interview_v1_interviews_post: {
        parameters: {
            query?: {
                tenant_id?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateInterview"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            422: components["responses"]["422"];
            502: components["responses"]["502"];
            503: components["responses"]["503"];
        };
    };
    get_interview_v1_interviews__interview_id__get: {
        parameters: {
            query?: {
                tenant_id?: string | null;
            };
            header?: never;
            path: {
                interview_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
        };
    };
    publish_interview_v1_interviews__interview_id__publish_post: {
        parameters: {
            query?: {
                tenant_id?: string | null;
            };
            header?: never;
            path: {
                interview_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
        };
    };
    update_plan_v1_interviews__interview_id__plan_put: {
        parameters: {
            query?: {
                tenant_id?: string | null;
            };
            header?: never;
            path: {
                interview_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanBody"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
        };
    };
    create_session_v1_interviews__interview_id__sessions_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                interview_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateSession"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            400: components["responses"]["400"];
            401: components["responses"]["401"];
            403: components["responses"]["403"];
            404: components["responses"]["404"];
            409: components["responses"]["409"];
            503: components["responses"]["503"];
        };
    };
}
