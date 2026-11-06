import { z } from 'zod';
import { defineEvent } from './event';

/**
 * notification-svc and report-svc events (docs/prompts/13-notification-report.md §5, ADR-0010).
 * No addresses, no links and no message bodies: ids and outcomes only.
 */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

export const NOTIFICATION_CHANNELS = ['email', 'in_app', 'webhook'] as const;

/** A send gave up after its retries (or was refused permanently by the provider). */
export const NotificationDeliveryFailed = defineEvent(
  'notification.delivery.failed.v1',
  'notification',
  z.object({
    tenant_id: uuid,
    notification_id: uuid,
    channel: z.enum(NOTIFICATION_CHANNELS),
    type: z.string().min(1).max(100),
    /** user id of the recipient when known; webhook deliveries name the endpoint instead. */
    recipient_user_id: z.string().max(200).nullable(),
    endpoint_id: uuid.nullable(),
    reason: z.enum(['permanent', 'retries_exhausted', 'endpoint_disabled']),
    attempts: z.number().int().min(1),
    occurred_at: isoTime,
  }),
);

export const REPORT_TYPES = [
  'candidate_assessment_pdf',
  'assessment_results_xlsx',
  'gallery_xlsx',
] as const;

/** A requested report finished. Consumers fetch the link from report-svc; it is not on the event. */
export const ReportArtifactReady = defineEvent(
  'report.artifact.ready.v1',
  'report',
  z.object({
    tenant_id: uuid,
    report_id: uuid,
    artifact_id: uuid,
    type: z.enum(REPORT_TYPES),
    requested_by: z.string().min(1).max(200),
    content_type: z.string().max(200),
    size_bytes: z.number().int().min(0),
    occurred_at: isoTime,
  }),
);
