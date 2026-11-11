import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Alert, Badge, Button, ErrorState, LoadingBlock, Pill } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { useCountdown } from '../hooks/useCountdown.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { useResource } from '../hooks/useResource.js';
import { AttendanceAPI, PublicAPI } from '../lib/api.js';
import {
  ErrorCode,
  METHOD_LABELS,
  METHOD_TONES,
  MODE_LABELS,
  ScanReason,
} from '../lib/constants.js';
import { formatTime, pluralize } from '../lib/format.js';

/**
 * `QR_TOKEN_TTL_SECONDS` from `backend/app/config.py`. It appears in half the copy
 * on this page: "the code changes every 30 seconds" is the single fact that turns a
 * baffling failure into an obvious re-scan.
 */
const QR_ROTATION_SECONDS = 30;

/**
 * The failures `qr.resolve_token` distinguishes, and what each one asks of the
 * student.
 *
 * `error.message` is the headline in every case — the backend writes those for
 * students, not for us — so these strings carry only what it cannot know: whether
 * the student did anything wrong, and what their next physical action is.
 */
const TOKEN_FAILURES = {
  [ErrorCode.QR_ROTATED]: {
    heading: 'Scan the code again',
    tone: 'info',
    body: `You did nothing wrong. The projected code is replaced every ${QR_ROTATION_SECONDS} seconds so that a screenshot cannot be passed around the room, and yours aged out on the walk to your seat. Point your camera at the code showing now and you are in.`,
    retryLabel: 'Try this code again',
  },
  [ErrorCode.TOKEN_EXPIRED]: {
    heading: 'Scan the code again',
    tone: 'info',
    body: `Codes are deliberately short-lived — about ${QR_ROTATION_SECONDS} seconds each. This one has run out, so open your camera and scan the one on screen.`,
    retryLabel: 'Try this code again',
  },
  [ErrorCode.TOKEN_INVALID]: {
    heading: 'This is not a code SnapAttend issued',
    tone: 'danger',
    body: 'The address you arrived at is not a signed check-in code, so there is nothing to verify. A link that was retyped, forwarded or truncated by a chat app looks exactly like this. Scan the code on screen directly instead.',
  },
  [ErrorCode.SESSION_ENDED]: {
    heading: 'This class has finished',
    tone: 'warn',
    body: 'Your teacher has closed the register, and closing it is final — nothing can be added afterwards from a phone. If you were in the room, ask them to mark you present; they can, and the change is recorded against their name.',
  },
  [ErrorCode.WINDOW_CLOSED]: {
    heading: 'Check-in has closed for this class',
    tone: 'warn',
    body: 'The scheduled window for this session has passed. Ask your teacher to mark you present if you were there.',
  },
  [ErrorCode.MODE_MISMATCH]: {
    heading: 'This class does not use QR check-in',
    tone: 'warn',
    body: 'The code resolved to a real class, but that class is marking attendance another way — a photo of the room, or your voice. There is nothing to tap here.',
    selfService: true,
  },
  [ErrorCode.NOT_FOUND]: {
    heading: 'That class is gone',
    tone: 'danger',
    body: 'The session this code points at no longer exists. Check with your teacher that you scanned the right screen.',
  },
};

/**
 * Reasons the summary gives for a student who cannot act, other than being
 * anonymous. `not_signed_in` and `already_present` are handled in the tree below
 * instead, because each of those needs a control rather than only a paragraph.
 */
const BLOCKED_REASONS = {
  [ScanReason.NOT_ENROLLED]: {
    heading: 'You are not on this class list',
    tone: 'warn',
    body: 'Only students enrolled in this subject can check in, and attendance is calculated from that same list — so being missing from it matters beyond today. Speak to your teacher: once they add you, this code works.',
  },
  [ScanReason.STAFF_ACCOUNT]: {
    heading: 'You are signed in as staff',
    tone: 'info',
    body: 'The code itself is fine — this is what your students see when they scan it, minus the button. Only student accounts can mark attendance.',
  },
  [ScanReason.NO_STUDENT_PROFILE]: {
    heading: 'Your student record is incomplete',
    tone: 'danger',
    body: 'Your account is marked as a student but has no student record behind it, so there is nothing for attendance to attach to. Your institution can repair this; it is not something you can fix from here.',
  },
  [ScanReason.WRONG_INSTITUTION]: {
    heading: 'That code belongs to another institution',
    tone: 'danger',
    body: 'SnapAttend keeps institutions completely separate, so a code from one cannot mark attendance in another. Check that you scanned your own class.',
  },
};

