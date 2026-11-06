'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/components/providers';
import { announcement, formatClock, remainingAt, type TimerSync } from '@/lib/timer';

/**
 * Accessible countdown: the visible clock is `role="timer"` (not announced every second); a
 * polite live region announces 10, 5 and 1 minutes and 30 seconds left. The server owns the time.
 */
export function Timer({ sync, onExpire }: { sync: TimerSync; onExpire: () => void }) {
  const t = useT();
  const [left, setLeft] = useState(() => remainingAt(sync, Date.now()));
  const [said, setSaid] = useState('');
  const previous = useRef(left);
  const expired = useRef(false);
  useEffect(() => {
    const tick = () => {
      const now = remainingAt(sync, Date.now());
      const a = announcement(previous.current, now);
      if (a) setSaid(a);
      previous.current = now;
      setLeft(now);
      if (now === 0 && !expired.current) {
        expired.current = true;
        onExpire();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sync, onExpire]);
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted">{t('runner.timeLeft')}</span>
      <span
        role="timer"
        aria-label={`${t('runner.timeLeft')} ${formatClock(left)}`}
        className={`font-mono text-lg ${left <= 60 ? 'text-red-700' : ''}`}
      >
        {formatClock(left)}
      </span>
      <span aria-live="polite" className="sr-only">
        {said}
      </span>
    </div>
  );
}
