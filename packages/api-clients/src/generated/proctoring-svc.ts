/* eslint-disable */
// Generated from services/proctoring-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

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
    "/v1/proctoring/flags/{flagId}:review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** A human decision on a flag (tenant_admin, recruiter, reviewer). Dismissed flags leave the Trust Score; a finalised session is re-finalised (revision + 1). One decision per flag. */
        post: operations["reviewFlag"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/proctoring/frames/{frameId}:inference": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** cv-inference (scope proctoring:inference): one frame's or audio window's analysis. A second result for the same frame is ignored. The face embedding is compared with the session's encrypted references here and never stored for frames. */
        post: operations["postInference"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/proctoring/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Start or resume proctoring (scope proctoring:sessions; called by assessment-svc). A resume issues a new token and key epoch; next_seq and prev_hash continue the chain. */
        put: operations["startProctoring"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/proctoring/sessions/{sessionId}/accommodations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Accessibility accommodations (tenant_admin, recruiter): disable named rules for one session, before or during it, with a reason. Every grant is written to the audit log. */
        put: operations["accommodate"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/proctoring/sessions/{sessionId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Candidate SDK: a batch of signed, hash-chained events (gzip allowed). MACs and the chain are verified, (session, seq) is de-duplicated, client time is corrected with the median offset. Forged or broken events become tamper_suspected evidence. */
        post: operations["ingestEvents"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/proctoring/sessions/{sessionId}/frames:initiateUpload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Candidate SDK: a presigned POST for a frame, reference image or audio window (size and type enforced by the policy). The upload counts once a signed `frame` event names it. */
        post: operations["initiateUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/proctoring/sessions/{sessionId}/timeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Evidence timeline (tenant_admin, recruiter, hiring_manager, reviewer): log rows with signed frame URLs (15 min), review decisions, the Trust Score breakdown and whether the server-side hash chain verifies. */
        get: operations["getTimeline"];
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
        /** @description Signed event. mac = hex(HMAC-SHA256(session_key[key_epoch], canonical JSON without mac)); prev_hash = hex(sha256(canonical JSON of the previous envelope, mac included)). Canonical JSON: keys sorted by UTF-16 code units, no whitespace, JSON.stringify primitives (ADR-0007). */
        Envelope: {
            client_ts: number;
            key_epoch: number;
            mac: string;
            payload: Record<string, never>;
            prev_hash: string;
            seq: number;
            /** Format: uuid */
            session_id: string;
            /** @enum {string} */
            type: "tab_hidden" | "fullscreen_exit" | "paste" | "copy" | "cut" | "context_menu" | "multi_monitor" | "face_count" | "frame" | "voice_activity" | "heartbeat" | "automation_suspected" | "network_offline" | "device_lost" | "keystroke_summary";
        };
        Problem: {
            code: string;
            detail: string;
            instance: string;
            request_id?: string;
            status: number;
            title: string;
            /** Format: uri */
            type: string;
        };
        /** @description The assessment's proctoring rules (PRD §2.3b); defaults apply when omitted. */
        Rules: {
            audio?: {
                multiple_speakers_min_s?: number;
            };
            image?: {
                consecutive_frames_per_violation?: number;
                flags?: ("no_face" | "multiple_faces" | "face_mismatch" | "phone" | "second_person")[];
                terminate_after_warnings?: number;
            };
            safe_browser?: boolean;
            window_violation?: {
                bands?: {
                    green_max_ms?: number;
                    yellow_max_ms?: number;
                };
                enabled?: boolean;
                terminate_after_count?: number;
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
    };
    parameters: {
        SessionId: string;
        /** @description Required for service and platform principals; tenant users act on their own tenant. */
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
    reviewFlag: {
        parameters: {
            query?: {
                /** @description Required for service and platform principals; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                flagId: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    comment?: string | null;
                    /** @enum {string} */
                    decision: "confirmed" | "dismissed";
                };
            };
        };
        responses: {
            /** @description The decision. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
            /** @description ALREADY_REVIEWED. */
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
    postInference: {
        parameters: {
            query?: {
                /** @description Required for service and platform principals; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                frameId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    audio?: {
                        speakers?: number;
                        speech_s?: number;
                        window_s?: number;
                    };
                    embedding?: number[];
                    /** @enum {string} */
                    error?: "object_missing" | "undecodable";
                    faces?: number;
                    head_pose?: {
                        pitch?: number;
                        roll?: number;
                        yaw?: number;
                    };
                    model_versions?: {
                        [key: string]: string;
                    };
                    objects?: {
                        label?: string;
                        score?: number;
                    }[];
                    phash?: string;
                    quality?: {
                        blur_variance?: number;
                        luminance?: number;
                    };
                };
            };
        };
        responses: {
            /** @description Applied. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    startProctoring: {
        parameters: {
            query?: {
                /** @description Required for service and platform principals; tenant users act on their own tenant. */
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
                    /** Format: uuid */
                    assessment_id: string;
                    /** Format: uuid */
                    candidate_id: string;
                    /** @description Biometric consent (required when frames are analysed). */
                    consent: {
                        biometrics?: boolean;
                        /** Format: date-time */
                        granted_at?: string;
                        version?: string;
                    };
                    /** @default false */
                    id_verification?: boolean;
                    rules?: components["schemas"]["Rules"];
                };
            };
        };
        responses: {
            /** @description The proctor token and session key (shown once; the SDK keeps them in memory). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        disabled_rules?: string[];
                        key_epoch?: number;
                        next_seq?: number;
                        prev_hash?: string;
                        proctor_token?: string;
                        references_required?: ("selfie" | "id_document")[];
                        rules?: components["schemas"]["Rules"];
                        /** Format: date-time */
                        server_time?: string;
                        /** @description base64, 32 bytes */
                        session_key?: string;
                    };
                };
            };
            403: components["responses"]["Problem"];
            /** @description PROCTORING_FINALIZED. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description CONSENT_REQUIRED or INVALID_RULES. */
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
    accommodate: {
        parameters: {
            query?: {
                /** @description Required for service and platform principals; tenant users act on their own tenant. */
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
                    disabled_rules: ("window_violation" | "fullscreen" | "paste" | "multi_monitor" | "audio" | "no_face" | "multiple_faces" | "face_mismatch" | "phone" | "second_person")[];
                    reason: string;
                };
            };
        };
        responses: {
            /** @description The accommodation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Problem"];
            /** @description INVALID_ACCOMMODATION. */
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
    ingestEvents: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    events: components["schemas"]["Envelope"][];
                    /** @description Client clock (ms) when sent; a clock sample. */
                    sent_at?: number;
                };
            };
        };
        responses: {
            /** @description Counts, a rotated key when due, and notices for the candidate. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        accepted?: number;
                        duplicates?: number;
                        key_epoch?: number;
                        last_seq?: number;
                        /** @description base64; present when the key rotated (every 15 min) */
                        next_key?: string;
                        notices?: {
                            /** @enum {string} */
                            action?: "flag" | "review" | "terminate";
                            rule?: string;
                            severity?: number;
                        }[];
                        rejected?: number;
                        /** Format: date-time */
                        server_time?: string;
                    };
                };
            };
            400: components["responses"]["Problem"];
            401: components["responses"]["Problem"];
            /** @description PROCTORING_FINALIZED. */
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
    initiateUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["parameters"]["SessionId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    content_type: "image/jpeg" | "audio/webm" | "audio/ogg";
                    /** @enum {string} */
                    kind: "frame" | "selfie" | "id_document" | "audio";
                    /** @description Captured because MediaPipe saw 0 or ≥ 2 faces. */
                    triggered?: boolean;
                };
            };
        };
        responses: {
            /** @description The frame id and the presigned upload. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        frame_id?: string;
                        upload?: {
                            /** Format: date-time */
                            expires_at?: string;
                            fields?: {
                                [key: string]: string;
                            };
                            url?: string;
                        };
                    };
                };
            };
            /** @description PROCTORING_FINALIZED or REFERENCES_COMPLETE. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description UNSUPPORTED_UPLOAD. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description UPLOAD_LIMIT (2,000 per session). */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getTimeline: {
        parameters: {
            query?: {
                /** @description Required for service and platform principals; tenant users act on their own tenant. */
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
            /** @description The timeline. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        band?: "green" | "yellow" | "red";
                        breakdown?: {
                            [key: string]: number;
                        };
                        chain_valid?: boolean;
                        disabled_rules?: string[];
                        entries?: {
                            event_type?: string;
                            frame_url?: string;
                            log_id?: number;
                            /** Format: date-time */
                            occurred_at?: string;
                            payload?: Record<string, never>;
                            review?: Record<string, never>;
                            seq?: number;
                            severity?: number;
                            source?: string;
                        }[];
                        reference_status?: string;
                        revision?: number;
                        /** Format: uuid */
                        session_id?: string;
                        /** @enum {string} */
                        status?: "active" | "finalized";
                        trust_score?: number;
                    };
                };
            };
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
}
