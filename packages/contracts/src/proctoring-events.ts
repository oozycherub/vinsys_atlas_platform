import { z } from 'zod';
import { defineEvent } from './event';

/**
 * proctoring-svc events (docs/prompts/10-proctoring-svc.md §5). `proctoring.violation.raised.v1`
 * lives in assessment-events.ts (its consumer fixed that contract first).
 */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

export const TRUST_BANDS = ['green', 'yellow', 'red'] as const;

/**
 * The session's Trust Score (PRD §2.3b), computed when the assessment session is submitted and
 * again after a reviewer confirms or dismisses a flag (`revision` increases). Red sessions need a
 * human decision: no candidate is rejected on AI inference alone (§4.1).
 */
export const ProctoringSessionFinalized = defineEvent(
  'proctoring.session.finalized.v1',
  'assessment_session',
  z.object({
    tenant_id: uuid,
    session_id: uuid,
    assessment_id: uuid,
    trust_score: z.number().int().min(0).max(100),
    band: z.enum(TRUST_BANDS),
    review_required: z.boolean(),
    /** Points deducted per signal, after caps (explainability). */
    breakdown: z.record(z.number().min(0).max(100)),
    revision: z.number().int().min(1),
    occurred_at: isoTime,
  }),
);

/**
 * A frame, reference image or audio window was uploaded; cv-inference analyses it and posts the
 * result back to proctoring-svc. Carries object keys only, never biometric data.
 */
export const ProctoringFrameUploaded = defineEvent(
  'proctoring.frame.uploaded.v1',
  'proctoring_frame',
  z.object({
    tenant_id: uuid,
    session_id: uuid,
    frame_id: uuid,
    kind: z.enum(['frame', 'selfie', 'id_document', 'audio']),
    object_key: z.string().min(1).max(500),
    captured_at: isoTime,
    /** The client saw 0 or ≥ 2 faces (MediaPipe) and captured off-schedule. */
    triggered: z.boolean(),
  }),
);
