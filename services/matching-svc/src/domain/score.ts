/**
 * The scoring function (Component Prompt 07 §6). The formula itself is the shared, pure
 * `@atlas/scoring` package (reused by the marketplace, brick 12); this module adds what is
 * specific to hiring: the weights version, rounding for storage, and explanations.
 */
import { createHash } from 'node:crypto';
import {
  assertWeights,
  type Band,
  type Components,
  type ScoreResult,
  type SkillAssessment,
  type Weights,
} from '@atlas/scoring';

export * from '@atlas/scoring';

/** Stable id of a weight set: every stored score records which weights produced it. */
export function weightsVersion(w: Weights): string {
  assertWeights(w);
  const canonical = JSON.stringify([w.sem, w.cov, w.exp, w.lex].map((x) => Number(x.toFixed(6))));
  return 'w-' + createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

export interface StoredComponents {
  sem: number;
  sem_cosine: number;
  cov: number;
  exp: number;
  lex: number;
  gate: number;
}

export function roundComponents(c: Components): StoredComponents {
  return {
    sem: r4(c.sem),
    sem_cosine: r4(c.semCosine),
    cov: r4(c.cov),
    exp: r4(c.exp),
    lex: r4(c.lex),
    gate: r4(c.gate),
  };
}

export interface SkillLine {
  skill_id: string;
  required: number;
  candidate: number | null;
  must_have: boolean;
  via?: { skill_id: string; rho: number };
}

export interface Explanation {
  matched: SkillLine[];
  partial: SkillLine[];
  gaps: SkillLine[];
  must_have_failed: string[];
  evidence: { skill_id: string; snippet: string }[];
  closest_chunks: string[];
}

function line(a: SkillAssessment): SkillLine {
  return {
    skill_id: a.skillId,
    required: a.required,
    candidate: a.own === null ? null : r4(a.own),
    must_have: a.mustHave,
    ...(a.via ? { via: { skill_id: a.via.skillId, rho: a.via.rho } } : {}),
  };
}

/** Matched skills, gaps and evidence snippets (redacted text), for the recruiter UI. */
export function explain(
  result: ScoreResult,
  evidence: Readonly<Record<string, string>>,
  closestChunks: readonly string[],
): Explanation {
  const matched = result.skills.filter((a) => a.ratio >= 1);
  const partial = result.skills.filter((a) => a.ratio > 0 && a.ratio < 1);
  const gaps = result.skills.filter((a) => a.ratio === 0);
  return {
    matched: matched.map(line),
    partial: partial.map(line),
    gaps: gaps.map(line),
    must_have_failed: result.skills.filter((a) => a.mustHave && !a.meetsGate).map((a) => a.skillId),
    evidence: [...matched, ...partial]
      .map((a) => ({ skill_id: a.skillId, snippet: evidence[a.via?.skillId ?? a.skillId] }))
      .filter((e): e is { skill_id: string; snippet: string } => typeof e.snippet === 'string')
      .slice(0, 8),
    closest_chunks: [...closestChunks].slice(0, 3),
  };
}

export interface ScoredCandidate {
  candidate_id: string;
  score: number;
  band: Band;
  components: StoredComponents;
  explanation: Explanation;
}

export function toScored(
  candidateId: string,
  result: ScoreResult,
  evidence: Readonly<Record<string, string>>,
  closestChunks: readonly string[],
): ScoredCandidate {
  return {
    candidate_id: candidateId,
    score: r4(result.score),
    band: result.band,
    components: roundComponents(result.components),
    explanation: explain(result, evidence, closestChunks),
  };
}
