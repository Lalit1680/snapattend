import { useState } from 'react';
import { Link } from 'react-router-dom';

import VoiceRecorderPanel from '../../components/VoiceRecorderPanel.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Pill,
} from '../../components/ui/index.js';
import { AttendanceAPI, EnrollAPI } from '../../lib/api.js';
import { ErrorCode } from '../../lib/constants.js';
import {
  formatClock,
  formatConfidence,
  formatDateTime,
  formatDuration,
  formatRelative,
  pluralize,
} from '../../lib/format.js';
import { useToast } from '../../context/ToastContext.jsx';
import useAsync from '../../hooks/useAsync.js';
import useCountdown from '../../hooks/useCountdown.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import usePolling from '../../hooks/usePolling.js';
import useResource from '../../hooks/useResource.js';

/**
 * Faster than the dashboard's twenty seconds.
 *
 * This is the page a student sits on waiting for a lecture to start, so the gap
 * between the teacher opening a session and the button appearing is the whole
 * experience of it. Ten seconds is the compromise the dashboard does not need.
 */
const POLL_MS = 10000;

/** `Config.QR_TOKEN_TTL_SECONDS`. Quoted in the instructions, so it is named here. */
const QR_ROTATION_SECONDS = 30;

/**
 * The refusals `POST /api/attendance/voice` can raise, each turned into the thing
 * to do about it.
 *
 * The server's own messages are accurate but they are written for any caller. A
 * student staring at a microphone button needs to know whether to record again,
 * go and enroll, or find their teacher — and those are three different answers to
 * what all look like the same red box.
 */
const VOICE_FAILURES = {
  [ErrorCode.MODE_MISMATCH]: {
    title: 'This class is not using voice check-in',
    body: 'The teacher changed how the session verifies after this page loaded. Refresh the list to see what it wants now.',
  },
  [ErrorCode.SESSION_ENDED]: {
    title: 'The session has ended',
    body: 'Check-in closed when the teacher ended it. Only they can add you to the register now.',
  },
  [ErrorCode.WINDOW_CLOSED]: {
    title: 'The check-in window has closed',
    body: 'This session had a closing time and it has passed. Ask your teacher to mark you.',
  },
  [ErrorCode.VOICE_NOT_ENROLLED]: {
    title: 'Your voice is not on file',
    body: 'There is nothing for the recording to be compared against. Record your passphrase on the enrollment page first — it takes about a minute.',
  },
  [ErrorCode.NOT_ENROLLED]: {
    title: 'You are not on this subject’s roster',
    body: 'Only students enrolled on the subject can check in to its sessions. Speak to your teacher if that looks wrong.',
  },
  [ErrorCode.VOICE_PIPELINE_UNAVAILABLE]: {
    title: 'Voice checking is unavailable',
    body: 'The server could not load the model that compares voices, so nothing can be verified right now. Tell your teacher — they can mark you by hand.',
  },
  [ErrorCode.RATE_LIMITED]: {
    title: 'Too many attempts',
    body: 'Voice check-in allows ten attempts a minute. Wait a moment, then record again.',
  },
};

/**
 * A closing time, worded for the distance to it. Same rule as the dashboard's:
 * mm:ss reads as a countdown and is wrong for a session open all afternoon.
 */
function closesIn(seconds) {
  if (seconds >= 3600) return formatDuration(Math.round(seconds / 60));
  return formatClock(seconds);
}

/**
 * Checking in.
 *
 * Only two of the four verification modes ask the student for anything, and only
 * those two are listed — `GET /me/open-sessions` filters to
 * `VerificationMode.student_self_service` server side. A photo-only session is
 * absent on purpose: the answer for one is "sit where the camera can see you",
 * which is not a button.
 *
 * There is deliberately no QR *reader* here. Decoding a camera stream needs a
 * library this project does not depend on, and it does not need one — the code a
 * teacher projects is a signed link, so the phone's own camera app opens
 * `/scan?t=…` and the check-in happens there. This page's job for a QR session is
 * to say exactly that.
 */
