import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import ClassPhotoUploader from '../../components/ClassPhotoUploader.jsx';
import OverrideDialog from '../../components/OverrideDialog.jsx';
import QrPanel from '../../components/QrPanel.jsx';
import ReviewQueue from '../../components/ReviewQueue.jsx';
import RosterTable from '../../components/RosterTable.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Input,
  LoadingBlock,
  Modal,
  StatGrid,
  StatTile,
  Tabs,
} from '../../components/ui/index.js';
import { AttendanceAPI, SessionsAPI } from '../../lib/api.js';
import { LIVE_POLL_MS, SessionStatus } from '../../lib/constants.js';
import {
  formatDateTime,
  formatPercent,
  formatRelative,
  fromLocalInputValue,
  pluralize,
  toLocalInputValue,
} from '../../lib/format.js';
import useAsync from '../../hooks/useAsync.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import usePolling from '../../hooks/usePolling.js';
import useResource from '../../hooks/useResource.js';
import { useToast } from '../../context/ToastContext.jsx';

/**
 * The live session console: roster, QR, class photo and review queue in one place.
 *
 * Everything on this page comes from **one** polled endpoint. `GET
 * /api/sessions/:id/live` returns the session, the full roster with attendance
 * state, the counts, the unresolved review count and — when the mode uses QR — a
 * fresh QR token, because rotation happens inside the same call. Polling it every
 * 3 s therefore keeps the projected code moving with no second timer and no
 * request of its own. It is the only endpoint in the product that is deliberately
 * un-rate-limited, and the only thing this app polls.
 *
 * The review *items* are the exception: they carry base64 crops and would bloat
 * every poll, so they are fetched separately and re-fetched only when the polled
 * count changes.
 */
