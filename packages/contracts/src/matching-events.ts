import { z } from 'zod';
import { defineEvent } from './event';

/** matching-svc events (docs/prompts/07-matching-svc.md §5). Candidates by id only. */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });
const BANDS = ['strong', 'good', 'partial', 'weak'] as const;

/** A requisition's requirements were (re)snapshotted and its embedding computed. */
export const RequisitionCalibrated = defineEvent(
  'matching.requisition.calibrated.v1',
  'requisition',
  z.object({
    tenant_id: uuid,
    requisition_id: uuid,
    job_profile_id: uuid.nullable(),
    job_profile_version: z.number().int().min(1).nullable(),
    required_skills: z.number().int().min(0),
    calibration_version: z.number().int().min(1),
    occurred_at: isoTime,
  }),
);

/** A candidate's scores against open requisitions changed (incremental re-scoring). */
export const CandidateRescored = defineEvent(
  'matching.candidate.rescored.v1',
  'candidate',
  z.object({
    tenant_id: uuid,
    candidate_id: uuid,
    weights_version: z.string(),
    scores: z.array(
      z.object({
        requisition_id: uuid,
        score: z.number().min(0).max(1),
        band: z.enum(BANDS),
      }),
    ),
    occurred_at: isoTime,
  }),
);
