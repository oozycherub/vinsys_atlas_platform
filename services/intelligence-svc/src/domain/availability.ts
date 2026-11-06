/**
 * The availability and mobility factor of the internal marketplace (PRD §2.5(iv)):
 *
 *   A = 1[allocation_e(window_o) + required_allocation_o ≤ 100%]      hard (project allocations)
 *     · (1 − 0.3 · [tenure_in_role_e < min_tenure_policy])               soft policy
 *     · 1[e opted in to the marketplace OR o.type = 'project']          consent
 *
 * Dates are ISO calendar days; allocations are half-open [start, end) ranges (end null: open).
 */
export interface Allocation {
  percent: number;
  start: string;
  end: string | null; // exclusive
}

export interface Window {
  start: string;
  end: string | null; // inclusive last day, as entered on an opportunity
}

const after = (a: string, b: string) => a > b;

/** Exclusive end of a window (the day after its last day). */
export function exclusiveEnd(w: Window): string | null {
  if (w.end === null) return null;
  const d = new Date(`${w.end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function overlaps(a: Allocation, start: string, end: string | null): boolean {
  const beginsBeforeEnd = end === null || a.start < end;
  const endsAfterStart = a.end === null || after(a.end, start);
  return beginsBeforeEnd && endsAfterStart;
}

/** The highest total allocation on any day of the window (a step function peaks at a start). */
export function peakLoad(allocations: readonly Allocation[], window: Window): number {
  const end = exclusiveEnd(window);
  const inWindow = allocations.filter((a) => overlaps(a, window.start, end));
  const points = [window.start, ...inWindow.map((a) => a.start).filter((s) => s > window.start)];
  let peak = 0;
  for (const p of points) {
    const load = inWindow
      .filter((a) => a.start <= p && (a.end === null || a.end > p))
      .reduce((s, a) => s + a.percent, 0);
    peak = Math.max(peak, load);
  }
  return peak;
}

export const TENURE_PENALTY = 0.3;

export interface AvailabilityInput {
  allocations: readonly Allocation[];
  window: Window;
  requiredPercent: number;
  tenureInRoleMonths: number | null;
  minTenureMonths: number;
  optedIn: boolean;
  opportunityType: 'role' | 'project' | 'gig';
}

export interface Availability {
  factor: number;
  peakLoad: number;
  reasons: ('overbooked' | 'short_tenure' | 'not_opted_in')[];
}

export function availability(i: AvailabilityInput): Availability {
  const peak = peakLoad(i.allocations, i.window);
  const reasons: Availability['reasons'] = [];
  let factor = 1;
  if (peak + i.requiredPercent > 100) {
    factor = 0;
    reasons.push('overbooked');
  }
  if (i.tenureInRoleMonths !== null && i.tenureInRoleMonths < i.minTenureMonths) {
    factor *= 1 - TENURE_PENALTY;
    reasons.push('short_tenure');
  }
  if (!i.optedIn && i.opportunityType !== 'project') {
    factor = 0;
    reasons.push('not_opted_in');
  }
  return { factor, peakLoad: peak, reasons };
}

/** Whole months between two ISO dates (day-of-month aware). */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
}
