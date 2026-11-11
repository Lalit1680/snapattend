import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fire-on-demand actions: submits, overrides, invites, uploads.
 *
 *     const save = useAsync((payload) => SubjectsAPI.create(payload), {
 *       onSuccess: () => toast.success('Subject created.'),
 *     });
 *     const created = await save.run(payload);
 *     if (!created) return;            // save.error holds the ApiError
 *
 * `run` never rejects. It resolves with the awaited value on success and with
 * `undefined` on failure, leaving the ApiError in `error`. Every form in the app
 * calls it from an onSubmit handler, where an unhandled rejection would surface
 * as a console error and a half-submitted form.
 */
export function useAsync(fn, { onSuccess, onError } = {}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const mountedRef = useRef(true);
  const fnRef = useRef(fn);
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    fnRef.current = fn;
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  });

  const run = useCallback(async (...args) => {
    setLoading(true);
    setError(null);
    try {
      const value = await fnRef.current(...args);
      // A submit that navigates away resolves into an unmounted component: skip
      // the state writes and the callbacks, but still hand the value back so an
      // awaiting parent can act on it.
      if (mountedRef.current) {
        setData(value);
        setLoading(false);
        if (onSuccessRef.current) onSuccessRef.current(value);
      }
      return value;
    } catch (err) {
      if (mountedRef.current) {
        setError(err);
        setLoading(false);
        if (onErrorRef.current) onErrorRef.current(err);
      }
      return undefined;
    }
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return { run, loading, error, data, reset };
}

export default useAsync;
