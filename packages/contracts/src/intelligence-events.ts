import { z } from 'zod';
import { defineEvent } from './event';

/**
 * intelligence-svc and intelligence-ml events (docs/prompts/12-intelligence-svc.md §5, ADR-0009).
 * Employees are referenced by id only; attrition probabilities never leave the HRBP boundary on
 * an event, only the alert and its recipients do.
 */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const OPPORTUNITY_TYPES = ['role', 'project', 'gig'] as const;
export const FULFILMENT_CLASSES = ['redeploy', 'upskill', 'recruit'] as const;

const requirement = z.object({
  skill_id: uuid,
  weight: z.number().gt(0).lte(1),
  target_proficiency: z.number().min(0).max(5),
  must_have: z.boolean(),
});

/** An opportunity opened in the internal marketplace; the matcher ranks employees for it. */
export const OpportunityPublished = defineEvent(
  'intel.opportunity.published.v1',
  'opportunity',
  z.object({
    tenant_id: uuid,
    opportunity_id: uuid,
    type: z.enum(OPPORTUNITY_TYPES),
    job_profile_id: uuid.nullable(),
    requisition_id: uuid.nullable(),
    allocation_pct: z.number().int().min(1).max(100),
    start_date: isoDate,
    end_date: isoDate.nullable(),
    required_skills: z.number().int().min(0),
    occurred_at: isoTime,
  }),
);

/** An employee's project allocations changed (their availability for other matches too). */
export const AllocationChanged = defineEvent(
  'intel.allocation.changed.v1',
  'employee',
  z.object({
    tenant_id: uuid,
    employee_id: uuid,
    allocation_id: uuid,
    project_id: uuid,
    change: z.enum(['created', 'updated', 'deleted']),
    percent: z.number().int().min(1).max(100),
    start_date: isoDate,
    end_date: isoDate.nullable(),
    occurred_at: isoTime,
  }),
);

/**
 * A fulfilment plan could not staff a demand internally (PRD §2.5(iv) "Need to recruit").
 * matching-svc may create a draft job requisition from it (idempotent per demand and plan).
 */
export const DemandRecruitRequired = defineEvent(
  'intel.demand.recruit_required.v1',
  'demand',
  z.object({
    tenant_id: uuid,
    demand_id: uuid,
    plan_id: uuid,
    account_id: z.string().max(100).nullable(),
    title: z.string().min(1).max(200),
    job_profile_id: uuid.nullable(),
    skills: z.array(requirement).max(100),
    headcount: z.number().int().min(1).max(1000),
    start_date: isoDate,
    location: z.string().max(200).nullable(),
    occurred_at: isoTime,
  }),
);

/**
 * An attrition alert for HRBPs and the employee's manager (PRD §2.5(vi)). Carries the drivers as
 * phrases and the suggested actions, never the probability; the employee never sees either.
 */
export const AttritionAlertRaised = defineEvent(
  'intel.attrition.alert_raised.v1',
  'employee',
  z.object({
    tenant_id: uuid,
    alert_id: uuid,
    employee_id: uuid,
    manager_user_id: z.string().max(200).nullable(),
    recipients: z.array(z.enum(['hrbp', 'manager'])).min(1),
    drivers: z.array(z.string().max(200)).max(3),
    suggested_actions: z
      .array(
        z.object({
          kind: z.enum(['opportunity', 'learning']),
          id: uuid,
          title: z.string().max(200),
        }),
      )
      .max(10),
    model_version: z.string().max(100),
    occurred_at: isoTime,
  }),
);
