import { Link } from 'react-router-dom';

import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Pill,
  ProgressBar,
  StatGrid,
  StatTile,
} from '../../components/ui/index.js';
import { AttendanceAPI } from '../../lib/api.js';
import {
  AttendanceStatus,
  EnrollmentStatus,
  METHOD_LABELS,
  METHOD_TONES,
} from '../../lib/constants.js';
import {
  attendanceTone,
  formatClock,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  pluralize,
} from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import useCountdown from '../../hooks/useCountdown.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import usePolling from '../../hooks/usePolling.js';
import useResource from '../../hooks/useResource.js';

/**
 * How often the "open right now" card re-asks.
 *
 * The teacher's live view polls every 3 seconds because a roster filling up under
 * their eyes is the whole point of that screen. Here the answer only changes when
 * a teacher starts or ends a session, so 20 seconds is fast enough that walking
 * into a lecture and opening the page finds it, and slow enough not to spend a
 * phone battery discovering nothing.
 */
const OPEN_POLL_MS = 20000;

/** Enough to recognise the last few lectures. The full register has its own page. */
const RECENT_LIMIT = 6;

/**
 * A closing time, worded for the distance to it.
 *
 * mm:ss reads as a countdown, which is right for the last few minutes of a
 * lecture and wrong for a session that stays open all afternoon.
 */
function closesIn(seconds) {
  if (seconds >= 3600) return formatDuration(Math.round(seconds / 60));
  return formatClock(seconds);
}

/**
 * A student's own view of the register.
 *
 * Two independent reads, deliberately: `GET /api/attendance/me` is the settled
 * history and is fetched once, while `GET /api/attendance/me/open-sessions` is a
 * question whose answer expires and is polled. Putting them behind one loader
 * would mean re-computing every subject percentage every twenty seconds to find
 * out whether a QR session had opened.
 */
