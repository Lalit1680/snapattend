import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert, Button, Input } from '../../components/ui/index.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { useCountdown } from '../../hooks/useCountdown.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { ErrorCode, MODE_HINTS, MODE_LABELS, VerificationMode } from '../../lib/constants.js';
import { pluralize } from '../../lib/format.js';

/**
 * Rules mirrored from `backend/app/utils/validators.py`. Duplicated rather than
 * discovered from a 422 because `/api/auth/register-institution` allows five
 * attempts an hour, and an attempt rejected for a mistyped email still spends one.
 */
const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 120;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

/** What `register_institution()` falls back to when a name slugifies to nothing. */
const FALLBACK_SLUG = 'institution';

/** The three capabilities; the fourth mode is a combination of two of them. */
const FEATURED_MODES = [
  VerificationMode.CLASS_PHOTO,
  VerificationMode.QR,
  VerificationMode.VOICE,
];

const EMPTY_FORM = {
  institution_name: '',
  slug: '',
  name: '',
  email: '',
  password: '',
  confirm_password: '',
};

/**
 * `slugify` from the same module, rule for rule: NFKD-normalise, drop everything
 * that is not ASCII — *drop*, not hyphenate, or "Über" would become "u-ber" here
 * and "uber" on the server — then collapse every other run into one hyphen.
 */
function slugify(value) {
  const ascii = String(value || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '');
  const hyphenated = ascii
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return hyphenated.slice(0, 50).replace(/^-+|-+$/g, '');
}

