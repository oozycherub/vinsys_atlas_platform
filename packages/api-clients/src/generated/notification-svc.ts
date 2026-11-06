/* eslint-disable */
// Generated from services/notification-svc/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.

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
    "/v1/internal/link-messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** identity-svc's invitation and magic-link emails (service, scope notifications:send). */
        post: operations["sendLinkMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Messages to people who are not users, e.g. a candidate's assessment invitation. */
        post: operations["sendMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/internal/recipients/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Directory updates from other services (display name, locale, time zone, tags such as hrbp). */
        put: operations["upsertRecipient"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/notification-preferences/{type}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** The caller's own opt-out for a type or channel (not for transactional types). */
        put: operations["setOwnPreference"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's own in-app notifications, newest first, with the unread count. */
        get: operations["listMyNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/notifications:markAllRead": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Marks all of the caller's notifications read. */
        post: operations["markAllNotificationsRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/notifications:stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Server-sent events: `notification` (id = resume cursor; send it back as Last-Event-ID), `unread` counts, and a comment heartbeat every 15 s. */
        get: operations["streamMyNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/notifications/{id}:markRead": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Marks one of the caller's notifications read. */
        post: operations["markNotificationRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notification-preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The tenant's per-type toggles (tenant_admin). */
        get: operations["listPreferences"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notification-preferences/{type}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Turns a type, or one of its channels, on or off for the tenant. Transactional types are refused (422). */
        put: operations["setPreference"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notification-settings": {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Quiet hours, time zone, daily cap and sender name (tenant_admin). */
        get: operations["getSettings"];
        /** Replaces the settings. Quiet hours and the cap defer non-transactional email; they never drop it. */
        put: operations["putSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notification-templates": {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The tenant's templates (tenant_admin). Types without one use the built-in template. */
        get: operations["listTemplates"];
        put?: never;
        /** Adds a template (tenant_admin). Unknown placeholders, `{{…}}`, scripts, event handlers, javascript: URLs and invalid MJML are rejected; {URL} may only be an href. */
        post: operations["createTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notification-templates:preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Validates and renders with sample or given values; nothing is stored or sent. */
        post: operations["previewTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notification-templates/{id}": {
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
        /** One template. */
        get: operations["getTemplate"];
        /** Replaces subject and source (validated as on create); the version increases. */
        put: operations["updateTemplate"];
        post?: never;
        /** Deletes it; the built-in template applies again. */
        delete: operations["deleteTemplate"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notification-types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Types with their placeholder allowlists, channels and whether they are transactional. */
        get: operations["listNotificationTypes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/reminders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Scheduled and past reminders (tenant_admin, hiring_manager). */
        get: operations["listReminders"];
        put?: never;
        /** Schedules a self-rating or manager-rating reminder (tenant_admin, hiring_manager, service). */
        post: operations["scheduleReminder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/reminders/{id}:cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancels a scheduled reminder (422 once sent). */
        post: operations["cancelReminder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sending-domains": {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Sending domains with their DNS records and verification state. */
        get: operations["listDomains"];
        put?: never;
        /** Registers a domain; the response lists the TXT (ownership, SPF) and DKIM CNAME records to publish. */
        post: operations["addDomain"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sending-domains/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Removes a domain. */
        delete: operations["deleteDomain"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/sending-domains/{id}:verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Looks the records up in DNS; verified domains become the sender. */
        post: operations["verifyDomain"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-deliveries/{id}:redeliver": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Moves a dead delivery back to the queue with fresh attempts. */
        post: operations["redeliverWebhook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-endpoints": {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The tenant's endpoints (tenant_admin). Secrets are never returned again. */
        get: operations["listWebhookEndpoints"];
        put?: never;
        /** Adds an https endpoint on a public host; the response carries its signing secret, once. */
        post: operations["createWebhookEndpoint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-endpoints/{id}": {
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
        /** One endpoint with its failure count and disabled state. */
        get: operations["getWebhookEndpoint"];
        put?: never;
        post?: never;
        /** Deletes the endpoint and its deliveries. */
        delete: operations["deleteWebhookEndpoint"];
        options?: never;
        head?: never;
        /** Changes the URL, description or subscribed event types. */
        patch: operations["updateWebhookEndpoint"];
        trace?: never;
    };
    "/v1/webhook-endpoints/{id}:enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Re-enables an endpoint disabled after 50 consecutive failures; pending deliveries resume. */
        post: operations["enableWebhookEndpoint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-endpoints/{id}:test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sends a signed `ping` now and returns the response status (not stored or counted). */
        post: operations["testWebhookEndpoint"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/webhook-endpoints/{id}/deliveries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recent deliveries; `status=dead` is the dead-letter queue. */
        get: operations["listWebhookDeliveries"];
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
        EventType: "assessment.session.submitted" | "assessment.session.terminated" | "assessment.session.evaluated" | "proctoring.session.finalized" | "interview.session.completed" | "report.artifact.ready";
    };
    responses: {
        401: {
            headers: {
                [name: string]: unknown;
            };
            content?: never;
        };
        /** @description Accepted for delivery (a replay with the same key returns the same body). */
        Accepted: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": {
                    notification_ids?: string[];
                    /** @enum {string} */
                    status?: "accepted";
                };
            };
        };
        /** @description OK */
        Items: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": {
                    items?: Record<string, never>[];
                };
            };
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
    };
    parameters: {
        Id: string;
        /** @description 8–128 characters of [A-Za-z0-9_.:-]; reuse it when retrying the same request. */
        IdempotencyKey: string;
        /** @description Required for platform staff; tenant users act on their own tenant. */
        TenantId: string;
        Type: string;
    };
    requestBodies: {
        Preference: {
            content: {
                "application/json": {
                    /** @default true */
                    email?: boolean;
                    enabled: boolean;
                    /** @default true */
                    in_app?: boolean;
                };
            };
        };
    };
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
    sendLinkMessage: {
        parameters: {
            query?: never;
            header: {
                /** @description 8–128 characters of [A-Za-z0-9_.:-]; reuse it when retrying the same request. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                    /** Format: date-time */
                    expires_at: string;
                    /** @enum {string} */
                    kind: "invitation" | "magic_link";
                    /** Format: uuid */
                    tenant_id: string;
                    /**
                     * Format: uri
                     * @description https only; a bearer secret.
                     */
                    url: string;
                };
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            422: components["responses"]["Problem"];
        };
    };
    sendMessage: {
        parameters: {
            query?: never;
            header: {
                /** @description 8–128 characters of [A-Za-z0-9_.:-]; reuse it when retrying the same request. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: email */
                    email: string;
                    /** Format: date-time */
                    expires_at?: string | null;
                    /**
                     * Format: uuid
                     * @description The candidate it is about (erasure removes it).
                     */
                    subject_id?: string | null;
                    /** Format: uuid */
                    tenant_id: string;
                    /** @enum {string} */
                    type: "candidate_assessment_invitation";
                    /** Format: uri */
                    url?: string | null;
                    /** @description Placeholder values (the type's allowlist, without URL and Expires_At). */
                    values?: {
                        [key: string]: string;
                    };
                };
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
        };
    };
    upsertRecipient: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                userId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    active?: boolean;
                    display_name?: string | null;
                    /** Format: email */
                    email?: string | null;
                    locale?: string;
                    roles?: string[];
                    tags?: string[];
                    /** Format: uuid */
                    tenant_id: string;
                    time_zone?: string | null;
                };
            };
        };
        responses: {
            200: components["responses"]["Object"];
            403: components["responses"]["Problem"];
        };
    };
    setOwnPreference: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                type: components["parameters"]["Type"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["Preference"];
        responses: {
            200: components["responses"]["Object"];
            422: components["responses"]["Problem"];
        };
    };
    listMyNotifications: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                unread_only?: boolean;
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
    markAllNotificationsRead: {
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
        };
    };
    streamMyNotifications: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description An event stream. */
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
    markNotificationRead: {
        parameters: {
            query?: never;
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
    listPreferences: {
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
            200: components["responses"]["Items"];
            401: components["responses"]["Problem"];
        };
    };
    setPreference: {
        parameters: {
            query?: {
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path: {
                type: components["parameters"]["Type"];
            };
            cookie?: never;
        };
        requestBody: components["requestBodies"]["Preference"];
        responses: {
            200: components["responses"]["Object"];
            422: components["responses"]["Problem"];
        };
    };
    getSettings: {
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
    putSettings: {
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
                    from_name?: string | null;
                    /** @default 5 */
                    max_per_day?: number;
                    quiet_hours?: {
                        end?: string;
                        start?: string;
                    } | null;
                    /** @default UTC */
                    time_zone?: string;
                };
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
        };
    };
    listTemplates: {
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
            200: components["responses"]["Items"];
            403: components["responses"]["Problem"];
        };
    };
    createTemplate: {
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
                    /** @enum {string} */
                    channel: "email" | "in_app";
                    /** @default en */
                    locale?: string;
                    /** @description MJML (email) or plain text (in_app). */
                    source: string;
                    subject: string;
                    /** Format: uuid */
                    tenant_id?: string;
                    type: string;
                };
            };
        };
        responses: {
            201: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            403: components["responses"]["Problem"];
            409: components["responses"]["Problem"];
        };
    };
    previewTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    channel: "email" | "in_app";
                    source?: string;
                    subject?: string;
                    type: string;
                    values?: {
                        [key: string]: string;
                    };
                };
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
        };
    };
    getTemplate: {
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
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    updateTemplate: {
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
        requestBody: {
            content: {
                "application/json": {
                    source: string;
                    subject: string;
                };
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
            404: components["responses"]["Problem"];
        };
    };
    deleteTemplate: {
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
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    listNotificationTypes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Items"];
            401: components["responses"]["Problem"];
        };
    };
    listReminders: {
        parameters: {
            query?: {
                status?: "scheduled" | "sent" | "cancelled";
                /** @description Required for platform staff; tenant users act on their own tenant. */
                tenant_id?: components["parameters"]["TenantId"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            200: components["responses"]["Items"];
            401: components["responses"]["Problem"];
        };
    };
    scheduleReminder: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: date-time */
                    due_at: string;
                    recipient_user_id: string;
                    /** Format: uuid */
                    tenant_id?: string;
                    /** @enum {string} */
                    type: "self_rating_reminder" | "manager_rating_reminder";
                    values?: {
                        [key: string]: string;
                    };
                };
            };
        };
        responses: {
            201: components["responses"]["Object"];
            400: components["responses"]["Problem"];
        };
    };
    cancelReminder: {
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
            200: components["responses"]["Object"];
            422: components["responses"]["Problem"];
        };
    };
    listDomains: {
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
            200: components["responses"]["Items"];
            401: components["responses"]["Problem"];
        };
    };
    addDomain: {
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
                    domain: string;
                    /** Format: uuid */
                    tenant_id?: string;
                };
            };
        };
        responses: {
            201: components["responses"]["Object"];
            409: components["responses"]["Problem"];
        };
    };
    deleteDomain: {
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
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["Problem"];
        };
    };
    verifyDomain: {
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
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    redeliverWebhook: {
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
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
        };
    };
    listWebhookEndpoints: {
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
            200: components["responses"]["Items"];
            401: components["responses"]["Problem"];
        };
    };
    createWebhookEndpoint: {
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
                    description?: string | null;
                    event_types: components["schemas"]["EventType"][];
                    /** Format: uuid */
                    tenant_id?: string;
                    /** Format: uri */
                    url: string;
                };
            };
        };
        responses: {
            201: components["responses"]["Object"];
            400: components["responses"]["Problem"];
        };
    };
    getWebhookEndpoint: {
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
            200: components["responses"]["Object"];
            404: components["responses"]["Problem"];
        };
    };
    deleteWebhookEndpoint: {
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
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Problem"];
        };
    };
    updateWebhookEndpoint: {
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
        requestBody: {
            content: {
                "application/json": {
                    description?: string | null;
                    event_types?: components["schemas"]["EventType"][];
                    /** Format: uri */
                    url?: string;
                };
            };
        };
        responses: {
            200: components["responses"]["Object"];
            400: components["responses"]["Problem"];
        };
    };
    enableWebhookEndpoint: {
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
            200: components["responses"]["Object"];
            401: components["responses"]["Problem"];
        };
    };
    testWebhookEndpoint: {
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
            200: components["responses"]["Object"];
            401: components["responses"]["Problem"];
        };
    };
    listWebhookDeliveries: {
        parameters: {
            query?: {
                status?: "pending" | "delivered" | "dead";
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
            200: components["responses"]["Items"];
            401: components["responses"]["Problem"];
        };
    };
}