export default function SessionLive() {
  const { sessionId } = useParams();
  const toast = useToast();

  const [tab, setTab] = useState('roster');
  // `{ target, present }` — target is one roster row or an array of them, which is
  // what lets one dialog collect one reason for either case.
  const [override, setOverride] = useState(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busyStudentId, setBusyStudentId] = useState(null);

  const poll = usePolling(
    (signal) => SessionsAPI.live(sessionId, { signal }),
    LIVE_POLL_MS,
  );

  const live = poll.data;
  const session = live && live.session;
  const roster = (live && live.roster) || [];
  const reviewCount = (live && live.review_queue_count) || 0;

  useDocumentTitle(
    session ? `${(session.subject && session.subject.name) || 'Session'} · Live` : 'Live session',
  );

  // Keyed on the count, so resolving one item elsewhere or a new photo arriving
  // pulls the queue again — but a steady queue costs nothing per poll.
  const review = useResource(
    () => (reviewCount > 0 ? SessionsAPI.review(sessionId) : Promise.resolve({ items: [] })),
    [sessionId, reviewCount],
  );
  const reviewItems = (review.data && review.data.items) || [];

  const endSession = useAsync(() => SessionsAPI.end(sessionId), {
    onSuccess: () => {
      setConfirmEnd(false);
      toast.success('Session ended. The register is now final.');
      poll.refresh();
    },
    onError: (error) => toast.notifyError(error),
  });

  const exportCsv = useAsync(() => SessionsAPI.export(sessionId), {
    onSuccess: () => toast.success('Export downloaded.'),
    onError: (error) => toast.notifyError(error),
  });

  const applyOverride = async (reason) => {
    const { target, present } = override;
    const bulk = Array.isArray(target);
    setBusyStudentId(bulk ? null : target.student_id);
    try {
      if (bulk) {
        const result = await AttendanceAPI.overrideBulk({
          session_id: sessionId,
          student_ids: target.map((row) => row.student_id),
          present,
          reason,
        });
        const skipped = (result.skipped || []).length;
        toast.success(
          `${pluralize(result.applied_count, 'student')} marked ${present ? 'present' : 'absent'}.` +
            (skipped ? ` ${pluralize(skipped, 'student')} skipped — no longer on the roster.` : ''),
        );
      } else {
        await AttendanceAPI.override({
          session_id: sessionId,
          student_id: target.student_id,
          present,
          reason,
        });
        toast.success(`${target.name} marked ${present ? 'present' : 'absent'}.`);
      }
      setOverride(null);
    } catch (error) {
      // Known defect in backend 1.0.0: `POST /api/attendance/override` writes the
      // record and the audit entry, then fails to serialise its own response
      // (`MarkResult.record` carries raw `ObjectId`s and there is no custom JSON
      // provider), so a successful override is reported as a 500. See the appendix
      // of docs/api-reference.md. Telling the teacher it failed would be worse
      // than useless — they would do it again. Re-read the roster and say what is
      // actually true.
      if (error.status === 500 && !Array.isArray(target)) {
        toast.warn(
          'The server did not confirm the override, but it usually still applied. Check the row below — if it did not change, try again.',
          { title: 'Unconfirmed', duration: 9000 },
        );
        setOverride(null);
      } else {
        toast.notifyError(error);
      }
    } finally {
      setBusyStudentId(null);
      poll.refresh();
    }
  };

  const tabs = useMemo(() => {
    if (!session) return [];
    const list = [{ key: 'roster', label: 'Roster', badge: roster.length || undefined }];
    if (session.uses_photo) list.push({ key: 'photo', label: 'Class photo' });
    if (session.uses_qr) list.push({ key: 'qr', label: 'QR code' });
    if (session.uses_voice) list.push({ key: 'voice', label: 'Voice' });
    if (session.uses_photo) {
      list.push({ key: 'review', label: 'Review', badge: reviewCount || undefined });
    }
    return list;
  }, [session, roster.length, reviewCount]);

  if (poll.error && !live) {
    return <ErrorState error={poll.error} onRetry={poll.refresh} title="Could not load the session" />;
  }
  if (!live) return <LoadingBlock label="Loading the session…" />;

  const isOpen = session.is_open;
  const ended = session.status === SessionStatus.ENDED;
  const rate = session.roster_size
    ? (session.present_count / session.roster_size) * 100
    : null;
  // The requested tab can disappear when a session ends (QR stops being issued).
  const activeTab = tabs.some((entry) => entry.key === tab) ? tab : 'roster';

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">
            {session.title || (session.subject && session.subject.name) || 'Session'}
          </h1>
          <p className="page-sub">
            {session.subject ? (
              <Link to={`/subjects/${session.subject.id}`}>
                {session.subject.code ? `${session.subject.code} · ` : ''}
                {session.subject.name}
              </Link>
            ) : null}
            {' — '}
            {session.mode_label}
            {session.end_time ? ` · ends ${formatRelative(session.end_time)}` : ''}
          </p>
        </div>
        <div className="page-actions">
          <Badge tone={ended ? 'muted' : isOpen ? 'success' : 'warn'} dot>
            {ended ? 'Ended' : isOpen ? 'Open' : 'Window closed'}
          </Badge>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button variant="secondary" onClick={() => exportCsv.run()} loading={exportCsv.loading}>
            Export CSV
          </Button>
          {!ended ? (
            <Button variant="danger" onClick={() => setConfirmEnd(true)}>
              End session
            </Button>
          ) : null}
        </div>
      </div>

      {/* A closed window with an active status is the confusing state: self-service
          check-in has stopped but the session is not finalised, and only an
          explicit sentence explains why students report the QR is dead. The action
          is the remedy — `PATCH /api/sessions/:id` moves `end_time`, and because
          `_is_open` checks the status first, that reopens check-in for a session
          that has not been ended. */}
      {!isOpen && !ended ? (
        <Alert
          tone="warn"
          title="The check-in window has closed"
          actions={
            <Button size="sm" onClick={() => setEditing(true)}>
              Extend the window
            </Button>
          }
        >
          This session ran past {formatDateTime(session.end_time)}, so QR and voice check-in are no
          longer accepted. You can still mark students by hand, and the register stays editable until
          you end the session.
        </Alert>
      ) : null}

      {/* Poll failures are shown but not fatal: stale numbers with a warning beat
          throwing away a screen the teacher is mid-way through using. */}
      {poll.error ? (
        <Alert tone="warn" title="Live updates have stopped">
          {poll.error.message}
          {poll.consecutiveErrors > 3
            ? ' Retrying less often now — press Export or reload once the backend is back.'
            : ''}
        </Alert>
      ) : null}

      <StatGrid>
        <StatTile label="Present" value={session.present_count ?? 0} tone="success" />
        <StatTile label="Absent" value={session.absent_count ?? 0} tone="muted" />
        <StatTile
          label="Attendance"
          value={rate === null ? '—' : formatPercent(rate, { digits: 0 })}
          tone="info"
          meta={`of ${pluralize(session.roster_size ?? 0, 'student')}`}
        />
        <StatTile
          label="Awaiting review"
          value={reviewCount}
          tone={reviewCount ? 'warn' : 'muted'}
          meta={reviewCount ? 'faces the photo was unsure about' : 'nothing pending'}
        />
      </StatGrid>

      <Tabs tabs={tabs} active={activeTab} onChange={setTab} />

      {activeTab === 'roster' ? (
        <Card
          flush
          title="Roster"
          subtitle="Present first, then alphabetical — so your eye lands on who is still missing."
          actions={
            poll.lastUpdatedAt ? (
              <span className="small faint" aria-live="polite">
                Updated {formatRelative(poll.lastUpdatedAt)}
              </span>
            ) : null
          }
        >
          <RosterTable
            rows={roster}
            busyStudentId={busyStudentId}
            onOverride={ended ? undefined : (target, present) => setOverride({ target, present })}
          />
        </Card>
      ) : null}

      {activeTab === 'photo' ? (
        <Card
          title="Class photo"
          subtitle="One photo of the room. Confident matches are marked present; anything uncertain goes to Review."
        >
          {ended ? (
            <Alert tone="muted" title="This session has ended">
              A photo can only be matched against an open session.
            </Alert>
          ) : (
            <ClassPhotoUploader
              sessionId={sessionId}
              onResult={() => {
                poll.refresh();
                review.reload();
              }}
            />
          )}
        </Card>
      ) : null}

      {activeTab === 'qr' ? (
        <Card
          title="QR check-in"
          subtitle="Project this. The code rotates every 30 seconds; a student scans it from their own signed-in phone."
        >
          {live.qr ? (
            <QrPanel
              sessionId={sessionId}
              qr={live.qr}
              loading={poll.loading}
              // Force-rotates server-side. The polled payload picks the new token
              // up on its next pass, so nothing here has to merge state.
              onRotate={async () => {
                await SessionsAPI.qr(sessionId, true);
                poll.refresh();
              }}
            />
          ) : (
            <Alert tone="muted" title="No code is being issued">
              {ended
                ? 'This session has ended.'
                : 'The check-in window has closed, so the server has stopped issuing codes.'}
            </Alert>
          )}
        </Card>
      ) : null}

      {activeTab === 'voice' ? (
        <Card
          title="Voice check-in"
          subtitle="Students record the passphrase on their own device; their voice is verified against their enrolment."
        >
          <Alert tone="info" title="Nothing to display here">
            Voice check-in happens entirely on the student&apos;s phone — they open{' '}
            <span className="mono">/student/check-in</span>, pick this session and record. Accepted
            check-ins appear on the Roster tab within a few seconds.
          </Alert>
        </Card>
      ) : null}

      {activeTab === 'review' ? (
        review.loading && !review.data ? (
          <LoadingBlock label="Loading the review queue…" />
        ) : review.error ? (
          <ErrorState error={review.error} onRetry={review.reload} title="Could not load the queue" />
        ) : (
          <ReviewQueue
            sessionId={sessionId}
            items={reviewItems}
            roster={roster}
            onResolved={() => {
              poll.refresh();
              review.reload();
            }}
            onDiscardAll={async () => {
              await SessionsAPI.discardReview(sessionId);
              poll.refresh();
              review.reload();
            }}
          />
        )
      ) : null}

      <OverrideDialog
        open={Boolean(override)}
        student={override ? override.target : null}
        present={override ? override.present : false}
        busy={busyStudentId !== null}
        onConfirm={applyOverride}
        onCancel={() => setOverride(null)}
      />

      {/* Mounted only while open, unlike the two dialogs above: its fields are
          seeded from the session that is on screen *now*, and a component that
          stayed mounted would keep the values it was opened with the first time. */}
      {editing ? (
        <EditSessionDialog
          session={session}
          ended={ended}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            toast.success(
              updated.end_time
                ? `Saved. Check-in now runs until ${formatDateTime(updated.end_time)}.`
                : 'Saved.',
            );
            poll.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmEnd}
        title="End this session?"
        message="Self-service check-in stops immediately and students can no longer scan or record. You can still correct the register by hand afterwards, and the reason is logged. This cannot be undone — a new session would be needed instead."
        confirmLabel="End session"
        busy={endSession.loading}
        onConfirm={() => endSession.run()}
        onCancel={() => setConfirmEnd(false)}
      />
    </div>
  );
}

