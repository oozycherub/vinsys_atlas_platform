/**
 * Input validation (zod) for the domain's shapes. Kept in the application layer: the domain has
 * no framework dependencies (hexagonal rule, MASTER_ORCHESTRATION_PROMPT §4.1).
 */
import { type QuestionType } from '@atlas/contracts';
import { z } from 'zod';
import {
  type Definition,
  MAX_BANKS_PER_SECTION,
  MAX_SECTIONS,
  type ReportConfig,
  type Settings,
} from '../domain/assessment';
import { QuestionError } from '../domain/questions';

const option = z.object({
  id: z.string().min(1).max(20),
  text: z.string().min(1).max(2000),
  correct: z.boolean(),
});

export const PAYLOADS = {
  mcq: z
    .object({ options: z.array(option).min(2).max(10) })
    .strict()
    .refine(
      (p) => p.options.filter((o) => o.correct).length === 1,
      'An MCQ has exactly one correct option.',
    ),
  multiple_answer: z
    .object({ options: z.array(option).min(2).max(10), partial_credit: z.boolean().default(false) })
    .strict()
    .refine((p) => p.options.some((o) => o.correct), 'At least one option must be correct.'),
  true_false: z.object({ correct: z.boolean() }).strict(),
  fill_blank: z
    .object({
      accepted: z.array(z.string().min(1).max(500)).min(1).max(20),
      case_sensitive: z.boolean().default(false),
    })
    .strict(),
  descriptive: z
    .object({
      rubric: z.string().max(5000).default(''),
      max_words: z.number().int().min(1).max(5000).optional(),
    })
    .strict(),
  coding: z
    .object({
      languages: z.array(z.string().min(1).max(30)).min(1).max(40),
      starter_code: z.record(z.string().max(20000)).default({}),
      tests: z
        .array(
          z.object({
            input: z.string().max(100000),
            expected: z.string().max(100000),
            hidden: z.boolean().default(true),
            weight: z.number().min(0).max(1000).optional(),
          }),
        )
        .min(1)
        .max(200),
      /** Required to publish: sandbox-svc runs it 5× against the tests (flaky-test guard). */
      reference_solution: z
        .object({ language: z.string().min(1).max(30), code: z.string().min(1).max(65536) })
        .strict()
        .optional(),
      checker: z
        .object({
          kind: z.enum(['exact', 'trim_ws', 'float_tol', 'unordered_lines', 'custom']),
          tolerance: z.number().min(0).max(1).optional(),
          language: z.string().max(30).optional(),
          source: z.string().max(65536).optional(),
        })
        .strict()
        .optional(),
      limits: z
        .object({
          cpu_ms: z.number().int().min(100).max(15000).optional(),
          wall_ms: z.number().int().min(100).max(30000).optional(),
          memory_kb: z.number().int().min(16384).max(1048576).optional(),
          processes: z.number().int().min(1).max(64).optional(),
          output_kb: z.number().int().min(1).max(8192).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  /** The interview (built in interview-svc) this question runs; its published plan is used. */
  ai_interview: z.object({ interview_id: z.string().uuid() }).strict(),
} as const;

export function parsePayload(type: QuestionType, payload: unknown): Record<string, unknown> {
  const result = PAYLOADS[type].safeParse(payload);
  if (!result.success) {
    throw new QuestionError(
      result.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; '),
    );
  }
  return result.data as Record<string, unknown>;
}

export const ANSWERS = {
  mcq: z.object({ option_id: z.string().max(20) }).strict(),
  multiple_answer: z.object({ option_ids: z.array(z.string().max(20)).max(10) }).strict(),
  true_false: z.object({ value: z.boolean() }).strict(),
  fill_blank: z.object({ text: z.string().max(500) }).strict(),
  descriptive: z.object({ text: z.string().max(50_000) }).strict(),
  coding: z.object({ language: z.string().max(30), code: z.string().max(65_536) }).strict(),
  /** Set by `:startInterview`, never by the candidate's autosave. */
  ai_interview: z.object({ interview_session_id: z.string().uuid() }).strict(),
} as const;

export function parseAnswer(type: QuestionType, answer: unknown): unknown {
  if (answer === null) return null; // clearing an answer
  const result = ANSWERS[type].safeParse(answer);
  if (!result.success) throw new QuestionError(`The answer does not fit a ${type} question.`);
  return result.data;
}

const uuid = z.string().uuid();

export const definitionSchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            /** Fixed questions; `version` is pinned at publish (latest active when omitted). */
            questions: z
              .array(
                z
                  .object({
                    question_id: uuid,
                    version: z.number().int().min(1).optional(),
                    marks: z.number().gt(0).max(1000).optional(),
                  })
                  .strict(),
              )
              .max(200)
              .default([]),
            /** Random draws per attempt from a question bank. */
            banks: z
              .array(
                z
                  .object({
                    bank_id: uuid,
                    count: z.number().int().min(1).max(100),
                    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
                  })
                  .strict(),
              )
              .max(MAX_BANKS_PER_SECTION)
              .default([]),
          })
          .strict()
          .refine(
            (s) => s.questions.length + s.banks.length > 0,
            'A section needs questions or a bank.',
          ),
      )
      .min(1)
      .max(MAX_SECTIONS),
  })
  .strict();

export const settingsSchema = z
  .object({
    max_attempts: z.number().int().min(1).max(50).default(1),
    retake_cooldown_days: z.number().int().min(0).max(365).default(0),
    /** Total time an interrupted session may be paused for (network drop, crash). */
    pause_allowance_seconds: z.number().int().min(0).max(3600).default(300),
    shuffle_questions: z.boolean().default(false),
    /** AI proctoring (proctoring-svc, brick 10); `rules` are validated by proctoring-svc. */
    proctoring: z
      .object({
        enabled: z.boolean().default(false),
        id_verification: z.boolean().default(false),
        rules: z.record(z.unknown()).nullable().default(null),
      })
      .strict()
      .default({ enabled: false, id_verification: false, rules: null }),
  })
  .strict();

export const bandSchema = z
  .object({ name: z.string().min(1).max(40), min_percent: z.number().min(0).max(100) })
  .strict();

export const reportConfigSchema = z
  .object({
    bands: z
      .array(bandSchema)
      .min(1)
      .max(10)
      .default([
        { name: 'Excellent', min_percent: 85 },
        { name: 'Good', min_percent: 70 },
        { name: 'Average', min_percent: 50 },
        { name: 'Needs improvement', min_percent: 0 },
      ])
      .refine((b) => b.some((x) => x.min_percent === 0), 'One band must start at 0%.'),
    /** Assessment skill evidence stays valid this long (PRD §2.5 validity window). */
    skill_validity_months: z.number().int().min(1).max(120).default(24),
  })
  .strict();

// Compile-time checks that the schemas produce the domain's types.
export const definitionIsDomain = (d: z.output<typeof definitionSchema>): Definition => d;
export const settingsIsDomain = (s: z.output<typeof settingsSchema>): Settings => s;
export const reportIsDomain = (r: z.output<typeof reportConfigSchema>): ReportConfig => r;
export type { QuestionType };
