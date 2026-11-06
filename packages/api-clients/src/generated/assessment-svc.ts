/* eslint-disable */
// Generated from services/assessment-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

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
    "/v1/assessments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Latest version of each assessment. */
        get: operations["listAssessments"];
        put?: never;
        /** Create a draft (≤ 20 sections, ≤ 5 banks per section). */
        post: operations["createAssessment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/assessments/{assessmentId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        /** The latest version, or `version`. */
        get: operations["getAssessment"];
        /** Edit the draft (If-Match: lock_version). Published versions → 422 ASSESSMENT_PUBLISHED. */
        put: operations["updateDraft"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/assessments/{assessmentId}:clone": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** A new assessment (version 1, draft) with the same content. */
        post: operations["cloneAssessment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/assessments/{assessmentId}:newVersion": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** A draft version n+1 copied from the latest published version. */
        post: operations["newAssessmentVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/assessments/{assessmentId}:publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pin question versions, check bank sizes, freeze the version. Coding questions (fixed and in referenced banks) need test cases verified by sandbox-svc: 422 REFERENCE_SOLUTION_REQUIRED, CODING_TESTS_PENDING (retry shortly) or CODING_TESTS_INVALID. Emits assessment.assessment.published.v1 (with coding_languages). */
        post: operations["publishAssessment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/assessments/{assessmentId}:setStatus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish again, deactivate or archive a version (the latest unless `version`). */
        post: operations["setAssessmentStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/assessments/{assessmentId}/invite-links": {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        /** Invites (without tokens). */
        get: operations["listInviteLinks"];
        put?: never;
        /** Open link or targeted invite to the published version. The token is returned once. */
        post: operations["createInviteLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/assessments/{assessmentId}/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Results, best first. Roles: tenant_admin, recruiter, hiring_manager, reviewer, sme. */
        get: operations["listSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/invite-links/{inviteId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke an invite. */
        delete: operations["revokeInviteLink"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/invite-links/{token}:redeem": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Candidate: turn an invite into a session. Open links need name and email. */
        post: operations["redeemInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/question-banks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a question bank. Roles: tenant_admin, recruiter, sme. */
        post: operations["createQuestionBank"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/questions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Latest versions, newest first. */
        get: operations["listQuestions"];
        put?: never;
        /** Create a question (version 1). The payload includes the hidden answer key. */
        post: operations["createQuestion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/questions/{questionId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                questionId: string;
            };
            cookie?: never;
        };
        /** A question version with its difficulty index (p = correct / attempts, from 10 attempts). */
        get: operations["getQuestion"];
        /** Create version n+1 (versions are immutable; published assessments keep theirs). */
        put: operations["reviseQuestion"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/questions/{questionId}:retire": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retire every version (no new bank draws). */
        post: operations["retireQuestion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Candidate: session state and the server-authoritative remaining time. */
        get: operations["getRunnerSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}:heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Candidate: keep-alive; resumes an interrupted session with the paused time credited (up to the allowance). */
        post: operations["heartbeat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}:review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** An assigned reviewer scores every reviewable question. The score is held until all reviewers finish; then the mean is released. */
        post: operations["reviewSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}:start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Candidate: start the timer (deadline = now + duration). Emits assessment.session.started.v1. */
        post: operations["startSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}:submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Candidate: submit. Exactly one of concurrent submits wins; after the deadline 409 SESSION_EXPIRED. */
        post: operations["submitSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/candidate-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Shortlist, hold or reject (If-Match: lock_version). */
        patch: operations["setCandidateStatus"];
        trace?: never;
    };
    "/v1/sessions/{sessionId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Candidate SSE: state, time_warning, paused, resumed, terminated, ended. */
        get: operations["sessionEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/questions/{n}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Candidate: question n (no answer key) with the saved answer and client_rev. */
        get: operations["getQuestionForCandidate"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/questions/{questionId}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Candidate: run code against the sample tests, or custom stdin (forwarded to sandbox-svc; 1 run per 3 s). */
        post: operations["runCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/questions/{questionId}/submissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Candidate: submit code for judging against all tests. The same code for the same question is one submission (retries are safe); the latest submission's verdict counts. Unsubmitted drafts are submitted automatically when the session ends. */
        post: operations["submitCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/responses/{questionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Candidate: autosave; accepted only as the next client_rev and before the deadline. */
        put: operations["saveResponse"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Staff view with per-question answers, scores and the answer key. */
        get: operations["getSessionResult"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/reviewers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Assign reviewers to a session awaiting review. */
        post: operations["assignReviewers"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/runs/{runId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Candidate: a run's output (`wait` long-polls up to 10 s). Only runs of this session. */
        get: operations["getRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sessions/{sessionId}/submissions/{submissionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Candidate: verdict and per-test summary; hidden tests show pass/fail only. */
        get: operations["getCodeSubmission"];
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
        AssessmentInput: {
            candidate_alias?: string | null;
            /** @description sections[1..20] of {title, questions[{question_id, version?, marks?}], banks[≤5 {bank_id, count, difficulty?}]} */
            definition: Record<string, never>;
            duration_seconds: number;
            /** Format: uuid */
            job_profile_id?: string | null;
            /** @enum {string} */
            kind?: "skills_test" | "coding" | "ai_interview" | "mixed";
            /** @enum {string} */
            navigation?: "fixed_section_order" | "section_switch";
            /** @description {bands[{name, min_percent}] (one at 0 %), skill_validity_months} */
            report_config?: Record<string, never>;
            /** @description {max_attempts, retake_cooldown_days, pause_allowance_seconds, shuffle_questions} */
            settings?: Record<string, never>;
            /** Format: uuid */
            tenant_id?: string;
            title: string;
        };
        Problem: {
            /**
             * @example SESSION_EXPIRED
             * @example STALE_REVISION
             * @example SECTION_LOCKED
             * @example INVITE_EXHAUSTED
             * @example MAX_ATTEMPTS
             * @example ASSESSMENT_PUBLISHED
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
        QuestionAuthorView: {
            marks?: number;
            payload?: Record<string, never>;
            prompt?: string;
            /** Format: uuid */
            question_id?: string;
            stats?: {
                attempts?: number;
                correct?: number;
                difficulty_index?: number | null;
            } | null;
            type?: string;
            version?: number;
        };
        QuestionInput: {
            /** Format: uuid */
            bank_id?: string | null;
            /**
             * @default medium
             * @enum {string}
             */
            difficulty: "easy" | "medium" | "hard";
            /** @default 1 */
            marks: number;
            /** @default 0 */
            negative_marks: number;
            /** @description mcq / multiple_answer: options[{id, text, correct}] (+ partial_credit); true_false: {correct}; fill_blank: {accepted[], case_sensitive}; descriptive: {rubric, max_words}; coding: {languages[], starter_code{}, tests[{input, expected, hidden, weight}], reference_solution{language, code} (required to publish), checker, limits}. */
            payload: Record<string, never>;
            prompt: string;
            skill_ids?: string[];
            /** Format: uuid */
            tenant_id?: string;
            /** @enum {string} */
            type: "mcq" | "multiple_answer" | "true_false" | "fill_blank" | "descriptive" | "coding";
        };
    };
    responses: {
        /** @description The assessment version. */
        AssessmentWithETag: {
            headers: {
                ETag?: string;
                [name: string]: unknown;
            };
            content: {
                "application/json": Record<string, never>;
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
        /** @description The candidate's view of its session (assessment-runner RunnerSession). */
        RunnerSession: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": {
                    current_section?: number;
                    /** Format: date-time */
                    deadline_at?: string | null;
                    /** @enum {string} */
                    navigation?: "fixed_section_order" | "section_switch";
                    question_count?: number;
                    remaining_seconds?: number | null;
                    /** Format: date-time */
                    server_time?: string;
                    /** Format: uuid */
                    session_id?: string;
                    status?: string;
                    title?: string;
                };
            };
        };
    };
    parameters: {
        AssessmentId: string;
        IfMatch: string;
        SessionId: string;
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
    listAssessments: {
        parameters: {
            query?: {
                limit?: number;
                status?: "draft" | "published" | "inactive" | "archived";
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Assessments. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createAssessment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssessmentInput"];
            };
        };
        responses: {
            201: components["responses"]["AssessmentWithETag"];
            400: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    getAssessment: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
                version?: number;
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AssessmentWithETag"];
            404: components["responses"]["Problem"];
        };
    };
    updateDraft: {
        parameters: {
            query?: never;
            header: {
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AssessmentInput"];
            };
        };
        responses: {
            200: components["responses"]["AssessmentWithETag"];
            412: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    cloneAssessment: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            201: components["responses"]["AssessmentWithETag"];
            404: components["responses"]["Problem"];
        };
    };
    newAssessmentVersion: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            201: components["responses"]["AssessmentWithETag"];
            422: components["responses"]["Problem"];
        };
    };
    publishAssessment: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["AssessmentWithETag"];
            422: components["responses"]["Problem"];
        };
    };
    setAssessmentStatus: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
                version?: number;
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    status: "published" | "inactive" | "archived";
                };
            };
        };
        responses: {
            200: components["responses"]["AssessmentWithETag"];
            422: components["responses"]["Problem"];
        };
    };
    listInviteLinks: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Invites. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createInviteLink: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    candidate_id?: string | null;
                    /** Format: date-time */
                    expires_at?: string | null;
                    /** @enum {string} */
                    kind: "open" | "targeted";
                    max_uses?: number | null;
                };
            };
        };
        responses: {
            /** @description The invite, its token and URL. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            422: components["responses"]["Problem"];
        };
    };
    listSessions: {
        parameters: {
            query?: {
                band?: string;
                candidate_status?: "pending" | "shortlisted" | "on_hold" | "rejected";
                limit?: number;
                min_percent?: number;
                review_status?: string;
                status?: string;
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                assessmentId: components["parameters"]["AssessmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sessions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    revokeInviteLink: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                inviteId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    redeemInvite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                token: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: email */
                    email?: string;
                    full_name?: string;
                };
            };
        };
        responses: {
            /** @description The session and its token (shown once). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        assessment?: Record<string, never>;
                        /** Format: uuid */
                        session_id?: string;
                        session_token?: string;
                    };
                };
            };
            404: components["responses"]["Problem"];
            /** @description SESSION_EXISTS or INVITE_EXHAUSTED. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description DETAILS_REQUIRED, MAX_ATTEMPTS, RETAKE_COOLDOWN or ASSESSMENT_UNAVAILABLE. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createQuestionBank: {
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
                    skill_ids?: string[];
                    /** Format: uuid */
                    tenant_id?: string;
                };
            };
        };
        responses: {
            /** @description The bank. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Problem"];
        };
    };
    listQuestions: {
        parameters: {
            query?: {
                bank_id?: string;
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
            /** @description Questions with item statistics. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createQuestion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QuestionInput"];
            };
        };
        responses: {
            /** @description The question, with its answer key (authors only). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuestionAuthorView"];
                };
            };
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    getQuestion: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
                version?: number;
            };
            header?: never;
            path: {
                questionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The question. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QuestionAuthorView"];
                };
            };
            404: components["responses"]["Problem"];
        };
    };
    reviseQuestion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                questionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QuestionInput"];
            };
        };
        responses: {
            /** @description The new version. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    retireQuestion: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                questionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Retired. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    getRunnerSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RunnerSession"];
            401: components["responses"]["Problem"];
        };
    };
    heartbeat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RunnerSession"];
        };
    };
    reviewSession: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comment?: string | null;
                    scores: {
                        [key: string]: number;
                    };
                };
            };
        };
        responses: {
            /** @description {released, pending_reviewers, status} */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    startSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RunnerSession"];
            409: components["responses"]["Problem"];
        };
    };
    submitSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["RunnerSession"];
            409: components["responses"]["Problem"];
        };
    };
    setCandidateStatus: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header: {
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    status: "pending" | "shortlisted" | "on_hold" | "rejected";
                };
            };
        };
        responses: {
            /** @description The session result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            412: components["responses"]["Problem"];
            428: components["responses"]["Problem"];
        };
    };
    sessionEvents: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server-sent events. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            401: components["responses"]["Problem"];
        };
    };
    getQuestionForCandidate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                n: number;
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The question (assessment-runner RunnerQuestion). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description SESSION_EXPIRED, SESSION_ENDED, SESSION_NOT_STARTED or SECTION_LOCKED. */
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
    runCode: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                questionId: string;
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    code: string;
                    language: string;
                    stdin?: string | null;
                };
            };
        };
        responses: {
            /** @description {run_id} */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description SESSION_EXPIRED, SESSION_ENDED or SECTION_LOCKED. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description NOT_A_CODING_QUESTION, LANGUAGE_NOT_ALLOWED, LANGUAGE_DISABLED or BUNDLE_NOT_FOUND. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description RUN_THROTTLED (Retry-After) or the per-session request limit. */
            429: {
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
    submitCode: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                questionId: string;
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    code: string;
                    language: string;
                };
            };
        };
        responses: {
            /** @description {submission_id, status: queued} */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description SESSION_EXPIRED or SESSION_ENDED. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description NOT_A_CODING_QUESTION, LANGUAGE_NOT_ALLOWED or BUNDLE_NOT_VERIFIED. */
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
    saveResponse: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                questionId: string;
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    answer: unknown;
                    client_rev: number;
                };
            };
        };
        responses: {
            /** @description Saved (assessment-runner SaveResponseResult). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Problem"];
            /** @description STALE_REVISION (with client_rev), SESSION_EXPIRED or SECTION_LOCKED. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            429: components["responses"]["Problem"];
        };
    };
    getSessionResult: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    assignReviewers: {
        parameters: {
            query?: {
                /** @description Platform principals only; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reviewer_ids: string[];
                };
            };
        };
        responses: {
            /** @description Assigned. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            422: components["responses"]["Problem"];
        };
    };
    getRun: {
        parameters: {
            query?: {
                wait?: number;
            };
            header?: never;
            path: {
                runId: string;
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The run (sandbox-svc Run: status, stdout, stderr, compile_output, cases). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    getCodeSubmission: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
                submissionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The submission (sandbox-svc candidate view). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
}
