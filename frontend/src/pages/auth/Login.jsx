import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { Alert, Button, Input, LoadingBlock } from '../../components/ui/index.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useCountdown } from '../../hooks/useCountdown.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { ErrorCode } from '../../lib/constants.js';
import { pluralize } from '../../lib/format.js';

const EMPTY_FORM = { email: '', password: '' };

/** The same lockup the sidebar uses, so the product looks like one product. */
const BRAND_MARK = (
  <svg
    viewBox="0 0 24 24"
    width={22}
    height={22}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="9" r="4" />
    <path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" />
  </svg>
);

/**
 * Where to land after signing in, from `?next=`.
 *
 * `ProtectedRoute` writes this parameter, but anyone can, so it is attacker
 * controlled by definition. Only a same-document path is safe: `//evil.example`
 * and `/\evil.example` are both read as protocol-relative absolute URLs by
 * browsers, which would turn a genuine SnapAttend sign-in link into a redirect to a
 * phishing page. Anything that is not plainly a path is discarded rather than
 * repaired.
 */
function safeNext(raw) {
  const value = String(raw || '').trim();
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

/**
 * `clean_email` rejects a malformed address as a 422 carrying
 * `details.field: "email"`, with the message on the envelope. It is the only
 * field-level failure login can produce — `require()`'s missing-fields list
 * cannot fire, because both inputs are checked here before the request — so it
 * belongs under the input rather than in the banner above the form.
 */
function emailErrorFrom(err) {
  return err.details && err.details.field === 'email' ? err.message : null;
}

/**
 * The line `error.message` does not carry.
 *
 * The 401 is deliberately one message for an unknown address, a wrong password
 * and a dormant account, so this explains the vagueness instead of guessing past
 * it. The two 403s are the opposite: they name a specific situation, and each has
 * a different way out.
 */
function followUp(err) {
  if (err.code === ErrorCode.ACCOUNT_DISABLED) {
    return (
      <>
        Nothing typed here will change that — only an administrator at your institution can
        enable the account again. A different account still signs in on this device.
      </>
    );
  }
  if (err.code === ErrorCode.ACCOUNT_NOT_ACTIVATED) {
    return (
      <>
        You were invited but never set a password, so there is nothing here to check yet. The
        one-time link in that email is what sets one, and it carries the token that identifies
        you — <Link to="/accept-invite">the invite page</Link> opened without that token can only
        tell you the same thing. Ask your administrator to send the invitation again if the email
        has gone.
      </>
    );
  }
  if (err.code === ErrorCode.RATE_LIMITED) {
    return <>Sign-in allows ten attempts a minute and sixty an hour.</>;
  }
  if (err.isAuth) {
    return (
      <>
        That one message covers both an unknown address and a wrong password. Check for a stray
        space and that Caps Lock is off, then <Link to="/forgot-password">reset your password</Link>{' '}
        if it still refuses.
      </>
    );
  }
  return null;
}

function validate(values) {
  const problems = {};
  if (!values.email.trim()) {
    problems.email = 'Enter your email address.';
  }
  if (!values.password) {
    problems.password = 'Enter your password.';
  }
  return problems;
}

/** `/login` — the way in for everyone whose account already has a password. */
export default function Login() {
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next'));

  const navigate = useNavigate();
  const { login, homePath, initializing } = useAuth();

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [cooldownUntil, setCooldownUntil] = useState(null);
  const { secondsLeft } = useCountdown(cooldownUntil);

  useDocumentTitle('Sign in');

  const submit = useAsync((email, password) => login(email, password), {
    onSuccess: () => {
      // Imperative and synchronous. The render that follows is the one where
      // PublicOnlyRoute sees a session and sends the user to their role home,
      // and it unmounts this page — a redirect fired from an effect would never
      // run, and `?next=` would be silently dropped. `replace` keeps the Back
      // button from returning to a form that has already been passed through.
      navigate(next || homePath(), { replace: true });
    },
    onError: (err) => {
      const emailProblem = emailErrorFrom(err);
      if (emailProblem) {
        setErrors({ email: emailProblem });
        return;
      }
      if (err.code === ErrorCode.RATE_LIMITED && err.retryAfter) {
        setCooldownUntil(new Date(Date.now() + err.retryAfter * 1000).toISOString());
      }
      setBanner(err);
    },
  });

  const cooling = secondsLeft > 0;

  const update = (name) => (event) => {
    const { value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    // Retract the message as soon as the field is being fixed; leaving it up
    // while the user types reads as "still wrong".
    setErrors((current) => (current[name] ? { ...current, [name]: null } : current));
  };

  const onSubmit = (event) => {
    event.preventDefault();
    const problems = validate(form);
    setErrors(problems);
    setBanner(null);
    if (Object.keys(problems).length > 0) return;
    submit.run(form.email.trim(), form.password);
  };

  if (initializing) {
    return (
      <div className="auth-shell">
        <div className="auth-panel">
          <div className="auth-card">
            <LoadingBlock label="Restoring your session…" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      {/* Hidden on a phone: the sign-in form is the only thing a visitor came
          for, and the card's own heading carries the product name. */}
      <aside className="auth-aside hide-sm">
        <div className="auth-aside-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              {BRAND_MARK}
            </span>
            <span className="brand-name">SnapAttend</span>
          </div>

          <p className="auth-sub">
            Attendance for a room of forty in about the time it takes to photograph it.
          </p>

          <div className="stack stack-sm">
            <p className="auth-feature">
              One photo marks the whole room, and any face the match is unsure about goes to a
              review queue instead of being guessed at.
            </p>
            <p className="auth-feature">
              The self check-in code rotates every thirty seconds, so a screenshot forwarded to
              someone at home is already stale.
            </p>
            <p className="auth-feature">
              A teacher can always correct the machine — with a reason, recorded in the audit log.
            </p>
          </div>
        </div>
      </aside>

      <div className="auth-panel">
        <div className="auth-card">
          {/* Mounted in every state so an in-flight submit is announced from a
              region that already existed. The banner below carries role="alert"
              of its own, so this one stays quiet once the request settles. */}
          <p className="sr-only" aria-live="polite">
            {submit.loading ? 'Signing you in…' : ''}
          </p>

          <div className="stack">
            <div className="auth-header">
              <h1 className="auth-title">Sign in to SnapAttend</h1>
              <p className="auth-sub">
                Use the email address your institution registered. Students, teachers and
                administrators all sign in here.
              </p>
            </div>

            {banner ? (
              <Alert tone="danger" title={banner.message}>
                {followUp(banner)}
              </Alert>
            ) : null}

            {/* noValidate: the two checks in `validate` render under the input
                that failed, and the browser's native bubble would pre-empt them
                with a vaguer message from a different visual language. */}
            <form className="stack" onSubmit={onSubmit} noValidate>
              <Input
                label="Email address"
                type="email"
                name="email"
                autoComplete="email"
                autoFocus
                required
                value={form.email}
                error={errors.email}
                onChange={update('email')}
              />

              <Input
                label="Password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={form.password}
                error={errors.password}
                onChange={update('password')}
              />

              <p className="small text-right">
                <Link to="/forgot-password">Forgot your password?</Link>
              </p>

              <Button type="submit" block loading={submit.loading} disabled={cooling}>
                Sign in
              </Button>

              {cooling ? (
                <p className="small muted">
                  Too many attempts — try again in {pluralize(secondsLeft, 'second')}.
                </p>
              ) : null}
            </form>

            <p className="auth-footer small faint">
              Registering an institution for the first time?{' '}
              <Link to="/register">Create an institution</Link>. Every other account arrives by
              invitation from an administrator.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
