import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import ModePicker from '../../components/ModePicker.jsx';
import SubjectPicker from '../../components/SubjectPicker.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  LoadingBlock,
  Modal,
  Pill,
  Select,
  Table,
} from '../../components/ui/index.js';
import { SessionsAPI, SubjectsAPI } from '../../lib/api.js';
import { SessionStatus, VerificationMode } from '../../lib/constants.js';
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
import useResource from '../../hooks/useResource.js';
import { useToast } from '../../context/ToastContext.jsx';

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: SessionStatus.ACTIVE, label: 'Active' },
  { value: SessionStatus.ENDED, label: 'Ended' },
];

/** `clamp_int(duration_minutes, 60, minimum=5, maximum=720)` in `routes/sessions.py`. */
const DURATION_OPTIONS = [
  { value: '30', label: '30 minutes' },
  { value: '45', label: '45 minutes' },
  { value: '60', label: '1 hour' },
  { value: '90', label: '1 hour 30' },
  { value: '120', label: '2 hours' },
  { value: '180', label: '3 hours' },
  { value: '240', label: '4 hours' },
];

/** What the row's status column says, in one place because three things read it. */
function statusOf(session) {
  if (session.status === SessionStatus.ENDED) return { tone: 'muted', label: 'Ended' };
  if (session.is_open) return { tone: 'success', label: 'Open' };
  return { tone: 'warn', label: 'Window closed' };
}

/**
 * Every session the caller can act on, and the form that opens a new one.
 *
 * A teacher's day starts here: open a session, walk into the room, and the live
 * console does the rest. The list is deliberately not polled — it is a register of
 * what happened, and the only row that changes under you is one you are about to
 * click into anyway.
 */
