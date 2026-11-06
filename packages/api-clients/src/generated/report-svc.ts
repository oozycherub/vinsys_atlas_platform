/* eslint-disable */
// Generated from services/report-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

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
        /** Readiness (database reachable). */
        get: operations["readyz"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/report-artifacts/{id}:download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Streams the file. Authorised by the signed query string only. */
        get: operations["downloadArtifact"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/report-gallery": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The lakehouse reports and their parameters (tenant_admin, hiring_manager). */
        get: operations["listGallery"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/report-settings": {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The candidate report's sections and which are on (staff). */
        get: operations["getReportSettings"];
        /** Turns optional sections on or off (tenant_admin). Mandatory sections cannot be turned off. */
        put: operations["putReportSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/reports": {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's reports (tenant admins see all of the tenant's). */
        get: operations["listReports"];
        put?: never;
        /** Queues a report. */
        post: operations["requestReport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/reports/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The job's status and, when ready, a fresh signed link (15 minutes). */
        get: operations["getReport"];
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
    schemas: never;
    responses: {
        401: {
            headers: {
                [name: string]: unknown;
            };
            content?: never;
        };
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
        /** @description A report job. */
        Report: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": {
                    /** Format: date-time */
                    created_at?: string;
                    download?: {
                        content_type?: string;
                        /** Format: date-time */
                        expires_at?: string;
                        file_name?: string;
                        size_bytes?: number;
                        /** Format: uri */
                        url?: string;
                    } | null;
                    error?: string | null;
                    /** Format: date-time */
                    finished_at?: string | null;
                    params?: Record<string, never>;
                    /** Format: uuid */
                    report_id?: string;
                    requested_by?: string;
                    /** @enum {string} */
                    status?: "queued" | "running" | "ready" | "failed";
                    type?: string;
                };
            };
        };
    };
    parameters: {
        Id: string;
        /** @description Required for platform staff; tenant users act on their own tenant. */
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
            401: components["responses"]["Problem"];
            503: components["responses"]["Problem"];
        };
    };
    downloadArtifact: {
        parameters: {
            query: {
                exp: number;
                sig: string;
                tenant_id: string;
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The file. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/pdf": string;
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": string;
                };
            };
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    listGallery: {
        parameters: {
            query?: never;
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
    getReportSettings: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
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
    putReportSettings: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    sections: {
                        enabled: boolean;
                        /** @enum {string} */
                        key: "summary" | "skill_scores" | "integrity" | "proctoring_evidence" | "ai_interview";
                    }[];
                };
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    listReports: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Object"];
            401: components["responses"]["Problem"];
        };
    };
    requestReport: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    params: {
                        /** @description Narrows the optional sections; cannot add disabled ones. */
                        sections?: string[];
                        /** Format: uuid */
                        session_id: string;
                    };
                    /** @constant */
                    type: "candidate_assessment_pdf";
                } | {
                    params: {
                        /** Format: uuid */
                        assessment_id: string;
                    };
                    /** @constant */
                    type: "assessment_results_xlsx";
                } | {
                    params: {
                        report: string;
                        /** @description The report's declared parameters (dates as YYYY-MM-DD). */
                        values?: Record<string, never>;
                    };
                    /** @constant */
                    type: "gallery_xlsx";
                };
            };
        };
        responses: {
            202: components["responses"]["Report"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    getReport: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
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
            200: components["responses"]["Report"];
            404: components["responses"]["Problem"];
        };
    };
}
