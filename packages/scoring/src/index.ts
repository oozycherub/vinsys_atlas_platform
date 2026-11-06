/**
 * The semantic matching formula, exactly as PRD §2.1(b) defines it:
 *
 *   Score(c, j) = M(c, j) · ( w_sem·SEM + w_cov·COV + w_exp·EXP + w_lex·LEX )
 *
 *   SEM = clip( (cos(ē_c, ē_j) − 0.30) / (0.85 − 0.30), 0, 1 )
 *         ē_c = normalised mean of the candidate's top-k chunk embeddings most similar to ē_j (k=3)
 *   COV = Σ_s w_s · min(1, p̂_c(s) / p_req(s)) / Σ_s w_s
 *         p̂_c(s) = max( p_c(s), max_{s'} ρ(s, s') · p_c(s') ),  ρ ∈ [0, 0.8]
 *   EXP = exp( − max(0, y_req − y_c)² / (2 · 2²) )
 *   LEX = BM25(c) / max BM25 in the result set
 *   M   = Π over must-haves m:  ( p̂_c(m) ≥ 0.5 · p_req(m) ? 1 : 0.5 )
 *
 * Pure functions only (no I/O, no clock), so matching-svc and the marketplace (brick 12) score
 * identically and every component has a golden unit test.
 */

export const SEM_LOW = 0.3;
export const SEM_HIGH = 0.85;
export const TOP_K_CHUNKS = 3;
export const MAX_RELATED_RHO = 0.8;
export const EXP_SIGMA_YEARS = 2;
export const MUST_HAVE_RATIO = 0.5;
export const MUST_HAVE_PENALTY = 0.5;
export const WEIGHT_TOLERANCE = 1e-6;

export interface Weights {
  sem: number;
  cov: number;
  exp: number;
  lex: number;
}

export const DEFAULT_WEIGHTS: Weights = { sem: 0.4, cov: 0.35, exp: 0.15, lex: 0.1 };

export type Band = 'strong' | 'good' | 'partial' | 'weak';

export class InvalidWeightsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWeightsError';
  }
}

/** Weights must be finite, non-negative and sum to 1 (tenant-svc enforces this too). */
export function assertWeights(w: Weights): Weights {
  const values = [w.sem, w.cov, w.exp, w.lex];
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new InvalidWeightsError('Matching weights must be finite and non-negative.');
  }
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > WEIGHT_TOLERANCE) {
    throw new InvalidWeightsError(`Matching weights must sum to 1 (got ${sum.toFixed(6)}).`);
  }
  return w;
}

export function band(score: number): Band {
  if (score >= 0.75) return 'strong';
  if (score >= 0.6) return 'good';
  if (score >= 0.45) return 'partial';
  return 'weak';
}

const clip = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));

// --- SEM ------------------------------------------------------------------------------------

export function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`Vector lengths differ (${a.length} ≠ ${b.length}).`);
  let s = 0;
  a.forEach((x, i) => {
    s += x * (b[i] ?? 0);
  });
  return s;
}

export function normalise(v: readonly number[]): number[] {
  const n = Math.sqrt(dot(v, v));
  return n === 0 ? [...v] : v.map((x) => x / n);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const na = Math.sqrt(dot(a, a));
  const nb = Math.sqrt(dot(b, b));
  return na === 0 || nb === 0 ? 0 : dot(a, b) / (na * nb);
}

/** ē_c: the normalised mean of the k chunk embeddings most similar to the job embedding. */
export function candidateEmbedding(
  chunks: readonly (readonly number[])[],
  job: readonly number[],
  k: number = TOP_K_CHUNKS,
): number[] | null {
  if (chunks.length === 0) return null;
  const top = [...chunks]
    .map((c) => ({ c, s: cosine(c, job) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ c }) => normalise(c));
  const mean = new Array<number>(job.length).fill(0);
  for (const v of top) v.forEach((x, i) => (mean[i] = (mean[i] ?? 0) + x / top.length));
  return normalise(mean);
}

/** bge-m3 cosine for unrelated text rarely drops below ~0.3, hence the rescaling. */
export function semFromCosine(cos: number): number {
  return clip((cos - SEM_LOW) / (SEM_HIGH - SEM_LOW));
}

export function sem(
  chunks: readonly (readonly number[])[],
  job: readonly number[],
  k: number = TOP_K_CHUNKS,
): { cosine: number; value: number } {
  const ec = candidateEmbedding(chunks, job, k);
  if (!ec) return { cosine: 0, value: 0 };
  const cos = cosine(ec, job);
  return { cosine: cos, value: semFromCosine(cos) };
}

// --- COV and the must-have gate ----------------------------------------------------------------

export interface RelatedSkill {
  skillId: string;
  /** RELATED_TO edge weight from the skill graph; capped at 0.8 here. */
  rho: number;
}

export interface Requirement {
  skillId: string;
  /** w_s: importance in (0, 1]. */
  weight: number;
  /** p_req(s) on the 0–5 scale. */
  target: number;
  mustHave: boolean;
  related: readonly RelatedSkill[];
}

export interface CandidateSkill {
  proficiency: number;
  /** Fused from a validated source (assessment, certification, …). */
  validated: boolean;
}

