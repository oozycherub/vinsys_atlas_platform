import { TENANT_ROLES } from '@atlas/contracts';
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from '../domain/webhooks';

const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });
const email = z.string().trim().email().max(320);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const values = z
  .record(z.string().max(2000))
  .refine((v) => Object.keys(v).length <= 30, 'at most 30 values');

export const tenantQuery = z.object({ tenant_id: uuid.optional() }).passthrough();

export const linkMessageBody = z
  .object({
    kind: z.enum(['invitation', 'magic_link']),
    tenant_id: uuid,
    email,
    url: z.string().url().max(4000),
    expires_at: isoTime,
  })
  .strict();

export const messageBody = z
  .object({
    type: z.enum(['candidate_assessment_invitation']),
    tenant_id: uuid,
    email,
    subject_id: uuid.nullable().default(null),
    url: z.string().url().max(4000).nullable().default(null),
    expires_at: isoTime.nullable().default(null),
    values: values.default({}),
  })
  .strict();

export const recipientBody = z
  .object({
    tenant_id: uuid,
    email: email.nullable().optional(),
    display_name: z.string().trim().max(200).nullable().optional(),
    roles: z.array(z.enum(TENANT_ROLES)).max(10).optional(),
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/))
      .max(20)
      .optional(),
    locale: locale.optional(),
    time_zone: z.string().max(64).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const templateBody = z
  .object({
    tenant_id: uuid.optional(),
    type: z.string().max(100),
    channel: z.enum(['email', 'in_app']),
    locale: locale.default('en'),
    subject: z.string().min(1).max(300),
    source: z.string().min(1).max(100_000),
  })
  .strict();

export const templateUpdateBody = z
  .object({ subject: z.string().min(1).max(300), source: z.string().min(1).max(100_000) })
  .strict();

export const previewBody = z
  .object({
    type: z.string().max(100),
    channel: z.enum(['email', 'in_app']),
    subject: z.string().min(1).max(300).optional(),
    source: z.string().min(1).max(100_000).optional(),
    values: values.optional(),
  })
  .strict();

export const preferenceBody = z
  .object({
    enabled: z.boolean(),
    email: z.boolean().default(true),
    in_app: z.boolean().default(true),
  })
  .strict();

export const settingsBody = z
  .object({
    quiet_hours: z.object({ start: hhmm, end: hhmm }).strict().nullable().default(null),
    time_zone: z.string().min(1).max(64).default('UTC'),
    max_per_day: z.number().int().min(1).max(100).default(5),
    from_name: z.string().trim().min(1).max(100).nullable().default(null),
  })
  .strict();

export const domainBody = z
  .object({
    tenant_id: uuid.optional(),
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a domain name'),
  })
  .strict();

export const reminderBody = z
  .object({
    tenant_id: uuid.optional(),
    type: z.enum(['self_rating_reminder', 'manager_rating_reminder']),
    recipient_user_id: z.string().min(1).max(200),
    due_at: isoTime,
    values: values.default({}),
  })
  .strict();

export const remindersQuery = z
  .object({
    tenant_id: uuid.optional(),
    status: z.enum(['scheduled', 'sent', 'cancelled']).optional(),
  })
  .strict();

export const endpointBody = z
  .object({
    tenant_id: uuid.optional(),
    url: z.string().max(2000),
    description: z.string().trim().max(500).nullable().default(null),
    event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
  })
  .strict();

export const endpointPatchBody = z
  .object({
    url: z.string().max(2000).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    event_types: z
      .array(z.enum(WEBHOOK_EVENT_TYPES))
      .min(1)
      .max(WEBHOOK_EVENT_TYPES.length)
      .optional(),
  })
  .strict();

export const deliveriesQuery = z
  .object({
    tenant_id: uuid.optional(),
    status: z.enum(['pending', 'delivered', 'dead']).optional(),
  })
  .strict();

export const inboxQuery = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    unread_only: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .strict();
