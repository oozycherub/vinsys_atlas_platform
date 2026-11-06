/**
 * The server-authoritative timer (Component Prompt 14 §7): the deadline comes from the server, and
 * the local clock is used only through its offset from the server's time at the last sync.
 */
export interface TimerSync {
  /** Seconds left according to the server at `serverTime`. */
  remainingSeconds: number;
  serverTime: string;
  /** Local clock (ms) when that response was received. */
  receivedAt: number;
}

export function remainingAt(sync: TimerSync, localNow: number): number {
  const elapsed = Math.max(0, (localNow - sync.receivedAt) / 1000);
  return Math.max(0, Math.ceil(sync.remainingSeconds - elapsed));
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Thresholds announced to screen readers once each (not every second). */
export const ANNOUNCE_AT = [600, 300, 60, 30] as const;

export function announcement(previous: number, current: number): string | null {
  for (const t of ANNOUNCE_AT)
    if (previous > t && current <= t)
      return t >= 60 ? `${t / 60} minute${t === 60 ? '' : 's'} left` : `${t} seconds left`;
  if (previous > 0 && current === 0) return 'Time is up';
  return null;
}