/**
 * Flatten every shape the backend reports a bad field in into `{name: message}`.
 *
 * `require()` sends `details.fields` as a *list* of names and `clean_*` sends
 * `details.field` as a single name with the message on the envelope. Neither is
 * the map `ApiError.fieldErrors` implies, and a JS array satisfies its
 * `typeof === 'object'` test, so it arrives here as one.
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

  if (!values.institution_name.trim()) {
    problems.institution_name = 'Enter the name of your institution.';
  }
  if (!values.name.trim()) {
    problems.name = 'Enter your own name.';
  }

  const email = values.email.trim().toLowerCase();
  if (!email) {
    problems.email = 'Enter your email address.';
  } else if (!EMAIL_RE.test(email)) {
    problems.email = 'That does not look like an email address.';
  }

  if (values.password.length < MIN_PASSWORD_LENGTH) {
    problems.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (values.confirm_password !== values.password) {
    problems.confirm_password = 'The two passwords do not match.';
  }

  // The server slugifies whatever is typed here before checking it, so validate
  // the slug it would actually store rather than the raw text.
  const slug = values.slug.trim();
  if (slug && !SLUG_RE.test(slugify(slug))) {
    problems.slug = 'Use 3 to 50 lowercase letters, numbers or hyphens.';
  }

  return problems;
}

export default function RegisterInstitution() {
  const { registerInstitution, homePath } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [cooldownUntil, setCooldownUntil] = useState(null);
  const { secondsLeft } = useCountdown(cooldownUntil);

  useDocumentTitle('Create an institution');

  const register = useAsync((payload) => registerInstitution(payload), {
    onError: (err) => {
      // The form's keys are the backend's own field names, so a reported field
      // lands on its input without a translation table.
      const problems = fieldErrorsFrom(err);
      if (Object.keys(problems).length > 0) {
        setErrors((current) => ({ ...current, ...problems }));
        return;
      }
      if (err && err.code === ErrorCode.RATE_LIMITED && err.retryAfter) {
        setCooldownUntil(new Date(Date.now() + err.retryAfter * 1000).toISOString());
      }
      // A taken email or slug and a spent rate limit are both explained above the
      // form, next to the fields they are about. Everything else — a dead backend,
      // a 500 — is not about a field and belongs in a toast.
      const code = err && err.code;
      if (code !== ErrorCode.CONFLICT && code !== ErrorCode.RATE_LIMITED) {
        toast.notifyError(err, 'Could not create your institution.');
      }
    },
  });

  // Registering signs the new admin in, but `homePath()` still reports the
  // anonymous home until the auth context re-renders — so the redirect waits for
  // that render instead of reading a stale role inside the submit handler.
  useEffect(() => {
    if (register.data) navigate(homePath(), { replace: true });
  }, [register.data, homePath, navigate]);

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

    const payload = {
      institution_name: form.institution_name,
      name: form.name,
      email: form.email,
      password: form.password,
    };
    // Omitted when blank so the server derives the slug from the institution name
    // and de-duplicates it. `confirm_password` is this form's own check and has no
    // server-side meaning.
    if (form.slug.trim()) payload.slug = form.slug.trim();
    register.run(payload);
  };

  const cooling = secondsLeft > 0;
  const failure = register.error;
  const isConflict = Boolean(failure) && failure.code === ErrorCode.CONFLICT;
  const isRateLimited = Boolean(failure) && failure.code === ErrorCode.RATE_LIMITED;

  const typedSlug = form.slug.trim();
  const derivedSlug = slugify(form.institution_name);
  const slugPreview = typedSlug ? slugify(typedSlug) : derivedSlug || FALLBACK_SLUG;
  // A typed slug that survives `slugify` as an empty string has no preview worth
  // showing; `validate` is what tells the user it is unusable.
  const showSlugPreview =
    Boolean(slugPreview) && Boolean(typedSlug || form.institution_name.trim());

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <div className="auth-aside-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              A
            </span>
            <span className="brand-name">SnapAttend</span>
          </div>

          {FEATURED_MODES.map((mode) => (
            <div className="auth-feature" key={mode}>
              <p className="strong">{MODE_LABELS[mode]}</p>
              <p className="small">{MODE_HINTS[mode]}</p>
            </div>
          ))}
        </div>
      </aside>

      <div className="auth-panel">
        <div className="auth-card">
          <div className="stack">
            <div className="auth-header">
              <h1 className="auth-title">Create your institution</h1>
              <p className="auth-sub">
                You will be its first administrator, and can invite your colleagues once you
                are in.
              </p>
            </div>

            <Alert tone="info" title="This page is for new institutions only">
              Every other account in SnapAttend arrives by invitation. If your institution is
              already here, ask an administrator to invite you rather than registering a second
              copy of it.
            </Alert>

            {isConflict ? (
              <Alert tone="danger" title="That is already registered">
                {failure.message}
              </Alert>
            ) : null}

            {isRateLimited ? (
              <Alert tone="warn" title="Too many signups from this connection">
                {failure.message} New institutions are limited to five an hour and twenty a
                day. If you have already registered one, sign in instead — you do not need a
                second.
              </Alert>
            ) : null}

            {/* noValidate: the checks in `validate` produce `.field-error` text under
                the input that failed, and the browser's native bubble would pre-empt
                it with a less specific message. */}
            <form className="stack" onSubmit={onSubmit} noValidate>
              <fieldset className="fieldset">
                <legend className="legend">Your institution</legend>
                <div className="stack stack-sm">
                  <Input
                    label="Institution name"
                    autoComplete="organization"
                    maxLength={MAX_NAME_LENGTH}
                    required
                    value={form.institution_name}
                    error={errors.institution_name}
                    onChange={update('institution_name')}
                  />

                  <Input
                    label="Institution ID (optional)"
                    autoComplete="off"
                    spellCheck="false"
                    maxLength={50}
                    hint="Lowercase letters, numbers and hyphens. Leave it blank and one is made from the name above."
                    value={form.slug}
                    error={errors.slug}
                    onChange={update('slug')}
                  />

                  {showSlugPreview ? (
                    <p className="small muted">
                      {typedSlug ? 'Stored as ' : 'This would become '}
                      <span className="mono">{slugPreview}</span>
                      {typedSlug
                        ? '.'
                        : ' — a guess, because the server appends -2, -3 and so on if another institution already holds it.'}
                    </p>
                  ) : null}
                </div>
              </fieldset>

              <fieldset className="fieldset">
                <legend className="legend">Your administrator account</legend>
                <div className="stack stack-sm">
                  <Input
                    label="Your name"
                    autoComplete="name"
                    maxLength={MAX_NAME_LENGTH}
                    required
                    value={form.name}
                    error={errors.name}
                    onChange={update('name')}
                  />

                  <Input
                    label="Email address"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    required
                    hint="Invitations, reports and password resets are sent here."
                    value={form.email}
                    error={errors.email}
                    onChange={update('email')}
                  />

                  <div className="form-grid">
                    <Input
                      label="Password"
                      type="password"
                      autoComplete="new-password"
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
                      value={form.confirm_password}
                      error={errors.confirm_password}
                      onChange={update('confirm_password')}
                    />
                  </div>
                </div>
              </fieldset>

              <div className="stack stack-sm">
                <Button type="submit" block loading={register.loading} disabled={cooling}>
                  Create institution
                </Button>
                {/* Rendered even when empty: a live region added to the page at the
                    same moment as its text is often not announced at all. */}
                <p className="small muted text-center" aria-live="polite">
                  {cooling ? `Try again in ${pluralize(secondsLeft, 'second')}.` : null}
                  {!cooling && register.loading ? 'Creating your institution…' : null}
                </p>
              </div>
            </form>

            <p className="auth-footer small">
              Already have an account? <Link to="/login">Sign in</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
