import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Load-on-mount data fetching.
 *
 *     const { data, error, loading, reload } = useResource(
 *       (signal) => SessionsAPI.live(sessionId, { signal }),
 *       [sessionId],
 *     );
 *
 * `loader` is handed an AbortSignal. Forward it as `{ signal }` to any endpoint
 * that accepts a config (`SessionsAPI.live`, or `get()` from `lib/api.js`
 * directly); the endpoint groups whose helpers take no config simply ignore it
 * and the mounted guard below keeps their late result from landing.
 *
 * `deps` is spread into the effect's dependency array, so a changed id refetches.
 * Keep its length stable across renders — React requires that of every effect.
 *
 * `loading` is true for a reload as well as the first load, and `data` is *not*
 * cleared, so a refreshing table keeps its rows instead of flashing a spinner.
 * Render the first-load block on `loading && !data`.
 */
export function useResource(loader, deps = [], { immediate = true, onSuccess, onError } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(immediate));

  const mountedRef = useRef(true);
  const controllerRef = useRef(null);
  // Callers pass inline arrows; depending on them directly would refetch on
  // every render, so the effect reads the latest through refs instead.
  const loaderRef = useRef(loader);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (controllerRef.current) controllerRef.current.abort();
    };
  }, []);

  useEffect(() => {
    loaderRef.current = loader;
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  });

  const load = useCallback(() => {
    if (controllerRef.current) controllerRef.current.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const isCurrent = () => controllerRef.current === controller;

    setLoading(true);
    setError(null);

    // Promise.resolve() first so a loader that throws synchronously is still
    // reported through `error` rather than escaping the caller.
    return Promise.resolve()
      .then(() => loaderRef.current(controller.signal))
      .then((value) => {
        if (!mountedRef.current || !isCurrent()) return undefined;
        setData(value);
        setLoading(false);
        if (onSuccessRef.current) onSuccessRef.current(value);
        return value;
      })
      .catch((err) => {
        // An aborted request was superseded or the component went away; that is
        // not a failure anyone needs to see.
        if (err && err.code === 'cancelled') return undefined;
        if (!mountedRef.current || !isCurrent()) return undefined;
        setError(err);
        setLoading(false);
        if (onErrorRef.current) onErrorRef.current(err);
        return undefined;
      });
  }, []);

  useEffect(() => {
    if (!immediate) return undefined;
    load();
    return () => {
      if (controllerRef.current) controllerRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, immediate, ...deps]);

  return { data, error, loading, reload: load, setData };
}

export default useResource;
