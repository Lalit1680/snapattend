import { useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorState,
  Input,
  LoadingBlock,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { useCountdown } from '../hooks/useCountdown.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { useResource } from '../hooks/useResource.js';
import { AuthAPI, EnrollAPI } from '../lib/api.js';
import { ENROLLMENT_STATUS_LABELS, ErrorCode, ROLE_LABELS } from '../lib/constants.js';
import { pluralize } from '../lib/format.js';

/**
 * `MIN_PASSWORD_LENGTH` from `backend/app/utils/validators.py`. Duplicated rather
 * than discovered from a 422 because `/api/auth/change-password` allows only ten
 * attempts an hour, and a rejected-for-length attempt still spends one.
 */
const MIN_PASSWORD_LENGTH = 8;

const EMPTY_FORM = { current_password: '', new_password: '', confirm_password: '' };

/**
 * Flatten every shape the backend reports a bad field in into `{name: message}`.
 *
 * `require()` sends `details.fields` as a *list* of names ("Missing required
 * fields") and `clean_password` sends `details.field` as a single name with the
 * message on the envelope. Neither is the map `ApiError.fieldErrors` implies, and
 * a JS array satisfies its `typeof === 'object'` test, so it arrives here as one.
 */
function fieldErrorsFrom(err) {
  if (!err) return {};

  const out = {};
  const reported = err.fieldErrors || {};
  if (Array.isArray(reported)) {
    reported.forEach((name) => {
      if (name) out[name] = 'This is required.';
    });
  } else {
    Object.entries(reported).forEach(([name, message]) => {
      if (typeof message === 'string' && message) out[name] = message;
    });
  }

  const single = err.details && err.details.field;
  if (typeof single === 'string' && single) out[single] = err.message;
  return out;
}

function validate(values) {
  const problems = {};
  if (!values.current_password) {
    problems.current_password = 'Enter your current password.';
  }
  if (values.new_password.length < MIN_PASSWORD_LENGTH) {
    problems.new_password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (values.confirm_password !== values.new_password) {
    problems.confirm_password = 'The two new passwords do not match.';
  }
  return problems;
}

/** `drift` means the flag says enrolled but the vector is gone from the index. */
function stepTone(step) {
  if (step.drift) return 'danger';
  return step.done ? 'success' : 'warn';
}

function stepStatus(step) {
  if (step.drift) return 'Re-enroll';
  return step.done ? 'On file' : 'Not enrolled';
}

export default function AccountPage() {
  const { user, institution, student, isStudent } = useAuth();
  const toast = useToast();

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [cooldownUntil, setCooldownUntil] = useState(null);
  const { secondsLeft } = useCountdown(cooldownUntil);

  useDocumentTitle('Account');

  // The session's copy of `face_enrolled`/`voice_enrolled` is a snapshot from
  // sign-in and goes stale the moment the student enrolls, so the biometrics card
  // asks the server. Staff have no student record and the endpoint is
  // student-only, so the request is not made for them at all.
  const enrollment = useResource(() => EnrollAPI.status(), [], { immediate: isStudent });

  const changePassword = useAsync(
    (currentPassword, newPassword) => AuthAPI.changePassword(currentPassword, newPassword),
    {
      onSuccess: () => {
        setForm(EMPTY_FORM);
        setErrors({});
        toast.success('Your password has been updated.');
      },
      onError: (err) => {
        const problems = fieldErrorsFrom(err);
        if (Object.keys(problems).length > 0) {
          setErrors(problems);
          return;
        }
        if (err && err.code === ErrorCode.RATE_LIMITED && err.retryAfter) {
          setCooldownUntil(new Date(Date.now() + err.retryAfter * 1000).toISOString());
        }
        // A wrong current password is a 401, and the interceptor in lib/api.js
        // treats any non-login 401 as a dead session: it clears the tokens and
        // announces expiry, which signs the user out from under this form. A toast
        // outlives that navigation; a field error under the input does not.
        toast.notifyError(err, 'Could not change your password.');
      },
    },
  );

  const cooling = secondsLeft > 0;

  const update = (name) => (event) => {
    const { value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    // Retract the message as soon as the field is being fixed; leaving it up while
    // the user types reads as "still wrong".
    setErrors((current) => (current[name] ? { ...current, [name]: null } : current));
  };

  const onSubmit = (event) => {
    event.preventDefault();
    const problems = validate(form);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    changePassword.run(form.current_password, form.new_password);
  };

  // ProtectedRoute never renders this anonymously; the guard is here so a
  // mis-wired route table degrades to an empty page instead of a TypeError.
  if (!user) return null;

  const status = enrollment.data;
  const steps = (status && status.steps) || [];
  const hasDrift = steps.some((step) => step.drift);

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Account</h1>
          <p className="page-sub">Your profile, password and biometric enrollment.</p>
        </div>
      </div>

      <div className="stack">
        <Card
          title="Profile"
          subtitle="Names, email addresses and roles are managed by your administrator."
        >
          <div className="kv">
            {/* Plain divs rather than dl/dt/dd: `.kv` is a two-column grid, and a
                browser's default 40px margin on <dd> would push every value out
                of its cell. */}
            <div className="kv-key">Name</div>
            <div className="kv-value">{user.name || '—'}</div>

            <div className="kv-key">Email</div>
            <div className="kv-value">{user.email || '—'}</div>

            <div className="kv-key">Role</div>
            <div className="kv-value">{ROLE_LABELS[user.role] || user.role || '—'}</div>

            <div className="kv-key">Institution</div>
            <div className="kv-value">{(institution && institution.name) || '—'}</div>

            <div className="kv-key">Institution ID</div>
            <div className="kv-value mono">{(institution && institution.slug) || '—'}</div>

            {student ? (
              <>
                <div className="kv-key">Roll number</div>
                <div className="kv-value mono">{student.roll_number || '—'}</div>

                <div className="kv-key">Biometrics</div>
                <div className="kv-value row row-sm row-wrap">
                  <Badge tone={student.face_enrolled ? 'success' : 'muted'} dot>
                    {student.face_enrolled ? 'Face enrolled' : 'No face samples'}
                  </Badge>
                  <Badge tone={student.voice_enrolled ? 'success' : 'muted'} dot>
                    {student.voice_enrolled ? 'Voice enrolled' : 'No voice samples'}
                  </Badge>
                </div>
              </>
            ) : null}
          </div>
        </Card>

        <Card
          title="Change password"
          subtitle={`At least ${MIN_PASSWORD_LENGTH} characters. You stay signed in on this device.`}
        >
          {/* noValidate: the three checks below produce `.field-error` text under
              the input that failed, and the browser's native bubble would pre-empt
              it with a less specific message. */}
          <form className="stack" onSubmit={onSubmit} noValidate>
            <Input
              label="Current password"
              type="password"
              autoComplete="current-password"
              required
              value={form.current_password}
              error={errors.current_password}
              onChange={update('current_password')}
            />

            <div className="form-grid">
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                required
                hint={`${MIN_PASSWORD_LENGTH} characters or more.`}
                value={form.new_password}
                error={errors.new_password}
                onChange={update('new_password')}
              />
              <Input
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                required
                value={form.confirm_password}
                error={errors.confirm_password}
                onChange={update('confirm_password')}
              />
            </div>

            <div className="row row-sm row-wrap">
              <Button type="submit" loading={changePassword.loading} disabled={cooling}>
                Update password
              </Button>
              {cooling ? (
                <span className="small muted">
                  Too many attempts — try again in {pluralize(secondsLeft, 'second')}.
                </span>
              ) : null}
            </div>
          </form>
        </Card>

        {isStudent ? (
          <Card
            title="Face and voice enrollment"
            subtitle="Recognition drifts as you change — new glasses, a beard, a cold. Re-enrolling replaces the stored vector."
            actions={
              <Link className="btn btn-secondary btn-sm" to="/enroll">
                {status && status.complete ? 'Re-enroll' : 'Finish enrollment'}
              </Link>
            }
          >
            {enrollment.loading && !status ? (
              <LoadingBlock label="Checking your enrollment…" />
            ) : null}

            <ErrorState
              error={enrollment.error}
              onRetry={enrollment.reload}
              title="Could not read your enrollment"
            />

            {status ? (
              <div className="stack stack-sm">
                <div className="row row-sm row-wrap">
                  <span className="small muted">Status</span>
                  <Badge tone={status.complete ? 'success' : 'warn'} dot>
                    {ENROLLMENT_STATUS_LABELS[status.enrollment_status] || 'Not enrolled'}
                  </Badge>
                </div>

                {steps.map((step) => (
                  <div key={step.key} className="row between">
                    <div>
                      <div className="strong">{step.label}</div>
                      <div className="small muted">{step.detail}</div>
                    </div>
                    <Badge tone={stepTone(step)} dot>
                      {stepStatus(step)}
                    </Badge>
                  </div>
                ))}

                {hasDrift ? (
                  <Alert tone="warn" title="One of your samples needs redoing">
                    Your record says you enrolled, but the matching vector is missing from the
                    index — until you enroll again you will not be recognised in class.
                  </Alert>
                ) : null}
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
