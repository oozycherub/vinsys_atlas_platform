/**
 * Gap and readiness (PRD §2.5(iii)), exactly as specified and pinned by the shared golden file
 * packages/contracts/fixtures/readiness-golden.json (intelligence-ml implements the same):
 *
 *   gap_s          = max(0, p_req(s) − p(s))
 *   role_gap%(e,j) = Σ_s w_s · gap_s / Σ_s w_s · p_req(s)   → High > 50%, Medium 20–50%, Low < 20%
 *   readiness(e,j) = 1 − role_gap%(e,j)
 */
export interface SkillRequirement {
  skill_id: string;
  weight: number;
  target_proficiency: number;
  must_have?: boolean;
}

export interface SkillGap {
  skill_id: string;
  weight: number;
  required: number;
  proficiency: number;
  gap: number;
}

export type GapBand = 'high' | 'medium' | 'low';

export interface Readiness {
  roleGapPct: number;
  readiness: number;
  band: GapBand;
  gaps: SkillGap[];
}

export function gapBand(roleGapPct: number): GapBand {
  if (roleGapPct > 0.5) return 'high';
  if (roleGapPct >= 0.2) return 'medium';
  return 'low';
}

export function readiness(
  requirements: readonly SkillRequirement[],
  proficiencies: ReadonlyMap<string, number>,
): Readiness {
  let gapSum = 0;
  let reqSum = 0;
  const gaps = requirements.map((r) => {
    const p = proficiencies.get(r.skill_id) ?? 0;
    const gap = Math.max(0, r.target_proficiency - p);
    gapSum += r.weight * gap;
    reqSum += r.weight * r.target_proficiency;
    return {
      skill_id: r.skill_id,
      weight: r.weight,
      required: r.target_proficiency,
      proficiency: p,
      gap,
    };
  });
  const roleGapPct = reqSum > 0 ? Math.min(1, gapSum / reqSum) : 0;
  return { roleGapPct, readiness: 1 - roleGapPct, band: gapBand(roleGapPct), gaps };
}
