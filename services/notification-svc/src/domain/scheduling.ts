/**
 * Quiet hours and the daily cap (Component Prompt 13 §2). Both defer non-transactional email;
 * neither drops it.
 */
export interface QuietHours {
  startMin: number;
  endMin: number;
  timeZone: string;
}

/** Minutes since local midnight in `timeZone` (an invalid zone falls back to UTC). */
export function localMinutes(at: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

export function inQuietHours(at: Date, q: QuietHours): boolean {
  if (q.startMin === q.endMin) return false;
  const m = localMinutes(at, q.timeZone);
  return q.startMin < q.endMin ? m >= q.startMin && m < q.endMin : m >= q.startMin || m < q.endMin;
}

/** `at` itself outside quiet hours; otherwise the minute the window ends. */
export function nextSendTime(at: Date, q: QuietHours | null): Date {
  if (!q || !inQuietHours(at, q)) return at;
  const m = localMinutes(at, q.timeZone);
  const wait = (q.endMin - m + 1440) % 1440;
  const next = new Date(at.getTime() + wait * 60_000);
  next.setUTCSeconds(0, 0);
  return next;
}

/** With `sentTimes` (the last 24 h of capped sends), when the next one may go. */
export function nextUnderCap(at: Date, sentTimes: readonly Date[], maxPerDay: number): Date {
  const window = sentTimes
    .filter((t) => at.getTime() - t.getTime() < 86_400_000)
    .sort((a, b) => a.getTime() - b.getTime());
  if (window.length < maxPerDay) return at;
  const oldest = window[window.length - maxPerDay] as Date;
  return new Date(oldest.getTime() + 86_400_000);
}

/** Email retries: 1 min doubling, 6 attempts in all. */
export const MAX_EMAIL_ATTEMPTS = 6;
export function emailRetryDelayMs(attempt: number): number {
  return 60_000 * 2 ** Math.max(0, attempt - 1);
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
