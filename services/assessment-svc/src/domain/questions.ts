/**
 * Question types, their authoring payloads (with the HIDDEN parts), the candidate-safe view, and
 * deterministic auto-scoring. Hidden parts: correct options, accepted answers, rubrics, tests.
 */
import { type QuestionType, type RunnerQuestion } from '@atlas/contracts';

export type { QuestionType };

/** Authoring payloads (validated by application/schemas.ts). Hidden parts included. */
export interface OptionPayload {
  options: { id: string; text: string; correct: boolean }[];
  partial_credit?: boolean;
}
export interface TrueFalsePayload {
  correct: boolean;
}
export interface FillBlankPayload {
  accepted: string[];
  case_sensitive: boolean;
}
export interface DescriptivePayload {
  rubric: string;
  max_words?: number;
}
export interface CodingPayload {
  languages: string[];
  starter_code: Record<string, string>;
  tests: { input: string; expected: string; hidden: boolean; weight?: number }[];
  /** Runs 5× at publish in sandbox-svc; the question is rejected unless always accepted. */
  reference_solution?: { language: string; code: string };
  checker?: { kind: string; tolerance?: number; language?: string; source?: string };
  limits?: Record<string, number>;
}

export interface Question {
  tenantId: string;
  id: string;
  version: number;
  bankId: string | null;
  type: QuestionType;
  prompt: string;
  payload: Record<string, unknown>;
  marks: number;
  negativeMarks: number;
  difficulty: 'easy' | 'medium' | 'hard';
  skillIds: string[];
  status: 'active' | 'retired';
  createdBy: string;
  createdAt: Date;
}

export class QuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionError';
  }
}

/**
 * What a candidate may see. Built field by field from an allow-list (never by deleting hidden
 * fields from a copy), so a new hidden field can never leak by omission.
 */
export function candidateView(
  q: Question,
  index: number,
  sectionIndex: number,
  marks: number,
  response: { answer: unknown; clientRev: number } | null,
): RunnerQuestion {
  const view: RunnerQuestion = {
    index,
    section_index: sectionIndex,
    question_id: q.id,
    type: q.type,
    prompt: q.prompt,
    marks,
    response: response?.answer ?? null,
    client_rev: response?.clientRev ?? 0,
  };
  if (q.type === 'mcq' || q.type === 'multiple_answer') {
    view.options = (q.payload as unknown as OptionPayload).options.map((o) => ({
      id: o.id,
      text: o.text,
    }));
  }
  if (q.type === 'true_false') {
    view.options = [
      { id: 'true', text: 'True' },
      { id: 'false', text: 'False' },
    ];
  }
  if (q.type === 'coding') {
    const p = q.payload as unknown as CodingPayload;
    view.coding = { languages: p.languages, starter_code: p.starter_code };
  }
  return view;
}

// --- Answers ------------------------------------------------------------------------------------

export interface AutoScore {
  /** Marks earned (may be negative with negative marking); null until a person or the judge scores it. */
  score: number | null;
  /** Fully correct (for the difficulty index); null when not auto-scorable. */
  correct: boolean | null;
  needs: 'review' | 'judge' | null;
}

const normalise = (s: string, caseSensitive: boolean): string => {
  const t = s.trim().replace(/\s+/g, ' ');
  return caseSensitive ? t : t.toLowerCase();
};

/** Deterministic scoring. Unanswered questions score 0 (never negative). */
export function autoScore(q: Question, marks: number, answer: unknown): AutoScore {
  const penalty = -Math.min(q.negativeMarks, marks);
  if (q.type === 'descriptive')
    return { score: null, correct: null, needs: answer ? 'review' : null };
  // Coding answers wait for the judge, AI interviews for interview-svc's scorer ('judge').
  if (q.type === 'coding' || q.type === 'ai_interview')
    return {
      score: answer ? null : 0,
      correct: answer ? null : false,
      needs: answer ? 'judge' : null,
    };
  if (answer === null || answer === undefined) return { score: 0, correct: false, needs: null };
  switch (q.type) {
    case 'mcq': {
      const p = q.payload as unknown as OptionPayload;
      const right =
        p.options.find((o) => o.correct)?.id === (answer as { option_id: string }).option_id;
      return { score: right ? marks : penalty, correct: right, needs: null };
    }
    case 'true_false': {
      const right =
        (q.payload as { correct: boolean }).correct === (answer as { value: boolean }).value;
      return { score: right ? marks : penalty, correct: right, needs: null };
    }
    case 'multiple_answer': {
      const p = q.payload as unknown as OptionPayload;
      const chosen = new Set((answer as { option_ids: string[] }).option_ids);
      if (chosen.size === 0) return { score: 0, correct: false, needs: null };
      const correctIds = new Set(p.options.filter((o) => o.correct).map((o) => o.id));
      const hits = [...chosen].filter((id) => correctIds.has(id)).length;
      const misses = chosen.size - hits;
      const exact = misses === 0 && hits === correctIds.size;
      if (exact) return { score: marks, correct: true, needs: null };
      if (p.partial_credit) {
        // Each correct choice earns its share; each wrong choice cancels one. Never below 0.
        const share = Math.max(0, (hits - misses) / correctIds.size);
        return { score: round2(marks * share), correct: false, needs: null };
      }
      return { score: penalty, correct: false, needs: null };
    }
    case 'fill_blank': {
      const p = q.payload as unknown as FillBlankPayload;
      const given = normalise((answer as { text: string }).text, p.case_sensitive);
      const right =
        given !== '' && p.accepted.some((a) => normalise(a, p.case_sensitive) === given);
      return { score: right ? marks : given === '' ? 0 : penalty, correct: right, needs: null };
    }
    default:
      throw new QuestionError(`No auto-scoring for ${String(q.type)}.`);
  }
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;
