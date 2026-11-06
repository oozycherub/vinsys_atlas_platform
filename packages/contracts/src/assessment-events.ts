import { z } from 'zod';
import { defineEvent } from './event';

/**
 * assessment-svc events (docs/prompts/08-assessment-svc.md §5). `assessment.session.evaluated.v1`
 * lives in profile-events.ts (its consumer, profile-svc, fixed that contract first).
 *
 * The consumed contracts at the bottom are fixed here, consumer first, for bricks 9–11
 * (sandbox, proctoring, AI interviews) to produce.
 */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

export const AssessmentPublished = defineEvent(
  'assessment.assessment.published.v1',
  'assessment',
  z.object({
    tenant_id: uuid,
    assessment_id: uuid,
    version: z.number().int().min(1),
    kind: z.enum(['skills_test', 'coding', 'ai_interview', 'mixed']),
    skill_ids: z.array(uuid),
    /** Registry slugs of the coding languages offered (sandbox-svc pre-warms their images). */
    coding_languages: z.array(z.string().min(1).max(30)).max(40).optional(),
    occurred_at: isoTime,
  }),
);

const sessionRef = {
  tenant_id: uuid,
  session_id: uuid,
  assessment_id: uuid,
  assessment_version: z.number().int().min(1),
  candidate_id: uuid,
};

export const SessionStarted = defineEvent(
  'assessment.session.started.v1',
  'assessment_session',
  z.object({
    ...sessionRef,
    attempt_no: z.number().int().min(1),
    deadline_at: isoTime,
    occurred_at: isoTime,
  }),
);

export const SessionSubmitted = defineEvent(
  'assessment.session.submitted.v1',
  'assessment_session',
  z.object({
    ...sessionRef,
    /** `expired`: the deadline passed and the last acknowledged answers were submitted. */
    outcome: z.enum(['submitted', 'expired']),
    review_required: z.boolean(),
    occurred_at: isoTime,
  }),
);

export const SessionTerminated = defineEvent(
  'assessment.session.terminated.v1',
  'assessment_session',
  z.object({ ...sessionRef, reason: z.string().max(200), occurred_at: isoTime }),
);

// --- Consumed: produced by later bricks ------------------------------------------------------

/** sandbox-svc (brick 9): a coding answer was judged against the hidden tests. */
export const SubmissionJudged = defineEvent(
  'sandbox.submission.judged.v1',
  'submission',
  z.object({
    tenant_id: uuid,
    session_id: uuid,
    question_id: uuid,
    submission_id: uuid,
    verdict: z.enum([
      'accepted',
      'wrong_answer',
      'time_limit_exceeded',
      'memory_limit_exceeded',
      'output_limit_exceeded',
      'runtime_error',
      'compilation_error',
      'internal_error',
    ]),
    tests_passed: z.number().int().min(0),
    tests_total: z.number().int().min(0),
    /** Σ weight of passed tests / Σ weights (tests may carry weights); absent from old producers. */
    score_ratio: z.number().min(0).max(1).optional(),
    /** When the candidate submitted; the latest submission wins if results arrive out of order. */
    submitted_at: isoTime.optional(),
    judged_at: isoTime,
  }),
);

/** proctoring-svc (brick 10): a rule fired; `terminate` ends the session. */
export const ViolationRaised = defineEvent(
  'proctoring.violation.raised.v1',
  'assessment_session',
  z.object({
    tenant_id: uuid,
    session_id: uuid,
    rule: z.string().max(100),
    severity: z.number().int().min(0).max(3),
    action: z.enum(['flag', 'review', 'terminate']),
    trust_score: z.number().int().min(0).max(100).nullable(),
    occurred_at: isoTime,
  }),
);

/**
 * interview-svc (brick 11): an AI interview question was scored (0–1 of its marks). `session_id`
 * is the assessment session. The optional members (added by interview-svc, ADR-0008) carry the
 * report summary; a recruiter override publishes a higher `revision`.
 */
export const InterviewCompleted = defineEvent(
  'interview.session.completed.v1',
  'assessment_session',
  z.object({
    tenant_id: uuid,
    session_id: uuid,
    question_id: uuid,
    score_ratio: z.number().min(0).max(1),
    needs_review: z.boolean(),
    completed_at: isoTime,
    interview_session_id: uuid.optional(),
    interview_id: uuid.optional(),
    outcome: z.enum(['completed', 'declined', 'escalated', 'abandoned']).optional(),
    recommendation: z.enum(['advance', 'hold', 'do_not_advance']).nullable().optional(),
    requires_approval: z.boolean().optional(),
    competencies: z
      .array(
        z.object({
          skill_id: uuid,
          weight: z.number().min(0).max(1),
          /** 1–5; null when the scorer's citations did not hold up ("insufficient evidence"). */
          score: z.number().min(1).max(5).nullable(),
        }),
      )
      .max(50)
      .optional(),
    revision: z.number().int().min(1).optional(),
  }),
);
