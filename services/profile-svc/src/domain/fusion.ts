import { type SkillEvidenceSource } from '@atlas/contracts';

/** One proficiency observation (PRD §2.5(ii)). */
export interface Evidence {
  readonly source: SkillEvidenceSource;
  /** p_k on the 0–5 scale. */
  readonly proficiency: number;
  /** c_k in [0, 1]. */
  readonly confidence: number;
  readonly observedAt: Date;
  readonly validUntil: Date | null;
}

export interface SourcePolicy {
  /** W_source. */
  weight: number;
  /** H_source in months. */
  halfLifeMonths: number;
}

/** The PRD "Skill Validation Weightage" table; tenants may override it (see README). */
export const DEFAULT_POLICY: Readonly<Record<SkillEvidenceSource, SourcePolicy>> = {
  assessment: { weight: 1.0, halfLifeMonths: 24 },
  certification: { weight: 0.8, halfLifeMonths: 36 },
  manager: { weight: 0.7, halfLifeMonths: 12 },
  ai_interview: { weight: 0.7, halfLifeMonths: 18 },
  multi_rater: { weight: 0.6, halfLifeMonths: 12 },
  project_inference: { weight: 0.5, halfLifeMonths: 18 },
  resume_inference: { weight: 0.4, halfLifeMonths: 24 },
  learning_completion: { weight: 0.35, halfLifeMonths: 18 },
  self: { weight: 0.3, halfLifeMonths: 12 },
};

/** Sources that can validate a skill (PRD §2.5(ii)). */
export const VERIFIED_SOURCES: readonly SkillEvidenceSource[] = [
  'assessment',
  'certification',
  'ai_interview',
  'manager',
];
export const VALIDATION_MIN_CONFIDENCE = 0.6;
/** |self − assessment| at or above this raises calibration_needed. */
export const CALIBRATION_GAP = 2;

const MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;

export interface FusedSkill {
  proficiency: number;
  isValidated: boolean;
  calibrationNeeded: boolean;
  evidenceCount: number;
}

function expired(e: Evidence, now: Date): boolean {
  return e.validUntil !== null && e.validUntil.getTime() <= now.getTime();
}

/**
 * p(s) = Σ W_k·c_k·d_k·p_k / Σ W_k·c_k·d_k with d_k = 0.5^(age_months / H_source).
 * Expired evidence weighs 0 (certifications after expiry). Returns null when no evidence has
 * any weight left, so the caller removes the current row.
 */
export function fuse(
  evidence: readonly Evidence[],
  now: Date,
  policy: Readonly<Record<SkillEvidenceSource, SourcePolicy>> = DEFAULT_POLICY,
): FusedSkill | null {
  let numerator = 0;
  let denominator = 0;
  for (const e of evidence) {
    if (expired(e, now)) continue;
    const { weight, halfLifeMonths } = policy[e.source];
    const ageMonths = Math.max(0, now.getTime() - e.observedAt.getTime()) / MONTH_MS;
    const w = weight * e.confidence * 0.5 ** (ageMonths / halfLifeMonths);
    numerator += w * e.proficiency;
    denominator += w;
  }
  if (denominator <= 0) return null;
  const latest = (source: SkillEvidenceSource): Evidence | undefined =>
    evidence
      .filter((e) => e.source === source)
      .reduce<Evidence | undefined>(
        (a, b) => (!a || b.observedAt > a.observedAt ? b : a),
        undefined,
      );
  const self = latest('self');
  const assessment = latest('assessment');
  return {
    proficiency: Math.round((numerator / denominator) * 100) / 100,
    isValidated: evidence.some(
      (e) =>
        VERIFIED_SOURCES.includes(e.source) &&
        e.confidence >= VALIDATION_MIN_CONFIDENCE &&
        !expired(e, now),
    ),
    calibrationNeeded:
      self !== undefined &&
      assessment !== undefined &&
      Math.abs(self.proficiency - assessment.proficiency) >= CALIBRATION_GAP,
    evidenceCount: evidence.length,
  };
}
