import { z } from 'zod';

/**
 * `assessment-runner` SDK types: what the candidate test runner (web app, brick 14) exchanges
 * with assessment-svc's runtime API. Hidden fields (correct options, accepted answers, test
 * cases, explanations) do not exist in these shapes, so they cannot be rendered by mistake.
 */
export const QUESTION_TYPES = [
  'mcq',
  'multiple_answer',
  'true_false',
  'fill_blank',
  'descriptive',
  'coding',
  'ai_interview',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const RunnerQuestion = z.object({
  index: z.number().int().min(1),
  section_index: z.number().int().min(1),
  question_id: z.string().uuid(),
  type: z.enum(QUESTION_TYPES),
  prompt: z.string(),
  options: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  marks: z.number(),
  /** Coding only: languages and the starter code; never the tests. */
  coding: z
    .object({ languages: z.array(z.string()), starter_code: z.record(z.string()) })
    .optional(),
  response: z.unknown().nullable(),
  client_rev: z.number().int().min(0),
});
export type RunnerQuestion = z.infer<typeof RunnerQuestion>;

export const RunnerSession = z.object({
  session_id: z.string().uuid(),
  status: z.string(),
  title: z.string(),
  navigation: z.enum(['fixed_section_order', 'section_switch']),
  question_count: z.number().int(),
  sections: z.array(
    z.object({ index: z.number().int(), title: z.string(), questions: z.number().int() }),
  ),
  current_section: z.number().int().min(1),
  started_at: z.string().nullable(),
  deadline_at: z.string().nullable(),
  server_time: z.string(),
  remaining_seconds: z.number().int().nullable(),
});
export type RunnerSession = z.infer<typeof RunnerSession>;

export const SaveResponseRequest = z.object({
  /** The revision the client last saw; the server accepts only client_rev + 1. */
  client_rev: z.number().int().min(0),
  answer: z.unknown(),
});
export type SaveResponseRequest = z.infer<typeof SaveResponseRequest>;

export const SaveResponseResult = z.object({
  question_id: z.string().uuid(),
  client_rev: z.number().int(),
  saved_at: z.string(),
  remaining_seconds: z.number().int(),
});
export type SaveResponseResult = z.infer<typeof SaveResponseResult>;

/** Server-sent events on `GET /v1/sessions/{id}/events`. */
export const RUNNER_EVENTS = [
  'state',
  'time_warning',
  'paused',
  'resumed',
  'terminated',
  'ended',
] as const;
export type RunnerEvent = (typeof RUNNER_EVENTS)[number];
