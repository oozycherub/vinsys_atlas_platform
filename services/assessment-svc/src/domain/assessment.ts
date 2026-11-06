/**
 * Assessments: the definition (≤ 20 sections, ≤ 5 question banks per section), settings and
 * report configuration; publishing (pins every question version, then the version is immutable);
 * and each attempt's plan (bank draws resolved deterministically per session).
 */
import { createHash } from 'node:crypto';
import { type Question } from './questions';

export const MAX_SECTIONS = 20;
export const MAX_BANKS_PER_SECTION = 5;

export interface SectionDefinition {
  title: string;
  /** Fixed questions; `version` is pinned at publish (latest active when omitted). */
  questions: { question_id: string; version?: number | undefined; marks?: number | undefined }[];
  /** Random draws per attempt from a question bank (≤ 5 per section). */
  banks: { bank_id: string; count: number; difficulty?: 'easy' | 'medium' | 'hard' | undefined }[];
}

export interface Definition {
  sections: SectionDefinition[];
}

export interface Settings {
  max_attempts: number;
  retake_cooldown_days: number;
  /** Total time an interrupted session may be paused for (network drop, crash). */
  pause_allowance_seconds: number;
  shuffle_questions: boolean;
  /** Absent on assessments created before brick 10. */
  proctoring?: {
    enabled: boolean;
    id_verification: boolean;
    rules: Record<string, unknown> | null;
  };
}

export interface Band {
  name: string;
  min_percent: number;
}

export interface ReportConfig {
  bands: Band[];
  /** Assessment skill evidence stays valid this long (PRD §2.5 validity window). */
  skill_validity_months: number;
}

export type AssessmentStatus = 'draft' | 'published' | 'inactive' | 'archived';
export type AssessmentKind = 'skills_test' | 'coding' | 'ai_interview' | 'mixed';
export type Navigation = 'fixed_section_order' | 'section_switch';

export interface Assessment {
  tenantId: string;
  id: string;
  version: number;
  title: string;
  candidateAlias: string | null;
  kind: AssessmentKind;
  status: AssessmentStatus;
  navigation: Navigation;
  durationSeconds: number;
  definition: Definition;
  settings: Settings;
  reportConfig: ReportConfig;
  jobProfileId: string | null;
  lockVersion: number;
  createdBy: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class AssessmentRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssessmentRuleError';
  }
}

/** The version-pinned definition stored at publish. */
export function pinDefinition(
  def: Definition,
  latest: ReadonlyMap<string, Question>,
  banks: ReadonlyMap<string, Question[]>,
): Definition {
  return {
    sections: def.sections.map((section, s) => ({
      ...section,
      questions: section.questions.map((ref) => {
        const q = latest.get(ref.question_id);
        if (!q)
          throw new AssessmentRuleError(
            'QUESTION_NOT_FOUND',
            `Section ${s + 1}: question ${ref.question_id} does not exist.`,
          );
        const version = ref.version ?? q.version;
        return {
          question_id: ref.question_id,
          version,
          ...(ref.marks !== undefined ? { marks: ref.marks } : {}),
        };
      }),
      banks: section.banks.map((draw) => {
        const pool = (banks.get(draw.bank_id) ?? []).filter(
          (q) => !draw.difficulty || q.difficulty === draw.difficulty,
        );
        if (pool.length < draw.count) {
          throw new AssessmentRuleError(
            'BANK_TOO_SMALL',
            `Section ${s + 1}: the bank has ${pool.length} matching active questions, ${draw.count} requested.`,
          );
        }
        return draw;
      }),
    })),
  };
}

export interface PlanItem {
  question_id: string;
  version: number;
  marks: number;
}

export interface Plan {
  sections: { title: string; items: PlanItem[] }[];
}

/** Deterministic PRNG (mulberry32) seeded from the session id: a draw is reproducible. */
function rng(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * The questions of one attempt: fixed questions as pinned, plus `count` distinct questions drawn
 * from each bank (never a question already in the plan). Marks default to the question's marks.
 */
export function buildPlan(
  a: Pick<Assessment, 'definition' | 'settings'>,
  sessionId: string,
  questions: ReadonlyMap<string, Question>,
  banks: ReadonlyMap<string, Question[]>,
): Plan {
  const random = rng(sessionId);
  const used = new Set<string>();
  const key = (id: string, v: number) => `${id}@${v}`;
  return {
    sections: a.definition.sections.map((section) => {
      const items: PlanItem[] = section.questions.map((ref) => {
        const q = questions.get(key(ref.question_id, ref.version ?? 0));
        if (!q)
          throw new AssessmentRuleError(
            'QUESTION_NOT_FOUND',
            `Question ${ref.question_id}@${ref.version} is missing.`,
          );
        used.add(q.id);
        return { question_id: q.id, version: q.version, marks: ref.marks ?? q.marks };
      });
      for (const draw of section.banks) {
        const pool = shuffle(
          (banks.get(draw.bank_id) ?? []).filter(
            (q) => !used.has(q.id) && (!draw.difficulty || q.difficulty === draw.difficulty),
          ),
          random,
        ).slice(0, draw.count);
        if (pool.length < draw.count)
          throw new AssessmentRuleError(
            'BANK_TOO_SMALL',
            'A question bank no longer has enough questions.',
          );
        for (const q of pool) {
          used.add(q.id);
          items.push({ question_id: q.id, version: q.version, marks: q.marks });
        }
      }
      return {
        title: section.title,
        items: a.settings.shuffle_questions ? shuffle(items, random) : items,
      };
    }),
  };
}

export function planItems(plan: Plan): { item: PlanItem; index: number; section: number }[] {
  const out: { item: PlanItem; index: number; section: number }[] = [];
  plan.sections.forEach((s, si) =>
    s.items.forEach((item) => out.push({ item, index: out.length + 1, section: si + 1 })),
  );
  return out;
}

export function performanceBand(percent: number, config: ReportConfig): string {
  const sorted = [...config.bands].sort((a, b) => b.min_percent - a.min_percent);
  return (
    (sorted.find((b) => percent >= b.min_percent) ?? sorted[sorted.length - 1])?.name ?? 'Unbanded'
  );
}
