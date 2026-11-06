/** Cosine thresholds for ANN normalisation (docs/prompts/03-taxonomy-svc.md §6). */
export const ACCEPT_COSINE = 0.82;
export const SUGGEST_COSINE = 0.7;
export const MAX_TERMS = 100;

export type NormalizeMethod = 'alias' | 'ann' | 'none';

export interface NormalizeResult {
  term: string;
  skill_id: string | null;
  confidence: number;
  method: NormalizeMethod;
}

export type AnnDecision =
  | { kind: 'accept'; confidence: number }
  | { kind: 'suggest'; confidence: number }
  | { kind: 'reject'; confidence: number };

/** ≥ 0.82 accept; 0.70–0.82 queue a suggestion and return null; below 0.70 nothing. */
export function decideAnn(cosine: number): AnnDecision {
  const confidence = Math.round(Math.max(0, Math.min(1, cosine)) * 1000) / 1000;
  if (cosine >= ACCEPT_COSINE) return { kind: 'accept', confidence };
  if (cosine >= SUGGEST_COSINE) return { kind: 'suggest', confidence };
  return { kind: 'reject', confidence };
}

/** Candidates for one alias key: tenant skills win over global; more than one winner is ambiguous. */
export function pickAliasMatch<T extends { tenantId: string | null; id: string }>(
  candidates: readonly T[],
): T | null {
  if (candidates.length === 0) return null;
  const tenant = candidates.filter((c) => c.tenantId !== null);
  const pool = tenant.length > 0 ? tenant : candidates;
  const unique = [...new Map(pool.map((c) => [c.id, c])).values()];
  return unique.length === 1 ? (unique[0] ?? null) : null;
}