export interface ScoringOptions {
  /**
   * Weight given to unvalidated proficiencies. 1 for hiring (PRD §2.1); the internal
   * marketplace uses 0.5 (PRD §2.5(iv): "unvalidated skills count at 50%").
   */
  unvalidatedFactor?: number;
  /** Availability and mobility multiplier for the marketplace (PRD §2.5(iv)); 1 for hiring. */
  availability?: number;
}

export interface SkillAssessment {
  skillId: string;
  required: number;
  weight: number;
  mustHave: boolean;
  /** p_c(s), after the unvalidated factor; null when the candidate does not have the skill. */
  own: number | null;
  /** p̂_c(s). */
  effective: number;
  /** The related skill that supplied p̂, when it beat the candidate's own proficiency. */
  via: { skillId: string; rho: number; proficiency: number } | null;
  /** min(1, p̂ / p_req). */
  ratio: number;
  /** Must-have gate: p̂ ≥ 0.5 · p_req. */
  meetsGate: boolean;
}

function proficiencyOf(
  skills: ReadonlyMap<string, CandidateSkill>,
  skillId: string,
  factor: number,
): number | null {
  const s = skills.get(skillId);
  if (!s) return null;
  return s.validated ? s.proficiency : s.proficiency * factor;
}

export function assessSkill(
  req: Requirement,
  skills: ReadonlyMap<string, CandidateSkill>,
  options: ScoringOptions = {},
): SkillAssessment {
  const factor = options.unvalidatedFactor ?? 1;
  const own = proficiencyOf(skills, req.skillId, factor);
  let effective = own ?? 0;
  let via: SkillAssessment['via'] = null;
  for (const r of req.related) {
    const p = proficiencyOf(skills, r.skillId, factor);
    if (p === null) continue;
    const rho = clip(r.rho, 0, MAX_RELATED_RHO);
    if (rho * p > effective) {
      effective = rho * p;
      via = { skillId: r.skillId, rho, proficiency: p };
    }
  }
  const ratio = req.target <= 0 ? 1 : Math.min(1, effective / req.target);
  return {
    skillId: req.skillId,
    required: req.target,
    weight: req.weight,
    mustHave: req.mustHave,
    own,
    effective,
    via,
    ratio,
    meetsGate: effective >= MUST_HAVE_RATIO * req.target,
  };
}

/** COV over the required skills; a requisition without skills has nothing to cover (1). */
export function coverage(assessed: readonly SkillAssessment[]): number {
  const total = assessed.reduce((s, a) => s + a.weight, 0);
  if (total <= 0) return 1;
  return assessed.reduce((s, a) => s + a.weight * a.ratio, 0) / total;
}

/** M: a soft gate, halving the score for every must-have below half its target. */
export function mustHaveGate(assessed: readonly SkillAssessment[]): number {
  return assessed
    .filter((a) => a.mustHave)
    .reduce((m, a) => m * (a.meetsGate ? 1 : MUST_HAVE_PENALTY), 1);
}

// --- EXP and LEX -----------------------------------------------------------------------------

/** Gaussian penalty for missing years (σ = 2); surplus experience is never penalised. */
export function experience(requiredYears: number | null, candidateYears: number | null): number {
  if (requiredYears === null || requiredYears <= 0) return 1;
  const gap = Math.max(0, requiredYears - (candidateYears ?? 0));
  return Math.exp(-(gap * gap) / (2 * EXP_SIGMA_YEARS * EXP_SIGMA_YEARS));
}

/** BM25 normalised by the best BM25 in the result set. */
export function lexical(bm25: number, maxBm25: number): number {
  return maxBm25 > 0 ? clip(bm25 / maxBm25) : 0;
}

// --- Score ------------------------------------------------------------------------------------

export interface Components {
  sem: number;
  semCosine: number;
  cov: number;
  exp: number;
  lex: number;
  gate: number;
}

export interface ScoreInput {
  chunks: readonly (readonly number[])[];
  jobEmbedding: readonly number[];
  requirements: readonly Requirement[];
  skills: ReadonlyMap<string, CandidateSkill>;
  requiredYears: number | null;
  candidateYears: number | null;
  bm25: number;
  maxBm25: number;
}

export interface ScoreResult {
  score: number;
  band: Band;
  components: Components;
  skills: SkillAssessment[];
}

export function combine(c: Components, w: Weights, availability = 1): number {
  assertWeights(w);
  const linear = w.sem * c.sem + w.cov * c.cov + w.exp * c.exp + w.lex * c.lex;
  return clip(c.gate * linear * availability);
}

export function scoreCandidate(
  input: ScoreInput,
  weights: Weights,
  options: ScoringOptions = {},
): ScoreResult {
  const s = sem(input.chunks, input.jobEmbedding);
  const assessed = input.requirements.map((r) => assessSkill(r, input.skills, options));
  const components: Components = {
    sem: s.value,
    semCosine: s.cosine,
    cov: coverage(assessed),
    exp: experience(input.requiredYears, input.candidateYears),
    lex: lexical(input.bm25, input.maxBm25),
    gate: mustHaveGate(assessed),
  };
  const score = combine(components, weights, options.availability ?? 1);
  return { score, band: band(score), components, skills: assessed };
}
