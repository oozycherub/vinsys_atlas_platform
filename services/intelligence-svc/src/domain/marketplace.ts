/**
 * Job-to-employee matching for the marketplace (PRD §2.5(iv)): the Module 1 formula from
 * @atlas/scoring with unvalidated skills at 50%, multiplied by the availability factor A:
 *
 *   Score_internal(e, o) = Score(e, o) · A(e, o)
 *
 * The marketplace has no BM25 index, so LEX carries no weight; without embeddings (an employee
 * with no profile chunks, or the embedding service down) SEM's weight moves to COV and the
 * explanation says so. A role linked to a requisition uses matching-svc's score for it instead,
 * so hiring and mobility rank an employee the same way (ADR-0009 §4).
 */
import {
  type CandidateSkill,
  type Requirement,
  scoreCandidate,
  type Weights,
} from '@atlas/scoring';
import { type Availability, availability, type AvailabilityInput } from './availability';
import { STALE_AFTER_HOURS } from './opportunity';
import { readiness, type SkillRequirement } from './readiness';

export const MARKETPLACE_WEIGHTS: Weights = { sem: 0.4, cov: 0.45, exp: 0.15, lex: 0 };
export const NO_SEMANTIC_WEIGHTS: Weights = { sem: 0, cov: 0.85, exp: 0.15, lex: 0 };
export const UNVALIDATED_FACTOR = 0.5;

export interface EmployeeSkill {
  proficiency: number;
  validated: boolean;
}

export interface MatchInput {
  requirements: readonly (SkillRequirement & { must_have: boolean })[];
  related: ReadonlyMap<string, readonly { skillId: string; rho: number }[]>;
  skills: ReadonlyMap<string, EmployeeSkill>;
  /** The employee's closest profile chunks and the opportunity's embedding; null without. */
  semantic: { chunks: readonly (readonly number[])[]; job: readonly number[] } | null;
  availability: AvailabilityInput;
  /** matching-svc's score for the linked requisition, when there is one. */
  requisitionScore: number | null;
  sourceSyncedAt: Date;
  now: Date;
}

export interface MatchExplanation {
  met: string[];
  gaps: { skill_id: string; required: number; proficiency: number }[];
  via_related: { skill_id: string; via: string }[];
  availability: Availability['reasons'];
  peak_load: number;
  semantic: 'used' | 'unavailable';
  source: 'marketplace' | 'requisition';
}

export interface Match {
  score: number;
  availability: number;
  scoreInternal: number;
  readiness: number;
  lowConfidence: boolean;
  stale: boolean;
  explanation: MatchExplanation;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function matchEmployee(input: MatchInput): Match {
  const requirements: Requirement[] = input.requirements.map((r) => ({
    skillId: r.skill_id,
    weight: r.weight,
    target: r.target_proficiency,
    mustHave: r.must_have,
    related: input.related.get(r.skill_id) ?? [],
  }));
  const skills = new Map<string, CandidateSkill>(
    [...input.skills].map(([id, s]) => [
      id,
      { proficiency: s.proficiency, validated: s.validated },
    ]),
  );
  const semantic = input.semantic !== null && input.semantic.chunks.length > 0;
  const result = scoreCandidate(
    {
      chunks: semantic ? (input.semantic?.chunks ?? []) : [],
      jobEmbedding: input.semantic?.job ?? [],
      requirements,
      skills,
      requiredYears: null,
      candidateYears: null,
      bm25: 0,
      maxBm25: 0,
    },
    semantic ? MARKETPLACE_WEIGHTS : NO_SEMANTIC_WEIGHTS,
    { unvalidatedFactor: UNVALIDATED_FACTOR },
  );
  const a = availability(input.availability);
  const score = input.requisitionScore ?? result.score;
  const fit = readiness(
    input.requirements,
    new Map([...input.skills].map(([id, s]) => [id, s.proficiency])),
  );
  const validated = input.requirements.some((r) => input.skills.get(r.skill_id)?.validated);
  const ageHours = (input.now.getTime() - input.sourceSyncedAt.getTime()) / 3_600_000;
  return {
    score: round4(score),
    availability: round4(a.factor),
    scoreInternal: round4(score * a.factor),
    readiness: round4(fit.readiness),
    lowConfidence: input.requirements.length > 0 && !validated,
    stale: ageHours > STALE_AFTER_HOURS,
    explanation: {
      met: result.skills.filter((s) => s.ratio >= 1).map((s) => s.skillId),
      gaps: result.skills
        .filter((s) => s.ratio < 1)
        .map((s) => ({
          skill_id: s.skillId,
          required: s.required,
          proficiency: round4(s.own ?? 0),
        })),
      via_related: result.skills
        .filter((s) => s.via !== null)
        .map((s) => ({ skill_id: s.skillId, via: s.via?.skillId ?? '' })),
      availability: a.reasons,
      peak_load: a.peakLoad,
      semantic: semantic ? 'used' : 'unavailable',
      source: input.requisitionScore === null ? 'marketplace' : 'requisition',
    },
  };
}
