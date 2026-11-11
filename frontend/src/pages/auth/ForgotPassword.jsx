import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Button, CopyField, Input } from '../../components/ui/index.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useCountdown } from '../../hooks/useCountdown.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { AuthAPI } from '../../lib/api.js';
import { ErrorCode } from '../../lib/constants.js';
import { pluralize } from '../../lib/format.js';

/**
 * Deliberately looser than `EMAIL_RE` in `backend/app/utils/validators.py` — it
 * only catches the mistakes that are certainly mistakes. The rate limiter runs
 * before the view, so an address the backend rejects as unprocessable still
 * spends one of five requests an hour; a missing "@" is not worth that.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The two shapes a bad address arrives in, both 422s and both about this input.
 *
 * `clean_email` sends `details.field: "email"` with the message on the envelope;
 * `require()` sends a *list* in `details.fields`. Neither is the `{name: message}`
 * map `ApiError.fieldErrors` implies.
 */
function emailErrorFrom(err) {
  const reported = err.fieldErrors || {};
  if (Array.isArray(reported)) {
    return reported.includes('email') ? 'Enter your email address.' : null;
  }
  if (typeof reported.email === 'string' && reported.email) return reported.email;
  return err.details && err.details.field === 'email' ? err.message : null;
}

/**
 * `/forgot-password` — request a reset link.
 *
 * `forgot_password()` answers the same generic message whether or not the address
 * has an account, because anything else lets a stranger test which of ten
 * thousand addresses belongs to a real teacher. This page has to keep that
 * promise: it renders the server's message verbatim and adds nothing that varies
 * with whether the account was found.
 */
export default function ForgotPassword() {
  const { user } = useAuth();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [cooldownUntil, setCooldownUntil] = useState(null);
  const { secondsLeft } = useCountdown(cooldownUntil);

  useDocumentTitle('Forgot password');

  const submit = useAsync((address) => AuthAPI.forgotPassword(address), {
    onError: (err) => {
      const problem = emailErrorFrom(err);
      if (problem) {
        setError(problem);
        return;
      }
      if (err.code === ErrorCode.RATE_LIMITED && err.retryAfter) {
        setCooldownUntil(new Date(Date.now() + err.retryAfter * 1000).toISOString());
      }
      toast.notifyError(err, 'Could not request a reset link.');
    },
  });

  const result = submit.data && submit.data.ok ? submit.data : null;
  // Present only when the server has no SMTP configured, in which case nothing
  // was emailed and the link itself is the only way through.
  const devLink = (result && result.reset_url) || null;
  const cooling = secondsLeft > 0;

  const onChange = (event) => {
    setEmail(event.target.value);
    // Retract the message as soon as the address is being fixed; leaving it up
    // while the user types reads as "still wrong".
    setError((current) => (current ? null : current));
  };

  const onSubmit = (event) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) {
      setError('Enter the email address you sign in with.');
      return;
    }
    if (!LOOKS_LIKE_EMAIL.test(address)) {
      setError('That does not look like an email address.');
      return;
    }
    setError(null);
    submit.run(address);
  };

  // The cooldown survives on purpose: the limit counts requests from this client,
  // not requests for one address, so a second address gets no fresh budget.
  const startOver = () => {
    submit.reset();
    setEmail('');
    setError(null);
  };

  let content;
  if (result) {
    content = (
      <>
        <div className="auth-header">
          {/* Two headings, and neither depends on the account: `reset_url` means
              the server suppresses mail, so "check your inbox" would be a claim
              about an email that was never sent. */}
          <h1 className="auth-title">{devLink ? 'No email was sent' : 'Check your inbox'}</h1>
          <p className="auth-sub">{result.message}</p>
        </div>

        {devLink ? (
          <div className="stack stack-sm">
            <Alert tone="warn" title="This server has no mail server configured">
              So the backend hands the reset link back in the response instead of emailing it.
              That is the documented local-development path, not a fault — with SMTP configured
              the link never leaves the server.
            </Alert>

            <CopyField
              value={devLink}
              label="Reset link"
              hint="Works once: it dies the moment the password changes."
            />

            {/* A plain anchor rather than <Link>: this is an absolute URL built
                from the backend's FRONTEND_URL, which need not be this origin,
                and react-router would resolve it as a relative path. */}
            <a className="btn btn-secondary btn-block" href={devLink}>
              Open the reset link
            </a>
          </div>
        ) : (
          <Alert tone="success" title="If a link is on its way">
            It opens a page where you choose a new password. Links are short-lived and work once,
            so use the newest one if you ask more than a moment apart. Nothing about your account
            changes until you submit that form.
          </Alert>
        )}

        <div className="stack stack-sm">
          <Button variant="secondary" block onClick={startOver}>
            Try a different address
          </Button>
          <p className="small muted text-center">Requested for {email.trim()}</p>
        </div>

        <p className="auth-footer small faint">
          An account that was invited but never activated gets nothing from this — its invite link
          is the way in, and re-sending that is an administrator action.{' '}
          <Link to="/login">Back to sign in</Link>.
        </p>
      </>
    );
  } else {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">Forgot your password</h1>
          <p className="auth-sub">
            Enter the address you sign in with and we will send a link that lets you choose a new
            one.
          </p>
        </div>

        {/* noValidate: the two checks in `onSubmit` render as `.field-error` under
            the input, and the browser's native bubble would pre-empt them. */}
        <form className="stack" onSubmit={onSubmit} noValidate>
          <Input
            label="Email address"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck="false"
            autoFocus
            required
            value={email}
            error={error}
            onChange={onChange}
          />

          <Button type="submit" block loading={submit.loading} disabled={cooling}>
            Email me a reset link
          </Button>

          {cooling ? (
            <p className="small muted">
              Reset requests are limited to five an hour and twenty a day — try again in{' '}
              {pluralize(secondsLeft, 'second')}.
            </p>
          ) : null}
        </form>

        <p className="auth-footer small faint">
          Remembered it? <Link to="/login">Sign in</Link>.
          {user ? (
            <>
              {' '}
              You are already signed in on this device, and changing your password from your{' '}
              <Link to="/account">account</Link> needs no email at all.
            </>
          ) : null}
        </p>
      </>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-card">
          {/* Mounted in both states so an in-flight request is announced from a
              region that already existed. The outcome panels carry their own
              roles, so this one stays quiet once the request settles. */}
          <p className="sr-only" aria-live="polite">
            {submit.loading ? 'Requesting a reset link…' : ''}
          </p>

          <div className="stack">{content}</div>
        </div>
      </div>
    </div>
  );
}
