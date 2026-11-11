import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { Alert, Button, Input } from '../../components/ui/index.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useCountdown } from '../../hooks/useCountdown.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { AuthAPI } from '../../lib/api.js';
import { ErrorCode } from '../../lib/constants.js';
import { pluralize } from '../../lib/format.js';

/** `MIN_PASSWORD_LENGTH` from `backend/app/utils/validators.py`. */
const MIN_PASSWORD_LENGTH = 8;

/** Long enough to read the confirmation, short enough not to feel stuck. */
const REDIRECT_MS = 4000;

const EMPTY_FORM = { password: '', confirm: '' };

/**
 * The three ways a reset link arrives dead, all as 400s.
 *
 * `read_reset_token` raises `token_expired` or `token_invalid`; `reset_password`
 * raises `token_used` when the fingerprint in the token no longer matches the
 * stored password hash. None of them can be fixed by retyping a password, so the
 * form is replaced rather than annotated — leaving it up invites the user to
 * spend the remaining nine attempts of a 10/hr budget on a token that is gone.
 */
const DEAD_LINK_CODES = [ErrorCode.TOKEN_USED, ErrorCode.TOKEN_INVALID, ErrorCode.TOKEN_EXPIRED];

/** Why the link died — the part `error.message` does not say. */
function deadLinkCopy(code) {
  if (code === ErrorCode.TOKEN_USED) {
    return 'Each link is tied to the password it was issued against, so it stops working the moment that password changes. If it was not you who used it, request a new link and set a password only you know.';
  }
  if (code === ErrorCode.TOKEN_EXPIRED) {
    return 'Reset links are deliberately short-lived. A fresh one takes a moment to send.';
  }
  return 'It may have expired, been altered on the way through an email client, or belong to an account that no longer exists. Requesting a new one is the fix in every case.';
}

/**
 * `clean_password` reports a rejected password as `details.field: "password"` with
 * the message on the envelope, and `require()` reports a missing one as a *list*
 * in `details.fields`. Neither is the `{name: message}` map `ApiError.fieldErrors`
 * implies, and both concern the same input here.
 */
function passwordErrorFrom(err) {
  const reported = err.fieldErrors || {};
  if (Array.isArray(reported)) {
    return reported.includes('password') ? 'Enter a new password.' : null;
  }
  if (typeof reported.password === 'string' && reported.password) return reported.password;
  return err.details && err.details.field === 'password' ? err.message : null;
}