export default function CheckIn() {
  useDocumentTitle('Check in');

  const open = usePolling(() => AttendanceAPI.myOpenSessions(), POLL_MS);
  const [voiceFor, setVoiceFor] = useState(null);

  const sessions = (open.data && open.data.sessions) || [];
  // No `server_time` alongside an empty list is the endpoint's "on nobody's
  // roster" short-circuit, which is a different thing from nothing being open.
  const noRoster = Boolean(open.data && !open.data.server_time && !sessions.length);

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Check in</h1>
          <p className="page-sub">
            Anything open on your subjects right now. The list re-checks itself every ten seconds,
            so leaving this page open is enough.
          </p>
        </div>
        <div className="page-actions">
          {open.lastUpdatedAt ? (
            <span className="small faint">Checked {formatRelative(open.lastUpdatedAt)}</span>
          ) : null}
          <Button variant="secondary" onClick={open.refresh} loading={open.loading}>
            Check now
          </Button>
        </div>
      </div>

      {open.error && !open.data ? (
        <ErrorState
          error={open.error}
          onRetry={open.refresh}
          title="Could not check for open sessions"
        />
      ) : noRoster ? (
        <Card title="Nothing to check in to">
          <EmptyState
            title="You are not enrolled on any subject"
            message="Sessions belong to subjects, and you are not on a roster yet. Your teacher adds you; until then there is nothing here to do."
            action={
              <Link className="btn btn-secondary" to="/student">
                Back to overview
              </Link>
            }
          />
        </Card>
      ) : sessions.length ? (
        <div className="stack">
          {sessions.map((session) => (
            <SessionCard
              key={session.session_id}
              session={session}
              onVoice={() => setVoiceFor(session)}
            />
          ))}
        </div>
      ) : (
        <Card title="Nothing open">
          <EmptyState
            title="No session is taking check-ins"
            message="A QR or voice session appears here within ten seconds of a teacher starting it. You do not need to refresh."
            action={
              <Link className="btn btn-secondary" to="/student/attendance">
                See your record
              </Link>
            }
          />
        </Card>
      )}

      <ModeExplainer />

      {/* Keyed on nothing — mounting per session is the point. The recorder,
          the clip and the outcome are all state that must not survive being
          reopened against a different session. */}
      {voiceFor ? (
        <VoiceCheckIn
          session={voiceFor}
          onClose={() => setVoiceFor(null)}
          onMarked={open.refresh}
        />
      ) : null}
    </div>
  );
}

/** One open session, with whatever it wants from the student. */
function SessionCard({ session, onVoice }) {
  const { secondsLeft, expired } = useCountdown(session.closes_at);
  const voice = session.action === 'voice';

  return (
    <Card
      title={session.subject || 'Unknown subject'}
      subtitle={session.title || undefined}
      actions={
        <div className="row row-sm row-wrap">
          {session.subject_code ? <Pill>{session.subject_code}</Pill> : null}
          <Badge tone={voice ? 'info' : 'primary'}>{session.mode_label}</Badge>
        </div>
      }
      footer={
        session.closes_at ? (
          expired ? (
            <span className="small">
              <Pill tone="warn">closed</Pill> The closing time passed at{' '}
              {formatDateTime(session.closes_at)}. A check-in will be refused; ask your teacher.
            </span>
          ) : (
            <span className="small muted">
              Closes in <span className="qr-countdown">{closesIn(secondsLeft)}</span> · at{' '}
              {formatDateTime(session.closes_at)}
            </span>
          )
        ) : (
          <span className="small muted">Open until the teacher ends it.</span>
        )
      }
    >
      {session.already_present ? (
        <Alert tone="success" title="You are already marked present">
          This session is on your record. Checking in again cannot mark you twice and cannot change
          the method already stored against it.
        </Alert>
      ) : voice ? (
        <VoicePrompt session={session} onVoice={onVoice} />
      ) : (
        <QrSteps />
      )}
    </Card>
  );
}

/** The voice path: a button, or the reason there is no button yet. */
function VoicePrompt({ session, onVoice }) {
  if (session.needs_voice_enrollment) {
    return (
      <Alert
        tone="warn"
        title="Record your passphrase first"
        actions={
          <Link className="btn btn-sm btn-primary" to="/enroll">
            Enroll your voice
          </Link>
        }
      >
        This session verifies by voice and yours is not on file, so there is nothing for a recording
        to be compared against. Enrolling takes about a minute and is only done once.
      </Alert>
    );
  }

  return (
    <div className="stack">
      <p className="small muted">
        You read a short phrase aloud. It is compared with the voice you enrolled — a check against
        your own account, not a search for whoever in the class sounds closest — and the recording is
        discarded as soon as the answer is known.
      </p>
      <div className="row row-sm row-wrap">
        <Button onClick={onVoice}>Record and check in</Button>
        <span className="small faint">Somewhere quiet, at your normal speaking volume.</span>
      </div>
    </div>
  );
}