export default function SessionsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  useDocumentTitle('Sessions');

  const [subjectId, setSubjectId] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);

  const subjects = useResource(() => SubjectsAPI.list(), []);
  const sessions = useResource(
    () => SessionsAPI.list({ subject_id: subjectId, status }),
    [subjectId, status],
  );

  const subjectList = (subjects.data && subjects.data.subjects) || [];
  const rows = (sessions.data && sessions.data.sessions) || [];
  const openSubjectIds = useMemo(
    () =>
      new Set(
        rows
          .filter((session) => session.status === SessionStatus.ACTIVE && session.is_open)
          .map((session) => session.subject && session.subject.id)
          .filter(Boolean),
      ),
    [rows],
  );

  const columns = [
    {
      key: 'start_time',
      header: 'When',
      nowrap: true,
      render: (session) => (
        <div className="stack-sm">
          <span className="strong">{formatDateTime(session.start_time)}</span>
          <span className="small faint">{formatRelative(session.start_time)}</span>
        </div>
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      render: (session) => (
        <div className="stack-sm">
          <span className="strong truncate">
            {session.title || (session.subject && session.subject.name) || 'Session'}
          </span>
          <span className="small faint">
            {session.subject
              ? `${session.subject.code ? `${session.subject.code} · ` : ''}${session.subject.name}`
              : 'Subject removed'}
          </span>
        </div>
      ),
    },
    {
      key: 'mode_label',
      header: 'Mode',
      render: (session) => <Pill>{session.mode_label}</Pill>,
    },
    {
      key: 'present_count',
      header: 'Present',
      align: 'right',
      nowrap: true,
      render: (session) => {
        // The server sends both numbers; dividing them here is presentation, not
        // a recomputed statistic — the percentage nobody exports.
        const size = Number(session.roster_size) || 0;
        const present = Number(session.present_count) || 0;
        return (
          <div className="stack-sm">
            <span className="strong mono">
              {present} / {size}
            </span>
            <span className="small faint">
              {size ? formatPercent((present / size) * 100, { digits: 0 }) : '—'}
            </span>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      nowrap: true,
      render: (session) => {
        const state = statusOf(session);
        return (
          <Badge tone={state.tone} dot>
            {state.label}
          </Badge>
        );
      },
    },
    {
      key: 'go',
      header: '',
      align: 'right',
      nowrap: true,
      // A link, not a button: middle-click and "open in new tab" are how a teacher
      // keeps the live console up on the projector while working elsewhere.
      render: (session) => (
        <Link className="btn btn-secondary btn-sm" to={`/sessions/${session.id}`}>
          {session.status === SessionStatus.ENDED ? 'View' : 'Open live'}
        </Link>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Sessions</h1>
          <p className="page-sub">
            Every class you have opened, newest first. Open one to run the roster, project the QR
            code or match a class photo.
          </p>
        </div>
        <div className="page-actions">
          <Button onClick={() => setCreating(true)} disabled={subjectList.length === 0}>
            New session
          </Button>
        </div>
      </div>

      {/* Nothing on this page works without a subject, and the picker's own
          disabled state cannot say what to do about it. */}
      {!subjects.loading && subjectList.length === 0 ? (
        <Alert
          tone="info"
          title="No subjects yet"
          actions={
            <Link className="btn btn-primary btn-sm" to="/subjects">
              Go to Subjects
            </Link>
          }
        >
          A session belongs to a subject and marks its roster, so create a subject and add students
          to it first.
        </Alert>
      ) : null}

      <Card
        title="Filter"
        subtitle="Both filters go to the server, so the row limit applies to what you asked for."
      >
        <div className="form-grid">
          <SubjectPicker
            value={subjectId}
            onChange={setSubjectId}
            subjects={subjectList}
            includeAll
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          />
        </div>
      </Card>

      {sessions.error && !sessions.data ? (
        <ErrorState
          error={sessions.error}
          onRetry={sessions.reload}
          title="Could not load sessions"
        />
      ) : sessions.loading && !sessions.data ? (
        <LoadingBlock label="Loading sessions…" />
      ) : (
        <Card
          flush
          title={rows.length ? pluralize(rows.length, 'session') : 'Sessions'}
          subtitle={
            rows.length >= 50
              ? 'Showing the 50 most recent. Narrow by subject to see further back.'
              : undefined
          }
          actions={
            <Button variant="ghost" size="sm" onClick={sessions.reload} loading={sessions.loading}>
              Refresh
            </Button>
          }
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey="id"
            loading={sessions.loading}
            onRowClick={(session) => navigate(`/sessions/${session.id}`)}
            empty={
              <EmptyState
                title={subjectId || status ? 'No sessions match those filters' : 'No sessions yet'}
                message={
                  subjectId || status
                    ? 'Try clearing the filters, or open a session for this subject.'
                    : 'Open one as class begins — it takes about ten seconds.'
                }
                action={
                  <Button onClick={() => setCreating(true)} disabled={subjectList.length === 0}>
                    New session
                  </Button>
                }
              />
            }
          />
        </Card>
      )}

      <NewSessionDialog
        open={creating}
        subjects={subjectList}
        openSubjectIds={openSubjectIds}
        onClose={() => setCreating(false)}
        onCreated={(payload) => {
          setCreating(false);
          const created = payload.session;
          toast.success(`Session open — ${created.mode_label}.`);
          // Coverage only comes back for photo modes, and a gap is the single
          // biggest reason a class photo marks nobody. Pinned, because it is
          // advice the teacher needs to act on before the lesson, not a receipt.
          const coverage = payload.coverage;
          if (coverage && coverage.roster_size && coverage.face_enrolled < coverage.roster_size) {
            const missing = coverage.roster_size - coverage.face_enrolled;
            toast.warn(
              `${pluralize(missing, 'student')} on this roster ${missing === 1 ? 'has' : 'have'} no face enrolled, so a class photo can never match them. Mark them from the roster, or send them to enroll.`,
              { title: 'Incomplete face enrollment', duration: 0 },
            );
          }
          navigate(`/sessions/${created.id}`);
        }}
      />
    </div>
  );
}

/**
 * The create form.
 *
 * A modal rather than a route: it is four decisions, and one of them (the mode) is
 * irreversible, so keeping the list visible behind it means the teacher can still
 * see that this morning's session is already open.
 */
function NewSessionDialog({ open, subjects, openSubjectIds, onClose, onCreated }) {
  const [subjectId, setSubjectId] = useState('');
  const [mode, setMode] = useState(VerificationMode.CLASS_PHOTO_QR);
  const [title, setTitle] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [startAt, setStartAt] = useState(() => toLocalInputValue(new Date()));
  const [duration, setDuration] = useState('60');

  const create = useAsync((payload) => SessionsAPI.create(payload), { onSuccess: onCreated });

  // Remount-free reset: the dialog returns `null` when closed, but this component
  // stays mounted, so the state has to be cleared on the way out.
  const close = () => {
    create.reset();
    onClose();
  };

  const submit = (event) => {
    event.preventDefault();
    if (!subjectId) return;
    create.run({
      subject_id: subjectId,
      verification_mode: mode,
      title: title.trim() || undefined,
      // Omitted rather than sent when starting now: the server stamps its own
      // clock, which is the one the 30-second QR window is measured against.
      start_time: startNow ? undefined : fromLocalInputValue(startAt),
      duration_minutes: Number(duration),
    });
  };

  const error = create.error;
  // 409 with a `session_id` means the teacher's real intent — "I want a live
  // session for this subject" — is already satisfied by an existing one.
  const existingId = error && error.status === 409 && error.details && error.details.session_id;
  const rosterHint = error && error.status === 409 && error.details && error.details.hint;
  const alreadyOpen = subjectId && openSubjectIds.has(subjectId);

  return (
    <Modal
      open={open}
      title="Open a session"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={create.loading}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-session-form"
            loading={create.loading}
            disabled={!subjectId}
          >
            Open session
          </Button>
        </>
      }
    >
      {/* The form owns submission so Enter works in the text fields, and the footer
          button reaches it by `form=` from outside the form element. */}
      <form id="new-session-form" className="stack" onSubmit={submit} noValidate>
        {error ? (
          <Alert
            tone={error.status === 409 ? 'warn' : 'danger'}
            title={error.status === 409 ? 'That is not possible yet' : 'The session was not created'}
            actions={
              existingId ? (
                <Link className="btn btn-primary btn-sm" to={`/sessions/${existingId}`}>
                  Go to the open session
                </Link>
              ) : rosterHint && subjectId ? (
                <Link className="btn btn-primary btn-sm" to={`/subjects/${subjectId}`}>
                  Add students
                </Link>
              ) : null
            }
          >
            {error.message}
          </Alert>
        ) : null}

        <SubjectPicker value={subjectId} onChange={setSubjectId} subjects={subjects} />

        {/* Known before the round trip, from the list already on screen. Saying it
            here beats letting the teacher fill the form in and then hit the 409. */}
        {alreadyOpen && !existingId ? (
          <Alert tone="info" title="This subject already has an open session">
            Only one session per subject can be open at a time — end that one first, or pick a
            different subject.
          </Alert>
        ) : null}

        <ModePicker value={mode} onChange={setMode} />

        <Input
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Week 6 — Hash tables"
          hint="Optional. Shown to students on their check-in screen; the subject name is used if you leave it blank."
          maxLength={120}
        />

        <Checkbox
          label="Start now"
          checked={startNow}
          onChange={(event) => setStartNow(event.target.checked)}
          hint="Uncheck to schedule the session ahead of time."
        />

        <div className="form-grid">
          {!startNow ? (
            <Input
              label="Starts"
              type="datetime-local"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
              required
            />
          ) : null}
          <Select
            label="Runs for"
            options={DURATION_OPTIONS}
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            hint="When the window closes, self-service check-in stops. You can extend it later, and the register stays editable until you end the session."
          />
        </div>
      </form>
    </Modal>
  );
}
