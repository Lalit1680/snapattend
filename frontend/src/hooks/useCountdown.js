import { useEffect, useState } from 'react';
import { toDate } from '../lib/format.js';

function secondsUntil(targetTime) {
  if (targetTime === null) return 0;
  return Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
}

/**
 * Seconds remaining until an ISO timestamp (or Date) — the QR rotation clock.
 *
 * Each tick recomputes from `Date.now()` instead of decrementing a counter.
 * Background tabs have their timers throttled to once a minute, so a decrementing
 * counter would drift and keep claiming a QR code has 20 seconds left long after
 * the backend rotated it.
 *
 * `expired` stays false while `target` is absent: a QR panel whose data has not
 * loaded yet is not expired, and flashing "expired" during the first fetch reads
 * as a real failure.
 */
export function useCountdown(target) {
  const parsed = toDate(target);
  // The effect keys on the epoch number, not the Date/string: callers pass a
  // freshly constructed value every render, which would restart the interval.
  const targetTime = parsed ? parsed.getTime() : null;

  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(targetTime));

  useEffect(() => {
    const initial = secondsUntil(targetTime);
    setSecondsLeft(initial);
    if (targetTime === null || initial <= 0) return undefined;

    const id = setInterval(() => {
      const next = secondsUntil(targetTime);
      setSecondsLeft(next);
      if (next <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [targetTime]);

  return { secondsLeft, expired: targetTime !== null && secondsLeft <= 0 };
}

export default useCountdown;
