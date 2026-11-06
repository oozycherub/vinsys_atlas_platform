import { OPPORTUNITY_TYPES } from '@atlas/contracts';
import { z } from 'zod';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date (YYYY-MM-DD)');
const text = (max: number) => z.string().trim().min(1).max(max);

export const tenantQuery = z.object({ tenant_id: uuid.optional() }).passthrough();

const requirement = z
  .object({
    skill_id: uuid,
    weight: z.number().gt(0).lte(1),
    target_proficiency: z.number().min(0).max(5),
    must_have: z.boolean().default(false),
  })
  .strict();

export const employeeBody = z
  .object({
    user_id: z.string().max(200).nullable().default(null),
    manager_user_id: z.string().max(200).nullable().default(null),
    department: z.string().max(200).nullable().default(null),
    location: z.string().max(200).nullable().default(null),
    job_profile_id: uuid.nullable().default(null),
    hired_at: date.nullable().default(null),
    role_started_at: date.nullable().default(null),
    last_promotion_at: date.nullable().default(null),
    manager_changed_at: date.nullable().default(null),
    compa_ratio: z.number().min(0).max(3).nullable().default(null),
    engagement_delta: z.number().min(-10).max(10).nullable().default(null),
    overtime_hours_4w: z.number().min(0).max(1000).nullable().default(null),
    marketplace_opt_in: z.boolean().default(false),
    status: z.enum(['active', 'terminated']).default('active'),
    terminated_at: date.nullable().default(null),
    termination_voluntary: z.boolean().nullable().default(null),
    source_synced_at: z.string().datetime({ offset: true }).nullable().default(null),
    /** Fairness-audit attributes (never model features); readable by the attrition audit only. */
    protected_attributes: z.record(z.string().max(100)).nullable().default(null),
  })
  .strict()
  .refine((e) => e.status === 'active' || e.terminated_at !== null, {
    message: 'terminated_at is required for a terminated employee',
    path: ['terminated_at'],
  });

export const bulkEmployeesBody = z
  .object({
    employees: z
      .array(z.object({ employee_id: uuid }).passthrough())
      .min(1)
      .max(500),
  })
  .strict();

export const policyBody = z
  .object({
    applications_visible_to_manager: z.boolean(),
    learning_hours_per_day: z.number().gt(0).max(8),
    attrition_threshold: z.number().gt(0).lt(1),
  })
  .strict();

export const transitionBody = z
  .object({
    from_profile_id: uuid,
    to_profile_id: uuid,
    transition_type: z.enum(['vertical', 'horizontal', 'diagonal']),
    typical_months: z.number().int().min(0).max(240).nullable().default(null),
  })
  .strict()
  .refine((t) => t.from_profile_id !== t.to_profile_id, 'A transition must change profile.');

export const learningItemBody = z
  .object({
    item_id: uuid.optional(),
    title: text(300),
    provider: z.string().max(200).nullable().default(null),
    url: z.string().url().max(2000).nullable().default(null),
    skill_ids: z.array(uuid).min(1).max(20),
    duration_hours: z.number().gt(0).max(2000),
    external_ref: z.string().max(200).nullable().default(null),
  })
  .strict();

export const skillGapQuery = z
  .object({
    tenant_id: uuid.optional(),
    group_by: z.enum(['department', 'job_profile', 'location']).default('department'),
    period: z
      .string()
      .regex(/^([1-9]|1[0-9]|2[0-4])m$/, 'period is 1m to 24m')
      .default('6m'),
  })
  .strict();

export const opportunityBody = z
  .object({
    type: z.enum(OPPORTUNITY_TYPES),
    title: text(200),
    description: z.string().max(20_000).default(''),
    job_profile_id: uuid.nullable().default(null),
    requisition_id: uuid.nullable().default(null),
    project_id: uuid.nullable().default(null),
    skills: z.array(requirement).max(50).nullable().default(null),
    allocation_pct: z.number().int().min(1).max(100).default(100),
    start_date: date,
    end_date: date.nullable().default(null),
    location: z.string().max(200).nullable().default(null),
    min_tenure_months: z.number().int().min(0).max(120).default(12),
  })
  .strict()
  .refine((o) => o.end_date === null || o.end_date >= o.start_date, {
    message: 'end_date must not be before start_date',
    path: ['end_date'],
  });

export const feedQuery = z
  .object({
    tenant_id: uuid.optional(),
    for: z.literal('me'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const recommendBody = z
  .object({
    limit: z.number().int().min(1).max(200).default(20),
    include_unavailable: z.boolean().default(false),
  })
  .strict();

export const applyBody = z.object({ note: z.string().max(2000).nullable().default(null) }).strict();
export const inviteBody = z
  .object({ employee_id: uuid, note: z.string().max(2000).nullable().default(null) })
  .strict();

export const projectBody = z
  .object({
    name: text(200),
    account_id: z.string().max(100).nullable().default(null),
    start_date: date,
    end_date: date.nullable().default(null),
  })
  .strict();

export const allocationBody = z
  .object({
    employee_id: uuid,
    percent: z.number().int().min(1).max(100),
    start_date: date,
    end_date: date.nullable().default(null),
  })
  .strict()
  .refine((a) => a.end_date === null || a.end_date >= a.start_date, {
    message: 'end_date must not be before start_date',
    path: ['end_date'],
  });

export const uploadBody = z
  .object({
    file_name: z
      .string()
      .min(1)
      .max(300)
      .regex(/\.(csv|xlsx)$/i, 'a .csv or .xlsx file'),
    content_base64: z.string().min(1),
  })
  .strict();

export const demandsQuery = z
  .object({
    tenant_id: uuid.optional(),
    status: z.enum(['open', 'fulfilled', 'cancelled']).optional(),
    account_id: z.string().max(100).optional(),
    batch_id: uuid.optional(),
  })
  .strict();

export const computeBody = z
  .object({
    account_id: z.string().max(100).nullable().default(null),
    horizon_days: z.number().int().min(1).max(730).default(90),
  })
  .strict();

export const alertsQuery = z
  .object({
    tenant_id: uuid.optional(),
    status: z.enum(['open', 'acknowledged', 'closed']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