function tokenFailureFor(error) {
  if (!error) return null;
  const copy = TOKEN_FAILURES[error.code];
  return copy ? { ...copy, message: error.message } : null;
}

/**
 * `_mark_result_response` in `backend/app/routes/attendance.py` answers 200 three
 * different ways. The order below is the whole point: a blocked override also
 * reports `created: false`, and reading that as "already present" would tell a
 * student they are marked while the register says absent.
 */
function outcomeCopy(result) {
  if (result.blocked_by_override) {
    return {
      heading: 'You are still marked absent',
      tone: 'warn',
      body: 'Your teacher set this by hand, and a scan does not overrule a person. Talk to them — they can change it, and the change is logged either way.',
    };
  }
  if (result.already_present) {
    return {
      heading: 'You were already checked in',
      tone: 'success',
      body: 'Nothing changed, and nothing needed to. You can put your phone away.',
    };
  }
  if (result.created) {
    return { heading: "You're checked in", tone: 'success', body: null };
  }
  // A 200 that is none of the three would mean the backend grew a fourth outcome.
  // Show its message rather than an empty card.
  return { heading: 'Check-in recorded', tone: 'info', body: null };
}

/** The two facts a student wants after being marked: how, and when. */
function MarkedMeta({ method, at }) {
  return (
    <div className="row row-sm row-wrap">
      <Badge tone={METHOD_TONES[method] || 'muted'} dot>
        {METHOD_LABELS[method] || METHOD_LABELS.unknown}
      </Badge>
      <span className="small muted">Marked at {formatTime(at)}</span>
    </div>
  );
}

/**
 * `/scan?t=…` — what a phone's camera opens when a student scans the projected QR.
 *
 * Renders standalone: whoever arrives here may not be signed in, is holding the
 * phone one-handed in a lecture hall, and has under a minute before the code they
 * scanned stops meaning anything.
 */