function validate(values) {
  const problems = {};
  if (values.password.length < MIN_PASSWORD_LENGTH) {
    problems.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (values.confirm !== values.password) {
    problems.confirm = 'The two passwords do not match.';
  }
  return problems;
}

/**
 * `/reset-password?token=…` — the target of the link in the reset email.
 *
 * The endpoint returns no tokens, so a successful reset signs nobody in; the only
 * next step is the sign-in page with the new password.
 */
export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  // Trimmed because a link wrapped by an email client can arrive with trailing
  // whitespace, which would fail the signature check for no good reason.
  const token = (searchParams.get('token') || '').trim();

  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [deadLink, setDeadLink] = useState(null);
  const [cooldownUntil, setCooldownUntil] = useState(null);
  const { secondsLeft } = useCountdown(cooldownUntil);

  useDocumentTitle('Reset password');

  const submit = useAsync((password) => AuthAPI.resetPassword(token, password), {
    onSuccess: () => {
      setForm(EMPTY_FORM);
      setErrors({});
    },
    onError: (err) => {
      if (DEAD_LINK_CODES.includes(err.code)) {
        setDeadLink(err);
        return;
      }
      const problem = passwordErrorFrom(err);
      if (problem) {
        setErrors({ password: problem });
        return;
      }
      if (err.code === ErrorCode.RATE_LIMITED && err.retryAfter) {
        setCooldownUntil(new Date(Date.now() + err.retryAfter * 1000).toISOString());
      }
      toast.notifyError(err, 'Could not set your new password.');
    },
  });

  const done = Boolean(submit.data && submit.data.ok);
  const cooling = secondsLeft > 0;

  useEffect(() => {
    if (!done) return undefined;
    // Cleared on unmount so the manual link below cannot be overtaken by a
    // navigation fired from a page the user already left.
    const handle = setTimeout(() => navigate('/login', { replace: true }), REDIRECT_MS);
    return () => clearTimeout(handle);
  }, [done, navigate]);

  const update = (name) => (event) => {
    const { value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => (current[name] ? { ...current, [name]: null } : current));
  };

  const onSubmit = (event) => {
    event.preventDefault();
    const problems = validate(form);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    submit.run(form.password);
  };

  let content;
  if (!token) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">This reset link is incomplete</h1>
          <p className="auth-sub">
            The address you arrived at carries no reset token, so there is nothing here to
            verify.
          </p>
        </div>

        <Alert tone="danger" title="Nothing to reset">
          Some email clients wrap a long link across two lines, and copying only the first line
          drops the token. Open the link from the email itself, or send yourself a new one.
        </Alert>

        <Link className="btn btn-primary btn-block" to="/forgot-password">
          Request a new reset link
        </Link>

        <p className="auth-footer small faint">
          Remembered it after all? <Link to="/login">Sign in</Link>.
        </p>
      </>
    );
  } else if (deadLink) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">This link no longer works</h1>
        </div>

        <Alert tone="danger" title={deadLink.message}>
          {deadLinkCopy(deadLink.code)}
        </Alert>

        <Link className="btn btn-primary btn-block" to="/forgot-password">
          Request a new reset link
        </Link>

        <p className="auth-footer small faint">
          Nothing was changed by this attempt. <Link to="/login">Back to sign in</Link>.
        </p>
      </>
    );
  } else if (done) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">Password updated</h1>
          <p className="auth-sub">{submit.data.message}</p>
        </div>

        <Alert tone="success" title="Sign in with your new password">
          Resetting does not sign you in on this device. Taking you to the sign-in page…
        </Alert>

        <Link className="btn btn-primary btn-block" to="/login">
          Go to sign in now
        </Link>
      </>
    );
  } else {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">Choose a new password</h1>
          <p className="auth-sub">
            This link works once. Setting a password here does not sign you in — you will use it
            on the sign-in screen straight afterwards.
          </p>
        </div>

        {user ? (
          <Alert tone="info" title="You are already signed in on this device">
            The link resets whichever account it was issued for, which is not necessarily{' '}
            {user.email}. Signing in again afterwards is the only way to be certain which
            account changed.
          </Alert>
        ) : null}

        {/* noValidate: the two checks in `validate` render under the input that
            failed, and the browser's native bubble would pre-empt them with a
            vaguer message. */}
        <form className="stack" onSubmit={onSubmit} noValidate>
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            hint={`${MIN_PASSWORD_LENGTH} characters or more.`}
            value={form.password}
            error={errors.password}
            onChange={update('password')}
          />
          <Input
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            value={form.confirm}
            error={errors.confirm}
            onChange={update('confirm')}
          />

          <Button type="submit" block loading={submit.loading} disabled={cooling}>
            Set new password
          </Button>

          {cooling ? (
            <p className="small muted">
              Too many attempts — try again in {pluralize(secondsLeft, 'second')}.
            </p>
          ) : null}
        </form>

        <p className="auth-footer small faint">
          Did not ask for this? Your password only changes when this form is submitted, so the
          link can be ignored. <Link to="/login">Back to sign in</Link>.
        </p>
      </>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-card">
          {/* Mounted in every state so an in-flight submit is announced from a
              region that already existed. The outcome panels carry their own
              roles, so this one stays quiet once the request settles. */}
          <p className="sr-only" aria-live="polite">
            {submit.loading ? 'Saving your new password…' : ''}
          </p>

          <div className="stack">{content}</div>
        </div>
      </div>
    </div>
  );
}
