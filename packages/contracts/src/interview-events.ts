import { z } from 'zod';
import { defineEvent } from './event';

/**
 * interview-svc events (docs/prompts/11-interview-svc.md §5). `interview.session.completed.v1`
 * lives in assessment-events.ts (its consumer, assessment-svc, fixed that contract first).
 */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

export const INTERVIEW_FLAGS = [
  'prompt_injection_attempt',
  'abusive_content',
  'safety_stop',
  'blocked_question',
] as const;

/**
 * Something a reviewer must see: an injection attempt (the answer was not scored), abuse, or a
 * safety stop that ended the interview. Carries the turn index, never the transcript text.
 */
export const InterviewSessionFlagged = defineEvent(
  'interview.session.flagged.v1',
  'interview_session',
  z.object({
    tenant_id: uuid,
    interview_session_id: uuid,
    assessment_session_id: uuid,
    interview_id: uuid,
    flag: z.enum(INTERVIEW_FLAGS),
    turn_index: z.number().int().min(0).nullable(),
    ended_session: z.boolean(),
    occurred_at: isoTime,
  }),
);