export default function ScanPage() {
  const [searchParams] = useSearchParams();
  // `_qr_target_url` builds `?t=`, and the route accepts `?token=` as well.
  // Trimmed because some QR readers hand the browser a trailing newline, which
  // would fail the signature check for no real reason.
  const token = (searchParams.get('t') || searchParams.get('token') || '').trim();

  const { user, initializing, homePath } = useAuth();
  const toast = useToast();

  const [cooldownUntil, setCooldownUntil] = useState(null);
  const { secondsLeft } = useCountdown(cooldownUntil);

  useDocumentTitle('Check in');

  // Deliberately held until AuthContext's `/me` settles. `/api/public/scan` is
  // `optional_auth`, which treats an expired access token as anonymous — asking
  // before the interceptor has had its one chance to refresh would answer "sign in
  // to check in" to a student who is signed in. Anonymous visitors wait for
  // nothing: `initializing` is only true when there is a stored token to verify.
  const scan = useResource(() => PublicAPI.scan(token), [token, initializing], {
    immediate: Boolean(token) && !initializing,
  });

  const checkIn = useAsync(() => AttendanceAPI.checkInWithQr(token), {
    onError: (err) => {
      // A dead token and a lost session both replace the whole card below, so a
      // toast would only repeat what the student is already reading.
      if (TOKEN_FAILURES[err.code] || err.isAuth) return;
      if (err.code === ErrorCode.RATE_LIMITED && err.retryAfter) {
        setCooldownUntil(new Date(Date.now() + err.retryAfter * 1000).toISOString());
      }
      toast.notifyError(err, 'Could not check you in.');
    },
  });

  const scanPath = `/scan?t=${encodeURIComponent(token)}`;
  const signInTo = token ? `/login?next=${encodeURIComponent(scanPath)}` : '/login';

  const summary = scan.data;
  const student = (summary && summary.student) || null;
  const failure = tokenFailureFor(scan.error) || tokenFailureFor(checkIn.error);
  const outcome = checkIn.data ? outcomeCopy(checkIn.data) : null;
  const cooling = secondsLeft > 0;

  const retryLookup = () => {
    checkIn.reset();
    setCooldownUntil(null);
    scan.reload();
  };

  const onSubmit = (event) => {
    event.preventDefault();
    checkIn.run();
  };

  let content;
  let showFooter = true;

  if (!token) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">There is no code in this link</h1>
          <p className="auth-sub">
            This page only works when it is opened by scanning, because the code is the part that
            proves you are in the room.
          </p>
        </div>
        <Alert tone="warn" title="Scan the code your teacher is showing">
          Open your phone&apos;s camera and point it at the QR code on screen — it will bring you
          straight back here with the code attached. Typing this address by hand cannot work: a new
          code replaces the old one every {pluralize(QR_ROTATION_SECONDS, 'second')}.
        </Alert>
      </>
    );
  } else if (failure) {
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">{failure.heading}</h1>
        </div>

        <Alert tone={failure.tone} title={failure.message}>
          {failure.body}
        </Alert>

        {/* Re-scanning is the reliable fix, but a rotation that landed mid-request
            looks identical to a genuinely stale code from here, and one tap is
            cheaper than asking a student to lift their phone again. */}
        {failure.retryLabel ? (
          <Button size="lg" block onClick={retryLookup} loading={scan.loading}>
            {failure.retryLabel}
          </Button>
        ) : null}

        {failure.selfService && user ? (
          <Link className="btn btn-secondary btn-lg btn-block" to="/student/check-in">
            See how this class checks in
          </Link>
        ) : null}
      </>
    );
  } else if (initializing || (scan.loading && !summary)) {
    content = <LoadingBlock label="Looking up this class…" />;
    showFooter = false;
  } else if (scan.error && scan.error.isNetwork) {
    // `ErrorState` blames the Flask dev server for a network failure, which is the
    // right hint for a developer and meaningless to a student on lecture-hall wifi.
    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">Could not reach SnapAttend</h1>
        </div>
        <Alert tone="danger" title="Your phone could not get through">
          Check your signal and try again. If the wifi in here is unusable, ask your teacher to
          mark you present instead of fighting it — the code will expire long before the connection
          improves.
        </Alert>
        <Button size="lg" block onClick={retryLookup} loading={scan.loading}>
          Try again
        </Button>
      </>
    );
  } else if (scan.error) {
    content = (
      <ErrorState
        error={scan.error}
        onRetry={retryLookup}
        title="Could not look up this class"
      />
    );
  } else if (summary) {
    const mode = MODE_LABELS[summary.verification_mode] || summary.verification_mode;
    const reason = student ? student.reason : null;
    const blocked = reason ? BLOCKED_REASONS[reason] : null;

    let body;
    if (outcome) {
      body = (
        <>
          <Alert tone={outcome.tone} title={outcome.heading}>
            {checkIn.data.message}
            {outcome.body ? <> {outcome.body}</> : null}
          </Alert>

          {checkIn.data.marked_at ? (
            <MarkedMeta method={checkIn.data.method} at={checkIn.data.marked_at} />
          ) : null}

          <Link className="btn btn-secondary btn-lg btn-block" to="/student">
            Go to my attendance
          </Link>
        </>
      );
    } else if (reason === ScanReason.NOT_SIGNED_IN && user) {
      // Signed in here but anonymous to the server: the stored token died between
      // `/me` and this lookup. Sending them to /login would be a dead end —
      // PublicOnlyRoute bounces a signed-in user home and drops `?next=`.
      body = (
        <>
          <Alert tone="warn" title="Your sign-in needs refreshing">
            You are signed in on this phone, but the server did not recognise it just now. One tap
            usually settles it.
          </Alert>
          <Button size="lg" block onClick={retryLookup} loading={scan.loading}>
            Try again
          </Button>
        </>
      );
    } else if (reason === ScanReason.NOT_SIGNED_IN) {
      body = (
        <>
          <p>Sign in and you will come straight back to this class.</p>

          <Link className="btn btn-primary btn-lg btn-block" to={signInTo}>
            Sign in to check in
          </Link>

          <Alert tone="warn" title="You will need to scan again afterwards">
            The code on the wall is replaced every {pluralize(QR_ROTATION_SECONDS, 'second')}, so
            the one you just scanned will be stale by the time you have typed your password. That
            is normal — sign in, then scan the code on screen once more. It takes a second and it
            works.
          </Alert>
        </>
      );
    } else if (blocked) {
      body = (
        <Alert tone={blocked.tone} title={student.message}>
          {blocked.body}
        </Alert>
      );
    } else if (reason === ScanReason.ALREADY_PRESENT) {
      body = (
        <>
          <Alert tone="success" title={student.message}>
            You did nothing wrong and there is nothing left to do — your teacher may have marked
            you from the class photo before you even scanned.
          </Alert>
          <MarkedMeta method={student.method_used} at={student.marked_at} />
        </>
      );
    } else if (student && student.can_check_in && student.action === 'voice') {
      // Unreachable while the modes stay mutually exclusive — `resolve_token`
      // rejects a voice-only session with `mode_mismatch` before this page sees
      // it — but the recorder belongs on one page, not two, either way.
      body = (
        <>
          <Alert tone="info" title="This class checks in by voice">
            Voice check-in needs your microphone and a few seconds of the passphrase, which does
            not fit inside a scanned link. The check-in page has the recorder.
          </Alert>
          <Link className="btn btn-primary btn-lg btn-block" to="/student/check-in">
            Open voice check-in
          </Link>
        </>
      );
    } else if (student && student.can_check_in) {
      body = (
        <form className="stack" onSubmit={onSubmit}>
          <Button type="submit" size="lg" block loading={checkIn.loading} disabled={cooling}>
            Check me in
          </Button>

          {checkIn.error && checkIn.error.isAuth ? (
            <Alert
              tone="warn"
              title={checkIn.error.message}
              actions={
                <Link className="btn btn-primary btn-sm" to={signInTo}>
                  Sign in again
                </Link>
              }
            >
              Nothing was recorded. Sign in, then scan the code on screen again.
            </Alert>
          ) : null}

          {cooling ? (
            <p className="small muted">
              That is a lot of taps — try again in {pluralize(secondsLeft, 'second')}.
            </p>
          ) : null}
        </form>
      );
    } else {
      // An unrecognised reason: the server's message is the only honest answer.
      body = (
        <Alert tone="info" title="You cannot check in to this class">
          {(student && student.message) || 'Ask your teacher to mark you present.'}
        </Alert>
      );
    }

    content = (
      <>
        <div className="auth-header">
          <h1 className="auth-title">{summary.subject_name || 'Check in'}</h1>
          <p className="auth-sub">
            {summary.title || 'Attendance'}
            {summary.subject_code ? (
              <>
                {' · '}
                <span className="mono">{summary.subject_code}</span>
              </>
            ) : null}
          </p>
        </div>

        <div className="row row-sm row-wrap">
          <Pill tone="info">{mode}</Pill>
        </div>

        {body}
      </>
    );
  } else {
    content = <LoadingBlock label="Looking up this class…" />;
    showFooter = false;
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-card">
          <div className="stack">
            <div className="brand">
              <span className="brand-mark" aria-hidden="true">
                A
              </span>
              <span className="brand-name">SnapAttend</span>
            </div>

            {/* Mounted in every state so an in-flight request is announced from a
                region that already existed. The panels below carry their own
                roles via `Alert`, so this one falls silent once things settle. */}
            <p className="sr-only" aria-live="polite">
              {checkIn.loading ? 'Checking you in…' : ''}
              {scan.loading ? 'Looking up this class…' : ''}
            </p>

            {content}

            {showFooter ? (
              <p className="auth-footer small faint">
                {user ? (
                  <>
                    Signed in as {user.email}. <Link to={homePath()}>Open SnapAttend</Link>.
                  </>
                ) : (
                  <>
                    Marking attendance needs an account. <Link to={signInTo}>Sign in</Link>.
                  </>
                )}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
