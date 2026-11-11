/**
 * Transient notifications.
 *
 * The stack lives at the provider so a toast survives the navigation that
 * triggered it — "Session ended" is raised by the page that is about to unmount.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ErrorCode } from '../lib/constants.js';
import { pluralize } from '../lib/format.js';

const ToastContext = createContext(null);

const DEFAULT_DURATION = 5000;
/** Errors carry more to read than a success line, and often a next action. */
const ERROR_DURATION = 8000;
/** More than this and the toasts, not the page, become the interface. */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const sequence = useRef(0);

  useEffect(
    () => () => {
      timers.current.forEach((handle) => clearTimeout(handle));
      timers.current.clear();
    },
    [],
  );

  const dismiss = useCallback((id) => {
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((tone, message, { title, duration } = {}) => {
    sequence.current += 1;
    const id = `toast-${sequence.current}`;
    const fallbackDuration = tone === 'danger' ? ERROR_DURATION : DEFAULT_DURATION;
    const ttl =
      duration === undefined || duration === null ? fallbackDuration : Number(duration) || 0;

    setToasts((current) =>
      // Drop the oldest rather than growing: a loop of failing requests must not
      // bury the page it is failing on. A trimmed toast's timer is left to fire
      // into the void, which costs one no-op filter.
      [...current, { id, tone, title: title || null, message: message ?? '' }].slice(-MAX_VISIBLE),
    );

    if (ttl > 0) {
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }, ttl),
      );
    }
    return id;
  }, []);

  const success = useCallback((message, options) => push('success', message, options), [push]);
  const info = useCallback((message, options) => push('info', message, options), [push]);
  const warn = useCallback((message, options) => push('warn', message, options), [push]);
  const error = useCallback((message, options) => push('danger', message, options), [push]);

  const notifyError = useCallback(
    (err, fallback) => {
      const hints = [];
      if (err && err.code === ErrorCode.RATE_LIMITED) {
        hints.push(
          err.retryAfter
            ? `Try again in ${pluralize(err.retryAfter, 'second')}.`
            : 'Try again in a moment.',
        );
      }
      if (err && err.isNetwork) {
        hints.push('You may be offline, or the SnapAttend server is not running.');
      }
      const message = (err && err.message) || fallback || 'Something went wrong.';
      return push('danger', hints.length ? `${message} ${hints.join(' ')}` : message);
    },
    [push],
  );

  // Every function above is stable, so this value never changes identity and
  // consumers do not re-render when a toast appears. Pages rely on that: these
  // land in useEffect dependency arrays.
  const value = useMemo(
    () => ({ success, info, warn, error, notifyError, dismiss }),
    [success, info, warn, error, notifyError, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-atomic="false" so a new toast is announced on its own instead of
          re-reading the whole stack. No per-toast role: a nested live region
          would make some screen readers announce the same text twice. */}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast is-${toast.tone}`}>
            <div className="toast-body">
              {toast.title ? <div className="alert-title">{toast.title}</div> : null}
              <div>{toast.message}</div>
            </div>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error(
      'useToast() was called outside <ToastProvider>. Wrap the tree in src/main.jsx.',
    );
  }
  return context;
}

export default ToastProvider;
