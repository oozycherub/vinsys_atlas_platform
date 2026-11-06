/**
 * Career paths (PRD §2.5(v)): TRANSITIONS_TO edges from the employee's profile up to depth 3,
 * typed by the first edge's type, with readiness, gaps and recommended learning: catalogue items
 * covering the largest weighted gap per hour (greedy weighted set cover).
 */
import { type SkillGap } from './readiness';

export type TransitionType = 'vertical' | 'horizontal' | 'diagonal';

export interface Transition {
  from: string;
  to: string;
  type: TransitionType;
  typicalMonths: number | null;
}

export interface PathStep {
  profileId: string;
  type: TransitionType;
  typicalMonths: number | null;
}

export const MAX_DEPTH = 3;

/** Every simple path from `start` (no profile twice), shortest first; one path per target. */
export function enumeratePaths(start: string, transitions: readonly Transition[]): PathStep[][] {
  const out = new Map<string, PathStep[]>();
  let frontier: PathStep[][] = [[]];
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const next: PathStep[][] = [];
    for (const path of frontier) {
      const at = path.at(-1)?.profileId ?? start;
      const seen = new Set([start, ...path.map((p) => p.profileId)]);
      for (const t of transitions.filter((x) => x.from === at && !seen.has(x.to))) {
        const extended = [
          ...path,
          { profileId: t.to, type: t.type, typicalMonths: t.typicalMonths },
        ];
        if (!out.has(t.to)) out.set(t.to, extended);
        next.push(extended);
      }
    }
    frontier = next;
  }
  return [...out.values()];
}

/** The path's type: vertical only if every step is; horizontal if every step is; else diagonal. */
export function pathType(steps: readonly PathStep[]): TransitionType {
  if (steps.every((s) => s.type === 'vertical')) return 'vertical';
  if (steps.every((s) => s.type === 'horizontal')) return 'horizontal';
  return 'diagonal';
}

export interface LearningItem {
  item_id: string;
  title: string;
  skill_ids: readonly string[];
  duration_hours: number;
}

export interface Recommendation {
  items: LearningItem[];
  hours: number;
  /** Gap skills no catalogue item covers. */
  uncovered: string[];
}

/** Greedy weighted set cover: repeatedly take the item with the most uncovered w·gap per hour. */
export function recommendLearning(
  gaps: readonly SkillGap[],
  catalogue: readonly LearningItem[],
  limit = 5,
): Recommendation {
  const open = new Map(gaps.filter((g) => g.gap > 0).map((g) => [g.skill_id, g.weight * g.gap]));
  const chosen: LearningItem[] = [];
  const pool = [...catalogue];
  while (open.size > 0 && chosen.length < limit) {
    let best: { item: LearningItem; value: number } | null = null;
    for (const item of pool) {
      const covered = item.skill_ids.reduce((s, id) => s + (open.get(id) ?? 0), 0);
      const value = covered / item.duration_hours;
      if (covered > 0 && (best === null || value > best.value)) best = { item, value };
    }
    if (best === null) break;
    chosen.push(best.item);
    pool.splice(pool.indexOf(best.item), 1);
    for (const id of best.item.skill_ids) open.delete(id);
  }
  return {
    items: chosen,
    hours: chosen.reduce((s, i) => s + i.duration_hours, 0),
    uncovered: [...open.keys()],
  };
}