/**
 * The QR path, which happens on the phone rather than here.
 *
 * A plain `<ol>`: the numbers are the instruction, and `.stack-sm` is a flex
 * column, which would blockify the items and drop the markers.
 */
function QrSteps() {
  return (
    <div className="stack">
      <ol>
        <li>Look at the code your teacher is showing on the screen.</li>
        <li>Open the camera app on your phone and point it at the code.</li>
        <li>Tap the link it offers — it opens SnapAttend and marks you there. Nothing to type.</li>
      </ol>
      <div className="divider" />
      <p className="small muted">
        The code is replaced every {QR_ROTATION_SECONDS} seconds. A photograph of it, or one a friend
        forwards you, has expired by the time it is used, and the page says so rather than marking
        anybody. If that phone is not signed in it asks you to sign in and then finishes the
        check-in.
      </p>
    </div>
  );
}

/**
 * Why a lecture can be running with nothing on this page.
 *
 * The commonest support question a student portal gets. Answering it in place is
 * cheaper than answering it once per student.
 */
function ModeExplainer() {
  return (
    <Card
      title="What each kind of session asks of you"
      subtitle="A teacher picks one of four ways to verify a session. Two of them involve you; two mostly do not."
    >
      <div className="stack-sm">
        <div className="row between">
          <span>Class photo</span>
          <Badge tone="muted">nothing to do</Badge>
        </div>
        <div className="row between">
          <span>QR only</span>
          <Badge tone="primary">scan the projected code</Badge>
        </div>
        <div className="row between">
          <span>Voice only</span>
          <Badge tone="info">read your passphrase</Badge>
        </div>
        <div className="row between">
          <span>Class photo and QR</span>
          <Badge tone="primary">scan if the photo missed you</Badge>
        </div>
        <div className="divider" />
        <p className="small muted">
          A photo session never appears in the list above, because there is no button that would
          help: your face is matched from the photograph the teacher takes. If it cannot find you —
          you were turned away from the camera, or at the back — the teacher gets a review item with
          your face on it and decides. Enrolling your face is what makes that work.
        </p>
      </div>
    </Card>
  );
}

/**
 * Record once, send once, read the answer.
 *
 * Mounted per session and unmounted on close, so the clip, the outcome and the
 * recorder's own microphone all go with it. There is no path where a recording
 * made for one lecture is submitted against another.
 */