export default function StudentDashboard() {
  useDocumentTitle('Overview');
  const { user, student } = useAuth();

  const mine = useResource(() => AttendanceAPI.mine({ limit: RECENT_LIMIT }), []);
  // `myOpenSessions` takes no request config, so the poll's AbortSignal cannot be
  // forwarded. usePolling ignores a superseded response either way; the only cost
  // is that an abandoned request finishes on the wire.
  const open = usePolling(() => AttendanceAPI.myOpenSessions(), OPEN_POLL_MS);

  const report = (mine.data && mine.data.report) || null;
  const history = (mine.data && mine.data.history) || [];
  const overall = (report && report.overall) || null;
  const subjects = (report && report.subjects) || [];

  // Read from this response, not from the signed-in user: `user.student` was
  // serialised when the session began, so a student who enrolled five minutes ago
  // would still be told to enroll. `/me` counts it now.
  const enrollment = (mine.data && mine.data.enrollment) || null;
  const faceDone = Boolean(enrollment && enrollment.face_enrolled);
  const voiceDone = Boolean(enrollment && enrollment.voice_enrolled);
  const enrolled = Boolean(enrollment && enrollment.status === EnrollmentStatus.COMPLETE);

  const sessions = (open.data && open.data.sessions) || [];
  const waiting = sessions.filter((row) => !row.already_present);
  const short = subjects.filter((row) => row.below_threshold);

  const firstName = ((user && user.name) || '').trim().split(/\s+/)[0];

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">{firstName ? `Hello, ${firstName}` : 'Your attendance'}</h1>
          <p className="page-sub">
            {student && student.roll_number ? (
              <>
                Roll number <span className="mono">{student.roll_number}</span>.{' '}
              </>
            ) : null}
            Everything the register holds about you, and anything you can check in to right now.
          </p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={mine.reload} loading={mine.loading}>
            Refresh
          </Button>
          {/* A Link, not a Button: this navigates, and a real anchor keeps
              middle-click and "open in new tab" working. */}
          <Link className="btn btn-primary" to="/student/check-in">
            {waiting.length ? `Check in to ${pluralize(waiting.length, 'session')}` : 'Check in'}
          </Link>
        </div>
      </div>

      {enrollment && !enrolled ? (
        <Alert
          tone="warn"
          title={
            !faceDone && !voiceDone
              ? 'Your face and your voice are both still missing'
              : !faceDone
                ? 'Your face is not enrolled yet'
                : 'Your voice is not enrolled yet'
          }
          actions={
            <Link className="btn btn-sm btn-primary" to="/enroll">
              Finish enrollment
            </Link>
          }
        >
          {!faceDone ? (
            <p>
              A class photo is matched against enrolled faces. Until yours is on file the photo
              cannot find you and a teacher has to mark you by hand.
            </p>
          ) : null}
          {!voiceDone ? (
            <p>
              Voice check-in compares your passphrase against your enrolled voice. Until it is on
              file, a voice session will turn you away at the door.
            </p>
          ) : null}
        </Alert>
      ) : null}

      <OpenSessions poll={open} />

      {mine.error && !mine.data ? (
        <ErrorState
          error={mine.error}
          onRetry={mine.reload}
          title="Could not read your attendance"
        />
      ) : mine.loading && !mine.data ? (
        <LoadingBlock label="Reading the register…" />
      ) : report && overall ? (
        <>
          <StatGrid>
            <StatTile
              label="Overall"
              value={formatPercent(overall.percentage, { digits: 1 })}
              // Deliberately not `attendanceTone`: the requirement is per-subject,
              // so this figure has no single line to be above or below. Colouring
              // it against 75% would invent a rule the server does not apply.
              tone="info"
              meta="every subject you are on, together"
            />
            <StatTile
              label="Marked present"
              value={formatNumber(overall.present)}
              tone="muted"
              meta={`of ${pluralize(overall.total, 'session')} held`}
            />
            <StatTile
              label="Missed"
              value={formatNumber(Math.max(0, overall.total - overall.present))}
              tone={overall.total > overall.present ? 'warn' : 'success'}
              meta="the register says absent"
            />
            <StatTile
              label="Subjects below the line"
              value={formatNumber(short.length)}
              tone={short.length ? 'danger' : 'success'}
              meta={short.length ? 'you are in the defaulter report' : 'all of them clear'}
            />
          </StatGrid>

          <div className="grid grid-2">
            <Card
              title="Subject by subject"
              subtitle={
                subjects.length > 1
                  ? 'Lowest first. The server sorts them this way, so the one at the top is the one to fix.'
                  : undefined
              }
            >
              {subjects.length ? (
                <div className="stack">
                  {subjects.map((row) => (
                    <SubjectRow key={row.subject_id} row={row} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="You are not on any subject's roster"
                  message="A teacher adds you to a subject. Until then there is nothing to attend and nothing to count."
                />
              )}
            </Card>

            <Card
              title="Recently"
              subtitle="How each of your last few sessions was recorded."
              actions={
                <Link className="btn btn-sm btn-secondary" to="/student/attendance">
                  Full record
                </Link>
              }
            >
              {history.length ? (
                <div className="timeline">
                  {history.map((entry) => (
                    <HistoryItem key={entry.session_id} entry={entry} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="Nothing recorded yet"
                  message="Your first check-in — or the first class photo you appear in — starts this list."
                />
              )}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Sessions a student can act on, re-asked on a timer.
 *
 * A polling failure is reported inline rather than as an ErrorState: the rest of
 * the page is a settled read and is still true, so replacing it with an error
 * screen because one poll timed out would hide correct information.
 */
function OpenSessions({ poll }) {
  const sessions = (poll.data && poll.data.sessions) || [];
  // `GET /me/open-sessions` short-circuits to `{sessions: []}` — with no
  // `server_time` — for a student on nobody's roster. That is a different
  // situation from "nothing is running", and saying so saves a support question.
  const noRoster = Boolean(poll.data && !poll.data.server_time && !sessions.length);

  return (
    <Card
      title="Open right now"
      subtitle={
        noRoster
          ? undefined
          : 'Sessions where the next move is yours. Photo-only sessions are the teacher’s job and never appear here.'
      }
      actions={
        <div className="row row-sm">
          {poll.lastUpdatedAt ? (
            <span className="small faint">Checked {formatRelative(poll.lastUpdatedAt)}</span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={poll.refresh} loading={poll.loading}>
            Check now
          </Button>
        </div>
      }
    >
      {poll.error && !poll.data ? (
        <Alert tone="danger" title="Could not check for open sessions">
          {poll.error.message}
        </Alert>
      ) : noRoster ? (
        <EmptyState
          title="You are not enrolled on any subject"
          message="Nothing can be open for you until a teacher puts you on a roster. Your enrollment photos and passphrase can be recorded now regardless."
        />
      ) : sessions.length ? (
        <div className="stack">
          {sessions.map((session) => (
            <OpenSessionRow key={session.session_id} session={session} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="Nothing open"
          message="When a teacher starts a QR or voice session on one of your subjects it appears here within twenty seconds."
        />
      )}
    </Card>
  );
}

/**
 * One open session.
 *
 * `closes_at` is `iso(end_time)` and a session created without an end time has
 * none, so the countdown is optional — rendering "0:00 left" for a session with
 * no closing time would read as "too late" when in fact nothing has expired.
 */
function OpenSessionRow({ session }) {
  const { secondsLeft, expired } = useCountdown(session.closes_at);
  const voice = session.action === 'voice';
  const blocked = voice && session.needs_voice_enrollment;

  return (
    <div className="stack-sm">
      <div className="row between row-wrap">
        <div className="row row-sm row-wrap">
          <span className="strong">{session.subject || 'Unknown subject'}</span>
          {session.subject_code ? <Pill>{session.subject_code}</Pill> : null}
          <Badge tone={voice ? 'info' : 'primary'}>{session.mode_label}</Badge>
        </div>
        <div className="row row-sm row-wrap">
          {session.already_present ? (
            <Badge tone="success" dot>
              Already marked present
            </Badge>
          ) : session.closes_at ? (
            expired ? (
              <Badge tone="warn">Closing</Badge>
            ) : (
              <span className="small muted">
                <span className="qr-countdown">{closesIn(secondsLeft)}</span> left
              </span>
            )
          ) : (
            <span className="small faint">Open until the teacher ends it</span>
          )}
        </div>
      </div>

      {session.title ? <span className="small muted truncate">{session.title}</span> : null}

      {session.already_present ? (
        <span className="small faint">
          Nothing to do. Checking in twice cannot mark you twice — the record already exists.
        </span>
      ) : blocked ? (
        <div className="row row-sm row-wrap">
          <Link className="btn btn-sm btn-secondary" to="/enroll">
            Record your passphrase
          </Link>
          <span className="small muted">
            This session verifies by voice and yours is not on file, so there is nothing to compare
            a recording against.
          </span>
        </div>
      ) : (
        <div className="row row-sm row-wrap">
          <Link className="btn btn-sm btn-primary" to="/student/check-in">
            {voice ? 'Check in by voice' : 'How to check in'}
          </Link>
          {!voice ? (
            <span className="small muted">
              Point your phone’s camera at the code the teacher is showing.
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * One subject's standing, against its own requirement.
 *
 * `threshold` arrives on the row because `effective_threshold` has already
 * resolved subject → institution → built-in default server side. Re-deriving it
 * here from the institution's setting would silently ignore a subject override.
 */
function SubjectRow({ row }) {
  const tone = attendanceTone(row.percentage, row.threshold);

  return (
    <div className="stack-sm">
      <div className="row between row-wrap">
        <div className="row row-sm row-wrap">
          <span className="strong">{row.subject_name || 'Unknown subject'}</span>
          {row.subject_code ? <Pill>{row.subject_code}</Pill> : null}
          {row.below_threshold ? <Badge tone="danger">short</Badge> : null}
        </div>
        <div className="row row-sm">
          <Badge tone={tone}>{formatPercent(row.percentage, { digits: 1 })}</Badge>
          <span className="small faint">
            needs {formatPercent(row.threshold, { digits: 0 })}
          </span>
        </div>
      </div>
      <ProgressBar value={row.percentage} tone={tone} />
      <span className="small muted">
        {formatNumber(row.present)} of {formatNumber(row.total)} attended ·{' '}
        {formatNumber(row.absent)} missed
      </span>
    </div>
  );
}

/** One row of the register, with the method that produced it. */
function HistoryItem({ entry }) {
  const present = entry.status === AttendanceStatus.PRESENT;

  return (
    <div className="timeline-item">
      <span className="timeline-dot" aria-hidden="true" />
      <div className="timeline-body stack-sm">
        <div className="row between row-wrap">
          <span className="strong">{entry.subject_name || 'Unknown subject'}</span>
          <span className="small faint" title={formatDateTime(entry.session_start)}>
            {formatRelative(entry.session_start)}
          </span>
        </div>
        <div className="row row-sm row-wrap">
          <Badge tone={present ? 'success' : 'danger'} dot>
            {present ? 'Present' : 'Absent'}
          </Badge>
          {/* An absent row has no method: nothing recognised anybody. */}
          {present && entry.method_used ? (
            <Badge tone={METHOD_TONES[entry.method_used] || 'muted'}>
              {METHOD_LABELS[entry.method_used] || METHOD_LABELS.unknown}
            </Badge>
          ) : null}
          {entry.was_manual_override ? <Pill tone="warn">set by a teacher</Pill> : null}
          {entry.session_title ? (
            <span className="small muted truncate">{entry.session_title}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
