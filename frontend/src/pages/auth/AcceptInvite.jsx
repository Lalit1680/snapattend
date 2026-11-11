import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { Alert, Button, ErrorState, Input, LoadingBlock } from '../../components/ui/index.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useCountdown } from '../../hooks/useCountdown.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { useResource } from '../../hooks/useResource.js';
import { AuthAPI } from '../../lib/api.js';
import { ErrorCode, ROLE_LABELS } from '../../lib/constants.js';
import { pluralize } from '../../lib/format.js';

/**
 * `MIN_PASSWORD_LENGTH` from `backend/app/utils/validators.py`. Checking it here
 * matters more than usual: `/api/auth/accept-invite` allows ten attempts an hour,
 * and a password rejected for length still spends one of them.
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Two codes `load_invite` raises that `lib/constants.js` does not carry, because
 * this is the only page that reacts to them. From `backend/app/services/invites.py`.
 */
const INVITE_USED = 'invite_used';
const INVITE_REVOKED = 'invite_revoked';

/**
 * Every way an invitation can be dead. Retyping a password fixes none of them, so
 * the form is replaced rather than annotated — and the 404 belongs here too: the
 * placeholder account is deleted when an administrator revokes an invite.
 */
const DEAD_INVITE_CODES = [
  ErrorCode.TOKEN_INVALID,
  ErrorCode.TOKEN_EXPIRED,
  ErrorCode.NOT_FOUND,
  INVITE_USED,
  INVITE_REVOKED,
];

/** Why the invitation stopped working — the part `error.message` does not say. */
function deadInviteCopy(code) {
  if (code === INVITE_USED) {
    return 'A password has already been set for this account, most likely by you on an earlier visit. Sign in with it instead — an invitation cannot be reissued for an account that is already active.';
  }
  if (code === INVITE_REVOKED) {
    return 'Sending someone a fresh invitation cancels their previous one, so this often just means a newer email is waiting. Check your inbox for a more recent invitation before asking for another.';
  }
  if (code === ErrorCode.TOKEN_EXPIRED) {
    return 'Invitations are deliberately short-lived. Your administrator can send a new one in a couple of clicks.';
  }
  return 'It may have been altered on the way through an email client — long links are often wrapped across two lines — or the account behind it may since have been removed. A new invitation is the fix either way.';
}

/**
 * A read failure the token itself could survive.
 *
 * An unreachable server or a spent 30/hr read budget says nothing about whether
 * the invitation is valid, so those get a retry instead of the dead-link panel.
 */