function VoiceCheckIn({ session, onClose, onMarked }) {
  const toast = useToast();
  const info = useResource(() => EnrollAPI.passphrase(), []);
  const [clips, setClips] = useState([]);
  const [result, setResult] = useState(null);

  const submit = useAsync((audio) => AttendanceAPI.checkInWithVoice(session.session_id, audio), {
    onSuccess: (response) => {
      setResult(response || null);
      if (!response) return;
      if (response.accepted === false) {
        // A rejection is a 200 and that clip is spent — the student has to record
        // again, so it is cleared rather than left sitting under the explanation.
        setClips([]);
        return;
      }
      // A blocked override is not a success to celebrate: the register still says
      // absent, and `OutcomeAlert` says so.
      if (response.blocked_by_override) return;
      toast.success(
        response.already_present ? 'You were already marked present.' : 'Marked present.',
      );
      if (typeof onMarked === 'function') onMarked();
    },
  });

  const clip = clips.length ? clips[0] : null;
  // `accepted` means the voice matched. Whatever the register then said, another
  // recording cannot change it, so the recorder goes away.
  const done = Boolean(result && result.accepted);

  return (
    <Modal
      open
      wide
      title={`Voice check-in · ${session.subject || 'session'}`}
      onClose={onClose}
      footer={
        <div className="row between row-wrap">
          <span className="small faint">
            The recording is compared and then dropped. Only the result is kept.
          </span>
          <div className="row row-sm">
            <Button variant="secondary" onClick={onClose}>
              {done ? 'Done' : 'Cancel'}
            </Button>
            {done ? null : (
              <Button
                onClick={() => submit.run(clip.dataUrl)}
                loading={submit.loading}
                disabled={!clip}
              >
                Send for checking
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="stack">
        {result ? <OutcomeAlert result={result} session={session} /> : null}
        {submit.error ? <FailureAlert error={submit.error} /> : null}

        {done ? null : (
          <>
            {info.error && !info.data ? (
              <Alert tone="warn" title="Could not load the phrase to read">
                Record anyway. The phrase is a prompt, not a password — the check matches your voice
                and not the words, so any full sentence read at your normal pace will do.
              </Alert>
            ) : null}
            <VoiceRecorderPanel
              passphrase={(info.data && info.data.passphrase) || ''}
              clips={clips}
              onRecorded={(recorded) => setClips([recorded])}
              onRemove={() => setClips([])}
              maxClips={1}
              busy={submit.loading}
              buttonLabel="Record your passphrase"
            />
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * What the server decided, in the order the outcomes have to be tested.
 *
 * `blocked_by_override` comes first and not for tidiness: a blocked override also
 * reports `created: false`, so testing `already_present` before it would tell a
 * student they are marked while the register says absent. `ScanPage` orders the
 * same three checks the same way, for the same reason.
 */
function OutcomeAlert({ result, session }) {
  if (result.blocked_by_override) {
    return (
      <Alert tone="danger" title="A teacher has marked you absent for this session">
        <p>
          Your voice matched, but a mark set by hand always wins over an automatic one. The register
          still says absent and nothing on this page can change that — only the teacher who set it
          can.
        </p>
        {result.message ? <p className="small muted">{result.message}</p> : null}
      </Alert>
    );
  }

  if (result.accepted === false) {
    return (
      <Alert tone="warn" title="That did not sound like your enrolled voice">
        <p>{result.message || 'The recording was not close enough to the voice on file.'}</p>
        <p className="small muted">
          {typeof result.voiced_seconds === 'number'
            ? `${result.voiced_seconds.toFixed(1)}s of speech was heard`
            : 'Speech was heard'}
          {typeof result.confidence === 'number'
            ? `, matching at ${formatConfidence(result.confidence)}`
            : ''}
          . Record again somewhere quieter and closer to the microphone, and read the whole phrase at
          your normal speaking volume. Nothing has been written against you.
        </p>
      </Alert>
    );
  }

  const subject = session.subject || 'this session';
  const at = result.marked_at ? ` at ${formatDateTime(result.marked_at)}` : '';

  return (
    <Alert
      tone="success"
      title={result.already_present ? 'You were already marked present' : 'Marked present'}
    >
      <p>
        {result.already_present
          ? `Your voice matched, and ${subject} already had you on the register${at}. Checking in twice cannot mark you twice, and it cannot change the method stored against the first one.`
          : `Your voice matched and ${subject} now has you present${at}. The recording has been compared and dropped.`}
      </p>
      {typeof result.confidence === 'number' ? (
        <p className="small muted">
          This recording matched at {formatConfidence(result.confidence)}.
        </p>
      ) : null}
    </Alert>
  );
}

/**
 * A refused attempt, answered with the thing to do about it.
 *
 * Anything outside `VOICE_FAILURES` falls back to the server's own message, which
 * is always a whole sentence — the envelope guarantees that much, so there is no
 * case where this renders a bare code at a student.
 */
function FailureAlert({ error }) {
  const known = VOICE_FAILURES[error.code] || null;

  return (
    <Alert
      tone="danger"
      title={known ? known.title : 'Could not check you in'}
      actions={
        // Only for the one failure enrolling actually fixes. `NOT_ENROLLED` is
        // about the subject's roster, and no amount of recording changes that.
        error.code === ErrorCode.VOICE_NOT_ENROLLED ? (
          <Link className="btn btn-sm btn-primary" to="/enroll">
            Enroll your voice
          </Link>
        ) : null
      }
    >
      <p>{known ? known.body : error.message}</p>
      {error.retryAfter ? (
        <p className="small muted">Try again in {pluralize(error.retryAfter, 'second')}.</p>
      ) : null}
    </Alert>
  );
}