/**
 * `PATCH /api/sessions/:id` — the only two things about a running session that can
 * still change.
 *
 * The title is cosmetic but permanent: it is what the sessions list, the subject
 * report and every CSV export call this class, so a typo outlives the lesson. The
 * end time is the one that matters live — moving it forward is the only way to
 * reopen self-service check-in for a class that overran, and without this dialog a
 * teacher whose window had closed had no remedy but to mark forty students by hand.
 *
 * The verification mode is deliberately absent. The server answers 409 for it, and
 * the reason is sound: students may already have checked in under the original
 * mode, so switching it would leave their recorded `method_used` describing a
 * session that no longer claims to work that way.
 */
function EditSessionDialog({ session, ended, onClose, onSaved }) {
  const [title, setTitle] = useState(session.title || '');
  const [endAt, setEndAt] = useState(session.end_time ? toLocalInputValue(session.end_time) : '');

  const save = useAsync((payload) => SessionsAPI.update(session.id, payload), {
    onSuccess: (data) => onSaved(data.session || {}),
  });

  const titleChanged = title.trim() !== (session.title || '');
  // Compared as input values, not as instants: `toLocalInputValue` drops seconds,
  // so re-serialising the untouched field is the only way to tell "not edited" from
  // "edited back to the same minute" without sending a pointless write.
  const currentEnd = session.end_time ? toLocalInputValue(session.end_time) : '';
  const endChanged = Boolean(endAt) && endAt !== currentEnd;

  // Checked here as well as on the server so the teacher is told before the round
  // trip; the server's own check is the one that counts.
  const startsAt = session.start_time ? new Date(session.start_time) : null;
  const endsBeforeStart =
    endChanged && startsAt && !Number.isNaN(startsAt.getTime())
      ? new Date(endAt) <= startsAt
      : false;

  const nothingToSave = !titleChanged && !endChanged;

  const submit = (event) => {
    event.preventDefault();
    if (nothingToSave || endsBeforeStart) return;
    const payload = {};
    // Only what changed. Sending `title` unchanged would rewrite it — harmless, but
    // an empty string is how the API is told to fall back to the subject name, and
    // that is a decision to make deliberately rather than as a side effect.
    if (titleChanged) payload.title = title.trim();
    if (endChanged) payload.end_time = fromLocalInputValue(endAt);
    save.run(payload);
  };

  return (
    <Modal
      open
      title="Edit this session"
      // A function either way, not `undefined` while saving: dropping the prop
      // would take the × out of the header mid-request and put it back after.
      onClose={() => {
        if (!save.loading) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.loading}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-session-form"
            loading={save.loading}
            disabled={nothingToSave || endsBeforeStart}
          >
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-session-form" className="stack" onSubmit={submit} noValidate>
        {save.error ? (
          <Alert
            tone={save.error.status === 409 ? 'warn' : 'danger'}
            title={save.error.status === 409 ? 'That cannot be changed' : 'Nothing was saved'}
          >
            {save.error.message}
          </Alert>
        ) : null}

        <Input
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={(session.subject && session.subject.name) || 'Attendance'}
          hint="Clear it to fall back to the subject name. Students see this on their check-in screen, and it labels the session in reports and exports."
          maxLength={120}
        />

        {ended ? (
          <Alert tone="muted" title="The window is fixed now">
            This session has been ended, so its register is final and a later closing time cannot
            reopen it. The title is still yours to correct.
          </Alert>
        ) : (
          <Input
            label="Check-in closes"
            type="datetime-local"
            value={endAt}
            onChange={(event) => setEndAt(event.target.value)}
            error={endsBeforeStart ? 'This is before the session started.' : null}
            hint={
              session.start_time
                ? `Started ${formatDateTime(session.start_time)}. Moving this forward reopens QR and voice check-in immediately.`
                : 'Moving this forward reopens QR and voice check-in immediately.'
            }
          />
        )}
      </form>
    </Modal>
  );
}