function isTransient(err) {
  return Boolean(err) && (err.isNetwork || err.code === ErrorCode.RATE_LIMITED);
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
    return reported.includes('password') ? 'Choose a password.' : null;
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
 * `/accept-invite?token=…` — the target of the link in a staff invitation email.
 *
 * The token is validated before the form is rendered, so nobody chooses a password
 * against an invitation that is already spent, cancelled or expired.
 */
export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  // Trimmed because a link wrapped by an email client can arrive with trailing
  // whitespace, which would fail the signature check for no good reason.
  const token = (searchParams.get('token') || '').trim();

  const navigate = useNavigate();
  const { user, acceptInvite, homePath } = useAuth();
  const toast = useToast();

  const [form, setForm] = useState({ name: '', password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [deadInvite, setDeadInvite] = useState(null);
  const [cooldownUntil, setCooldownUntil] = useState(null);
  const { secondsLeft } = useCountdown(cooldownUntil);

  useDocumentTitle('Accept invitation');

  const invite = useResource(() => AuthAPI.readInvite(token), [token], {
    immediate: Boolean(token),
    // The invite carries the name an administrator (or a CSV row) typed; seeding
    // the field from here rather than from render keeps it editable afterwards.
    onSuccess: (context) => setForm((current) => ({ ...current, name: context.name || '' })),
  });

  const submit = useAsync(
    // `acceptInvite` takes only (token, password), so the corrected name cannot be
    // forwarded from here — the endpoint accepts an optional `name`, but widening
    // the context's signature is not this file's call to make.
    (password) => acceptInvite(token, password),
    {
      onSuccess: () => toast.success('Your account is ready.'),
      onError: (err) => {
        // The token can die between rendering this form and submitting it: another
        // tab accepted it, or an administrator revoked it. Nothing here can revive
        // the link, so the form goes away rather than inviting a second attempt.
        if (DEAD_INVITE_CODES.includes(err.code)) {
          setDeadInvite(err);
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
        toast.notifyError(err, 'Could not set your password.');
      },
    },
  );

  const context = invite.data;
  const accepted = submit.data;
  const cooling = secondsLeft > 0;

  // Navigating from an effect rather than from `onSuccess`: the `homePath` that
  // handler closed over is the one from before `acceptInvite` adopted the new
  // session, so an anonymous visitor would be sent to /login. By the time this
  // effect runs the context has re-rendered with the new role.
  useEffect(() => {
    if (!accepted) return;
    // A student still owes face and voice samples before they can be recognised.
    const next = accepted.next_step === 'biometrics' ? '/enroll' : homePath();
    navigate(next, { replace: true });
  }, [accepted, homePath, navigate]);

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

  const readError = invite.error;
  const dead = deadInvite || (readError && !isTransient(readError) ? readError : null);

  let status = '';
  if (invite.loading && !context) status = 'Checking your invitation…';
  else if (submit.loading) status = 'Setting your password…';
  else if (accepted) status = 'Account ready. Taking you to the next step…';

  let content;
  if (!token) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">This invitation link is incomplete</h1>
          <p className="auth-sub">
            The address you arrived at carries no invitation token, so there is nothing here to
            verify.
          </p>
        </div>

        <Alert tone="danger" title="Nothing to accept">
          Some email clients wrap a long link across two lines, and copying only the first line
          drops the token. Open the link from the invitation email itself, or ask your
          administrator to send it again.
        </Alert>

        <p className="auth-footer small faint">
          Already set a password? <Link to="/login">Sign in</Link>.
        </p>
      </>
    );
  } else if (dead) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">This invitation no longer works</h1>
        </div>

        <Alert tone="danger" title={dead.message}>
          {deadInviteCopy(dead.code)}
        </Alert>

        {dead.code === INVITE_USED ? (
          <Link className="btn btn-primary btn-block" to="/login">
            Go to sign in
          </Link>
        ) : null}

        <p className="auth-footer small faint">
          No password was set by this attempt. <Link to="/login">Back to sign in</Link>.
        </p>
      </>
    );
  } else if (invite.loading && !context) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">Accept your invitation</h1>
        </div>
        <LoadingBlock label="Checking your invitation…" />
      </>
    );
  } else if (readError) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">Accept your invitation</h1>
        </div>

        <ErrorState
          error={readError}
          onRetry={invite.reload}
          title="Could not check your invitation"
        />

        <p className="auth-footer small faint">
          Your invitation is untouched by this — the link keeps working once the connection does.
        </p>
      </>
    );
  } else if (context) {
    const roleLabel = ROLE_LABELS[context.role] || context.role || 'member';
    // "a Administrator" reads as a typo, and the labels are a closed set from
    // constants.js, so testing the first letter is enough.
    const article = /^[aeiou]/i.test(roleLabel) ? 'an' : 'a';
    const institutionName = (context.institution && context.institution.name) || 'SnapAttend';
    const institutionSlug = (context.institution && context.institution.slug) || '';

    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">Accept your invitation</h1>
          <p className="auth-sub">
            You have been invited to join <strong>{institutionName}</strong> as {article}{' '}
            {roleLabel}. Choose a password and the account is yours.
          </p>
          {institutionSlug ? (
            <p className="small faint">
              Institution ID <span className="mono">{institutionSlug}</span>
            </p>
          ) : null}
        </div>

        {context.needs_biometrics ? (
          <Alert tone="info" title="Student invitations usually start somewhere else">
            A student invitation email links to the enrollment page, which sets a password and
            records face and voice samples in one pass. Setting it here works just as well — you
            will be sent straight on to that same enrollment step.
          </Alert>
        ) : null}

        {user ? (
          <Alert tone="warn" title={`You are signed in as ${user.email}`}>
            Accepting this invitation replaces that session on this device with{' '}
            {context.email}.
          </Alert>
        ) : null}

        {/* noValidate: the checks in `validate` render under the input that failed,
            and the browser's native bubble would pre-empt them with a vaguer
            message. */}
        <form className="stack" onSubmit={onSubmit} noValidate>
          {/* Read-only rather than disabled: the address is the thing being
              activated, so it stays legible and reachable — and `autoComplete`
              gives a password manager the username to file the new secret under. */}
          <Input
            label="Email"
            type="email"
            autoComplete="username"
            readOnly
            value={context.email || ''}
          />

          <Input
            label="Full name"
            autoComplete="name"
            hint="Prefilled from your invitation. Bulk imports often abbreviate a name; your administrator can correct it once you are signed in."
            value={form.name}
            onChange={update('name')}
          />

          <Input
            label="Password"
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
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            required
            value={form.confirm}
            error={errors.confirm}
            onChange={update('confirm')}
          />

          {/* Still "loading" once the request has settled: the redirect fires from
              an effect in the same commit, and a button that looks clickable in
              between invites a second submit against a 10/hr budget. */}
          <Button
            type="submit"
            block
            loading={submit.loading || Boolean(accepted)}
            disabled={cooling}
          >
            Set password and continue
          </Button>

          {cooling ? (
            <p className="small muted">
              Too many attempts — try again in {pluralize(secondsLeft, 'second')}.
            </p>
          ) : null}
        </form>

        <p className="auth-footer small faint">
          Not expecting this? Nothing changes until this form is submitted, so the link can be
          ignored. <Link to="/login">Back to sign in</Link>.
        </p>
      </>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-card">
          {/* Mounted in every state so an in-flight request is announced from a
              region that already existed. The outcome panels carry their own
              roles, so this one stays quiet between requests. */}
          <p className="sr-only" aria-live="polite">
            {status}
          </p>

          <div className="stack">{content}</div>
        </div>
      </div>
    </div>
  );
}
