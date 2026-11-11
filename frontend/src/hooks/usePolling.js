import { useCallback, useEffect, useRef, useState } from 'react';

/** Consecutive failures tolerated before the interval stretches. */
const BACKOFF_AFTER_FAILURES = 3;
const BACKOFF_FACTOR = 3;

/**
 * Interval refetch for the live attendance console.
 *
 *     const live = usePolling(
 *       (signal) => SessionsAPI.live(sessionId, { signal }),
 *       LIVE_POLL_MS,
 *       { enabled: session.status === 'active' },
 *     );
 *
 * `fn` receives an AbortSignal and must forward it as `{ signal }`.
 * `lastUpdatedAt` is a Date, so it feeds `formatRelative`/`formatTime` from
 * `lib/format.js` directly.
 *
 * Four behaviours are deliberate:
 *
 * - The next fetch is a `setTimeout` armed *after* the previous one settles, not a
 *   `setInterval`. A response slower than the interval would otherwise stack
 *   requests behind itself and arrive out of order.
 * - Polling pauses while `document.hidden` and fires immediately when the tab
 *   comes back, so a projector tab left open overnight makes no requests and is
 *   current the moment a teacher looks at it.
 * - After three consecutive failures the interval triples: a backend that is down
 *   gets probed every 9 s instead of hammered every 3 s.
 * - `data` survives a failed poll and `error` is exposed alongside it, so the
 *   console can say "last updated 12s ago, reconnecting" instead of going blank.
 */
export function usePolling(fn, intervalMs, { enabled = true, immediate = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);

  const mountedRef = useRef(true);
  const fnRef = useRef(fn);
  const enabledRef = useRef(enabled);
  const intervalRef = useRef(intervalMs);
  const timerRef = useRef(null);
  const controllerRef = useRef(null);
  // Mirrors `consecutiveErrors`; the scheduler needs the count synchronously,
  // before the state update has been applied.
  const failuresRef = useRef(0);
  // Breaks the schedule -> run -> schedule cycle without recreating callbacks.
  const runRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (controllerRef.current) controllerRef.current.abort();
    };
  }, []);

  useEffect(() => {
    fnRef.current = fn;
  });

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const abortInFlight = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    clearTimer();
    if (!mountedRef.current || !enabledRef.current) return;
    // Do not arm a timer for a hidden tab: the browser throttles it to minutes
    // and it would fire at an unpredictable moment. visibilitychange resumes.
    if (document.hidden) return;
    const base = Number(intervalRef.current) || 0;
    const delay = failuresRef.current >= BACKOFF_AFTER_FAILURES ? base * BACKOFF_FACTOR : base;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (runRef.current) runRef.current();
    }, delay);
  }, [clearTimer]);

  const run = useCallback(
    async ({ force = false } = {}) => {
      if (!mountedRef.current) return;
      if (!enabledRef.current && !force) return;

      clearTimer();
      abortInFlight();
      const controller = new AbortController();
      controllerRef.current = controller;
      // Only the request that still owns the controller may write state or arm
      // the next tick; a superseded one has to stay silent.
      const isCurrent = () => controllerRef.current === controller;

      setLoading(true);
      try {
        const value = await fnRef.current(controller.signal);
        if (!mountedRef.current || !isCurrent()) return;
        failuresRef.current = 0;
        setConsecutiveErrors(0);
        setData(value);
        setError(null);
        setLastUpdatedAt(new Date());
        setLoading(false);
      } catch (err) {
        if (!mountedRef.current || !isCurrent()) return;
        if (err && err.code === 'cancelled') return;
        failuresRef.current += 1;
        setConsecutiveErrors(failuresRef.current);
        setError(err);
        setLoading(false);
      } finally {
        if (isCurrent()) {
          controllerRef.current = null;
          schedule();
        }
      }
    },
    [abortInFlight, clearTimer, schedule],
  );

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    enabledRef.current = enabled;
    intervalRef.current = intervalMs;

    if (!enabled) {
      clearTimer();
      abortInFlight();
      setLoading(false);
      return undefined;
    }

    if (immediate) run();
    else schedule();

    return () => {
      clearTimer();
      abortInFlight();
    };
  }, [enabled, intervalMs, immediate, run, schedule, clearTimer, abortInFlight]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onVisibilityChange = () => {
      if (document.hidden) {
        // Let an in-flight request finish — its own schedule() will decline to
        // arm the next tick while hidden.
        clearTimer();
        return;
      }
      run();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [enabled, run, clearTimer]);

  const refresh = useCallback(() => run({ force: true }), [run]);

  return { data, error, loading, lastUpdatedAt, refresh, consecutiveErrors };
}

export default usePolling;
