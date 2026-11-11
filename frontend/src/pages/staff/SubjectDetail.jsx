import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import TrendChart from '../../components/charts/TrendChart.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingBlock,
  Modal,
  Pill,
  StatGrid,
  StatTile,
  Table,
  Tabs,
} from '../../components/ui/index.js';
import { AdminAPI, AnalyticsAPI, SessionsAPI, SubjectsAPI } from '../../lib/api.js';
import {
  ENROLLMENT_STATUS_LABELS,
  EnrollmentStatus,
  Role,
  SessionStatus,
} from '../../lib/constants.js';
import {
  attendanceTone,
  dayEndIso,
  dayStartIso,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  pluralize,
} from '../../lib/format.js';
import useAsync from '../../hooks/useAsync.js';
import useDebouncedValue from '../../hooks/useDebouncedValue.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';

const ENROLLMENT_TONES = {
  [EnrollmentStatus.INVITED]: 'muted',
  [EnrollmentStatus.PENDING_BIOMETRICS]: 'warn',
  [EnrollmentStatus.COMPLETE]: 'success',
};

/** Trend points the chart can render without the x axis turning into a smear. */
const TREND_LIMIT = 40;

/**
 * One subject: its roster, its report, its sessions and its settings.
 *
 * Four tabs rather than one long page, because they are four different jobs done
 * at four different times — the roster at the start of term, the report at the end
 * of it. Each tab loads its own data on first view, so opening this page to add one
 * student does not also run an analytics aggregation.
 */
export default function SubjectDetail() {
  const { subjectId } = useParams();
  const { isAdmin } = useAuth();

  const [tab, setTab] = useState('roster');

  const detail = useResource(() => SubjectsAPI.get(subjectId), [subjectId]);
  const subject = (detail.data && detail.data.subject) || null;
  const threshold = detail.data ? detail.data.effective_threshold : null;

  useDocumentTitle(subject ? `${subject.code} · ${subject.name}` : 'Subject');

  const tabs = [
    { key: 'roster', label: 'Roster', badge: subject ? subject.roster_size || undefined : undefined },
    { key: 'report', label: 'Report' },
    { key: 'sessions', label: 'Sessions', badge: subject ? subject.session_count || undefined : undefined },
    { key: 'settings', label: 'Settings' },
  ];

  if (detail.error && !detail.data) {
    return <ErrorState error={detail.error} onRetry={detail.reload} title="Could not load the subject" />;
  }
  if (!subject) return <LoadingBlock label="Loading the subject…" />;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">
            <span className="mono">{subject.code}</span> {subject.name}
          </h1>
          <p className="page-sub">
            {pluralize(subject.roster_size || 0, 'student')} ·{' '}
            {pluralize(subject.session_count || 0, 'session')} · {threshold}% required
            {subject.attendance_threshold === null || subject.attendance_threshold === undefined
              ? ' (institution default)'
              : ''}
          </p>
        </div>
        <div className="page-actions">
          {subject.archived ? <Badge tone="muted">Archived</Badge> : null}
          <Link className="btn btn-secondary" to="/sessions">
            All sessions
          </Link>
        </div>
      </div>

      {/* Both of these stop a session being opened at all, and the 409 that would
          report them arrives too late to be useful. */}
      {subject.archived ? (
        <Alert tone="warn" title="This subject is archived">
          It is hidden from pickers and no new session can be opened for it. Its attendance history
          is intact — un-archive it under Settings to use it again.
        </Alert>
      ) : !subject.roster_size ? (
        <Alert
          tone="warn"
          title="Nobody is on this roster"
          actions={
            <Button size="sm" onClick={() => setTab('roster')}>
              Add students
            </Button>
          }
        >
          A session cannot be opened for a subject with an empty roster, because there would be
          nobody to mark.
        </Alert>
      ) : null}

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'roster' ? (
        <RosterPanel subjectId={subjectId} subject={subject} onChanged={detail.reload} />
      ) : null}
      {tab === 'report' ? (
        <ReportPanel subjectId={subjectId} subject={subject} threshold={threshold} />
      ) : null}
      {tab === 'sessions' ? <SubjectSessions subjectId={subjectId} /> : null}
      {tab === 'settings' ? (
        <SettingsPanel
          subject={subject}
          threshold={threshold}
          isAdmin={isAdmin}
          onSaved={detail.reload}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Roster                                                                      */
/* -------------------------------------------------------------------------- */

function RosterPanel({ subjectId, subject, onChanged }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);

  const roster = useResource(() => SubjectsAPI.roster(subjectId), [subjectId]);
  const rows = (roster.data && roster.data.roster) || [];

  const remove = useAsync((student) => SubjectsAPI.removeFromRoster(subjectId, student.student_id), {
    onSuccess: () => {
      toast.success(`${removing.name} removed from this subject.`);
      setRemoving(null);
      roster.reload();
      onChanged();
    },
    onError: (error) => toast.notifyError(error),
  });

  // The number that decides whether class-photo attendance can work at all.
  const faceReady = rows.filter((row) => row.face_enrolled).length;

  const columns = [
    {
      key: 'name',
      header: 'Student',
      render: (row) => (
        <div className="stack-sm">
          <Link className="strong" to={`/students/${row.student_id}`}>
            {row.name}
          </Link>
          <span className="small faint truncate">{row.email}</span>
        </div>
      ),
    },
    {
      key: 'roll_number',
      header: 'Roll no.',
      nowrap: true,
      render: (row) => (row.roll_number ? <span className="mono">{row.roll_number}</span> : '—'),
    },
    {
      key: 'enrollment_status',
      header: 'Enrollment',
      nowrap: true,
      render: (row) => (
        <Badge tone={ENROLLMENT_TONES[row.enrollment_status] || 'muted'}>
          {ENROLLMENT_STATUS_LABELS[row.enrollment_status] || row.enrollment_status || 'Unknown'}
        </Badge>
      ),
    },
    {
      key: 'biometrics',
      header: 'Biometrics',
      nowrap: true,
      render: (row) => (
        <div className="row row-sm">
          <Pill tone={row.face_enrolled ? 'success' : 'muted'}>
            {row.face_enrolled ? 'Face' : 'No face'}
          </Pill>
          <Pill tone={row.voice_enrolled ? 'success' : 'muted'}>
            {row.voice_enrolled ? 'Voice' : 'No voice'}
          </Pill>
        </div>
      ),
    },
    {
      key: 'joined_at',
      header: 'Joined',
      nowrap: true,
      // Not decoration: a student's denominator counts only sessions held since
      // this date, which is why their percentage can differ from a classmate's on
      // the same number of absences.
      render: (row) => (row.joined_at ? formatDate(row.joined_at) : '—'),
    },
    {
      key: 'remove',
      header: '',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <Button variant="ghost" size="sm" onClick={() => setRemoving(row)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <>
      <StatGrid>
        <StatTile label="On the roster" value={formatNumber(rows.length)} tone="info" />
        <StatTile
          label="Face enrolled"
          value={`${faceReady} / ${rows.length}`}
          tone={rows.length && faceReady === rows.length ? 'success' : 'warn'}
          meta="can be matched from a class photo"
        />
        <StatTile
          label="Still to enroll"
          value={formatNumber(
            rows.filter((row) => row.enrollment_status !== EnrollmentStatus.COMPLETE).length,
          )}
          tone="muted"
          meta="have not finished enrollment"
        />
      </StatGrid>

      {roster.error && !roster.data ? (
        <ErrorState error={roster.error} onRetry={roster.reload} title="Could not load the roster" />
      ) : roster.loading && !roster.data ? (
        <LoadingBlock label="Loading the roster…" />
      ) : (
        <Card
          flush
          title="Roster"
          subtitle="Removing a student stops future sessions counting against them and keeps every record already made."
          actions={
            <Button size="sm" onClick={() => setAdding(true)} disabled={subject.archived}>
              Add students
            </Button>
          }
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey="student_id"
            loading={roster.loading}
            empty={
              <EmptyState
                title="Nobody is enrolled yet"
                message="Add students from the institution directory, or invite them first if they have no account."
                action={
                  <Button onClick={() => setAdding(true)} disabled={subject.archived}>
                    Add students
                  </Button>
                }
              />
            }
          />
        </Card>
      )}

      <AddStudentsDialog
        open={adding}
        subjectId={subjectId}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          roster.reload();
          onChanged();
        }}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? `Remove ${removing.name}?` : 'Remove student'}
        message="Their attendance records for this subject stay exactly as they are — they really were in those classes. Removal only stops future sessions counting against them, and they can be added back at any time."
        confirmLabel="Remove from subject"
        busy={remove.loading}
        onConfirm={() => remove.run(removing)}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}

function AddStudentsDialog({ open, subjectId, onClose, onAdded }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const search = useDebouncedValue(query, 200);

  // The endpoint already excludes anyone enrolled and anyone whose account is
  // disabled, and returns the whole institution — so filtering is local and
  // instant rather than a request per keystroke.
  const available = useResource(
    () => (open ? SubjectsAPI.availableStudents(subjectId) : Promise.resolve({ students: [] })),
    [subjectId, open],
  );
  const students = (available.data && available.data.students) || [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return students;
    return students.filter((student) =>
      [student.name, student.email, student.roll_number]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [students, search]);

  const add = useAsync((ids) => SubjectsAPI.addToRoster(subjectId, ids), {
    onSuccess: (result) => {
      const added = (result.added || []).length;
      const already = (result.already_enrolled || []).length;
      toast.success(
        `${pluralize(added, 'student')} added.` +
          (already ? ` ${pluralize(already, 'student')} already enrolled.` : ''),
      );
      setPicked([]);
      setQuery('');
      onAdded();
    },
    onError: (error) => toast.notifyError(error),
  });

  const toggle = (id) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : current.concat(id),
    );

  const close = () => {
    add.reset();
    setPicked([]);
    setQuery('');
    onClose();
  };

  return (
    <Modal
      open={open}
      title="Add students to this subject"
      wide
      onClose={close}
      footer={
        <>
          <span className="small muted grow">
            {picked.length ? `${pluralize(picked.length, 'student')} selected` : 'Nobody selected'}
          </span>
          <Button variant="ghost" onClick={close} disabled={add.loading}>
            Cancel
          </Button>
          <Button onClick={() => add.run(picked)} loading={add.loading} disabled={!picked.length}>
            Add {picked.length || ''}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Input
          label="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, email or roll number"
          type="search"
        />

        {available.error ? (
          <ErrorState
            error={available.error}
            onRetry={available.reload}
            title="Could not load the directory"
          />
        ) : available.loading && !available.data ? (
          <LoadingBlock label="Loading students…" />
        ) : students.length === 0 ? (
          <EmptyState
            title="Everyone is already enrolled"
            message="Every student in the institution is on this roster. Invite more students to add them."
            action={
              <Link className="btn btn-secondary btn-sm" to="/students">
                Go to Students
              </Link>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No match" message={`Nobody matches “${search}”.`} />
        ) : (
          <>
            <div className="row between">
              <span className="small muted">
                {pluralize(filtered.length, 'student')} not on this roster
              </span>
              {/* Selecting a whole filtered list is the realistic bulk case: search
                  a section code, add the section. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setPicked(
                    filtered.every((student) => picked.includes(student.student_id))
                      ? []
                      : filtered.map((student) => student.student_id),
                  )
                }
              >
                {filtered.every((student) => picked.includes(student.student_id))
                  ? 'Clear selection'
                  : 'Select all shown'}
              </Button>
            </div>
            <div className="stack-sm">
              {filtered.map((student) => (
                <Checkbox
                  key={student.student_id}
                  label={`${student.name}${student.roll_number ? ` · ${student.roll_number}` : ''}`}
                  hint={`${student.email}${student.face_enrolled ? '' : ' — no face enrolled yet'}`}
                  checked={picked.includes(student.student_id)}
                  onChange={() => toggle(student.student_id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

function ReportPanel({ subjectId, subject, threshold }) {
  const toast = useToast();
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const params = useMemo(
    () => ({ since: dayStartIso(since), until: dayEndIso(until) }),
    [since, until],
  );

  const report = useResource(() => AnalyticsAPI.subject(subjectId, params), [subjectId, params]);
  const trend = useResource(
    () => AnalyticsAPI.subjectTrend(subjectId, { ...params, limit: TREND_LIMIT }),
    [subjectId, params],
  );

  const data = report.data;
  const students = (data && data.students) || [];
  const points = (trend.data && trend.data.points) || [];

  const exportCsv = useAsync(() => AnalyticsAPI.exportSubject(subjectId, params), {
    onSuccess: () => toast.success('Export downloaded.'),
    onError: (error) => toast.notifyError(error),
  });

  const columns = [
    {
      key: 'name',
      header: 'Student',
      render: (row) => (
        <div className="stack-sm">
          <Link className="strong" to={`/students/${row.student_id}`}>
            {row.name}
          </Link>
          <span className="small faint truncate">{row.email}</span>
        </div>
      ),
    },
    {
      key: 'roll_number',
      header: 'Roll no.',
      nowrap: true,
      render: (row) => (row.roll_number ? <span className="mono">{row.roll_number}</span> : '—'),
    },
    {
      key: 'present',
      header: 'Attended',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <span className="mono">
          {row.present} / {row.total}
        </span>
      ),
    },
    {
      key: 'percentage',
      header: 'Attendance',
      align: 'right',
      nowrap: true,
      // The server computed this against a denominator that excludes sessions held
      // before the student joined and sessions nobody attended. Recomputing it from
      // present/total here would quietly disagree with the CSV.
      render: (row) => (
        <Badge tone={attendanceTone(row.percentage, data ? data.threshold : 75)}>
          {formatPercent(row.percentage, { digits: 0 })}
        </Badge>
      ),
    },
    {
      key: 'below_threshold',
      header: '',
      align: 'right',
      nowrap: true,
      render: (row) => (row.below_threshold ? <Badge tone="danger">Defaulter</Badge> : null),
    },
  ];

  return (
    <>
      <Card
        title="Range"
        subtitle="Leave both blank for all time. The range applies to the table, the chart and the export together."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => exportCsv.run()}
            loading={exportCsv.loading}
          >
            Export CSV
          </Button>
        }
      >
        <div className="form-grid">
          <Input
            label="From"
            type="date"
            value={since}
            onChange={(event) => setSince(event.target.value)}
            max={until || undefined}
          />
          <Input
            label="To"
            type="date"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
            min={since || undefined}
          />
        </div>
      </Card>

      {report.error && !report.data ? (
        <ErrorState error={report.error} onRetry={report.reload} title="Could not load the report" />
      ) : report.loading && !report.data ? (
        <LoadingBlock label="Building the report…" />
      ) : (
        <>
          <StatGrid>
            <StatTile
              label="Class average"
              value={formatPercent(data.class_average, { digits: 1 })}
              tone={attendanceTone(data.class_average, data.threshold)}
              meta={`${data.threshold}% required`}
            />
            <StatTile
              label="Sessions counted"
              value={formatNumber(data.sessions_total)}
              tone="info"
              // An empty session is almost always a class that never happened, and
              // counting it would drag the whole class down.
              meta={
                data.sessions_excluded
                  ? `${pluralize(data.sessions_excluded, 'session')} excluded — nobody was marked`
                  : 'all sessions counted'
              }
            />
            <StatTile
              label="Defaulters"
              value={formatNumber(data.defaulter_count)}
              tone={data.defaulter_count ? 'danger' : 'success'}
              meta={`of ${pluralize(data.students_total, 'student')}`}
            />
          </StatGrid>

          <Card
            title="Session by session"
            subtitle="Each point is one session's attendance rate. A dip on one date is usually a room change; a slide across several is not."
          >
            {trend.error && !trend.data ? (
              <ErrorState error={trend.error} onRetry={trend.reload} title="Could not load the trend" />
            ) : trend.loading && !trend.data ? (
              <LoadingBlock label="Loading the trend…" />
            ) : (
              <>
                <TrendChart points={points} threshold={data.threshold} />
                {points.length >= TREND_LIMIT ? (
                  <p className="small faint">
                    Showing the most recent {TREND_LIMIT} sessions. Narrow the range above to look
                    further back.
                  </p>
                ) : null}
              </>
            )}
          </Card>

          <Card
            flush
            title="Per student"
            subtitle="Percentages count only sessions held since each student joined this subject."
            actions={
              <Button variant="ghost" size="sm" onClick={report.reload} loading={report.loading}>
                Refresh
              </Button>
            }
          >
            <Table
              columns={columns}
              rows={students}
              rowKey="student_id"
              loading={report.loading}
              empty={
                <EmptyState
                  title="Nothing to report yet"
                  message={
                    subject.roster_size
                      ? 'This subject has a roster but no sessions in this range.'
                      : 'Add students to the roster, then open a session.'
                  }
                />
              }
            />
          </Card>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

function SubjectSessions({ subjectId }) {
  const sessions = useResource(
    () => SessionsAPI.list({ subject_id: subjectId }),
    [subjectId],
  );
  const rows = (sessions.data && sessions.data.sessions) || [];

  const columns = [
    {
      key: 'start_time',
      header: 'When',
      nowrap: true,
      render: (session) => formatDateTime(session.start_time),
    },
    {
      key: 'title',
      header: 'Title',
      render: (session) => session.title || <span className="faint">Untitled</span>,
    },
    { key: 'mode_label', header: 'Mode', render: (session) => <Pill>{session.mode_label}</Pill> },
    {
      key: 'present_count',
      header: 'Present',
      align: 'right',
      nowrap: true,
      render: (session) => (
        <span className="mono">
          {session.present_count || 0} / {session.roster_size || 0}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      nowrap: true,
      render: (session) => (
        <Badge
          tone={
            session.status === SessionStatus.ENDED ? 'muted' : session.is_open ? 'success' : 'warn'
          }
          dot
        >
          {session.status === SessionStatus.ENDED
            ? 'Ended'
            : session.is_open
              ? 'Open'
              : 'Window closed'}
        </Badge>
      ),
    },
    {
      key: 'go',
      header: '',
      align: 'right',
      nowrap: true,
      render: (session) => (
        <Link className="btn btn-secondary btn-sm" to={`/sessions/${session.id}`}>
          Open
        </Link>
      ),
    },
  ];

  if (sessions.error && !sessions.data) {
    return <ErrorState error={sessions.error} onRetry={sessions.reload} title="Could not load sessions" />;
  }
  if (sessions.loading && !sessions.data) return <LoadingBlock label="Loading sessions…" />;

  return (
    <Card
      flush
      title="Sessions for this subject"
      subtitle="Newest first, up to the 50 most recent."
    >
      <Table
        columns={columns}
        rows={rows}
        rowKey="id"
        loading={sessions.loading}
        empty={
          <EmptyState
            title="No sessions yet"
            message="Open one from the Sessions page as class begins."
            action={
              <Link className="btn btn-primary btn-sm" to="/sessions">
                Go to Sessions
              </Link>
            }
          />
        }
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

function SettingsPanel({ subject, threshold, isAdmin, onSaved }) {
  const navigate = useNavigate();
  const toast = useToast();

  const hasOwnThreshold =
    subject.attendance_threshold !== null && subject.attendance_threshold !== undefined;

  const [name, setName] = useState(subject.name || '');
  const [code, setCode] = useState(subject.code || '');
  const [useOwnThreshold, setUseOwnThreshold] = useState(hasOwnThreshold);
  const [ownThreshold, setOwnThreshold] = useState(
    String(hasOwnThreshold ? subject.attendance_threshold : threshold || 75),
  );
  const [teacherIds, setTeacherIds] = useState(() =>
    (subject.teachers || []).map((teacher) => teacher.id),
  );
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const teachers = useResource(
    () => (isAdmin ? AdminAPI.users({ role: Role.TEACHER }) : Promise.resolve({ users: [] })),
    [isAdmin],
  );
  const teacherList = (teachers.data && teachers.data.users) || [];

  const save = useAsync((payload) => SubjectsAPI.update(subject.id, payload), {
    onSuccess: () => {
      toast.success('Subject updated.');
      onSaved();
    },
    onError: (error) => toast.notifyError(error),
  });

  const archive = useAsync(
    (archived) => SubjectsAPI.update(subject.id, { archived }),
    {
      onSuccess: (data) => {
        setConfirmArchive(false);
        toast.success(data.subject.archived ? 'Subject archived.' : 'Subject un-archived.');
        onSaved();
      },
      onError: (error) => toast.notifyError(error),
    },
  );

  const remove = useAsync(() => SubjectsAPI.remove(subject.id), {
    onSuccess: () => {
      toast.success(`${subject.code} deleted.`);
      navigate('/subjects');
    },
    onError: (error) => {
      setConfirmDelete(false);
      toast.notifyError(error);
    },
  });

  const submit = (event) => {
    event.preventDefault();
    // A PATCH of only what changed: `attendance_threshold: null` is a meaningful
    // instruction ("go back to inheriting"), so it can only be sent when the
    // teacher actually unchecked the box — not on every save.
    const payload = {};
    if (name.trim() && name.trim() !== subject.name) payload.name = name.trim();
    const cleanCode = code.toUpperCase().replace(/\s+/g, '');
    if (cleanCode && cleanCode !== subject.code) payload.code = cleanCode;
    if (useOwnThreshold) {
      const value = Number(ownThreshold);
      if (!hasOwnThreshold || value !== subject.attendance_threshold) {
        payload.attendance_threshold = value;
      }
    } else if (hasOwnThreshold) {
      payload.attendance_threshold = null;
    }
    if (isAdmin) {
      const before = (subject.teachers || []).map((teacher) => teacher.id).sort().join(',');
      if (teacherIds.slice().sort().join(',') !== before) payload.teacher_ids = teacherIds;
    }

    if (!Object.keys(payload).length) {
      // The server answers "Nothing to update" with a 400; saying it here keeps a
      // no-op click from looking like a failure.
      toast.info('Nothing has changed.');
      return;
    }
    save.run(payload);
  };

  const fieldErrors = save.error ? save.error.fieldErrors : null;
  const canDelete = !subject.session_count;

  return (
    <>
      <Card
        title="Subject settings"
        footer={
          <div className="row between">
            <span className="small muted">
              Changes are logged to the audit trail with your name against them.
            </span>
            <Button type="submit" form="subject-settings-form" loading={save.loading}>
              Save changes
            </Button>
          </div>
        }
      >
        <form id="subject-settings-form" className="stack" onSubmit={submit} noValidate>
          {save.error ? (
            <Alert tone={save.error.status === 409 ? 'warn' : 'danger'} title="Not saved">
              {save.error.message}
            </Alert>
          ) : null}

          <div className="form-grid">
            <Input
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              error={fieldErrors && fieldErrors.name}
              maxLength={120}
            />
            <Input
              label="Code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().replace(/\s+/g, ''))}
              required
              hint="Renaming the code changes it everywhere, including on exports made from now on."
              className="mono"
              maxLength={24}
            />
          </div>

          <Checkbox
            label="Set a different attendance requirement for this subject"
            checked={useOwnThreshold}
            onChange={(event) => setUseOwnThreshold(event.target.checked)}
            hint={`Unchecked, this subject follows the institution setting — currently ${threshold}%.`}
          />
          {useOwnThreshold ? (
            <Input
              label="Required attendance"
              type="number"
              min="1"
              max="100"
              step="1"
              value={ownThreshold}
              onChange={(event) => setOwnThreshold(event.target.value)}
              error={fieldErrors && fieldErrors.attendance_threshold}
              hint="Applies to every report and to the defaulter alert digest immediately — past sessions are re-judged against the new number, not re-recorded."
            />
          ) : null}

          {isAdmin ? (
            <fieldset className="fieldset">
              <legend className="legend">Assigned teachers</legend>
              <p className="field-hint">
                A teacher sees only the subjects they are assigned to. At least one is required.
              </p>
              {teachers.loading ? (
                <LoadingBlock label="Loading teachers…" />
              ) : teacherList.length === 0 ? (
                <Alert tone="info" title="No teachers to assign">
                  Invite a teacher first — you keep admin access to this subject either way.
                </Alert>
              ) : (
                <div className="stack-sm">
                  {teacherList.map((teacher) => (
                    <Checkbox
                      key={teacher.id}
                      label={teacher.name || teacher.email}
                      hint={teacher.name ? teacher.email : undefined}
                      checked={teacherIds.includes(teacher.id)}
                      onChange={() =>
                        setTeacherIds((current) =>
                          current.includes(teacher.id)
                            ? current.filter((value) => value !== teacher.id)
                            : current.concat(teacher.id),
                        )
                      }
                    />
                  ))}
                </div>
              )}
            </fieldset>
          ) : (
            <Alert tone="muted" title="Teacher assignment is an admin setting">
              Ask an admin to add or remove teachers on this subject.
            </Alert>
          )}
        </form>
      </Card>

      <Card
        title={subject.archived ? 'Un-archive' : 'Archive or delete'}
        subtitle="Archiving is reversible and keeps every record. Deleting is not, and is only possible while a subject has no sessions."
      >
        <div className="stack">
          <div className="row row-wrap between">
            <div className="stack-sm">
              <span className="strong">{subject.archived ? 'Archived' : 'Active'}</span>
              <span className="small muted">
                {subject.archived
                  ? 'Hidden from pickers; no new sessions can be opened.'
                  : 'Visible everywhere and available for new sessions.'}
              </span>
            </div>
            <Button
              variant={subject.archived ? 'primary' : 'secondary'}
              onClick={() => (subject.archived ? archive.run(false) : setConfirmArchive(true))}
              loading={archive.loading}
            >
              {subject.archived ? 'Un-archive' : 'Archive'}
            </Button>
          </div>

          <div className="divider" />

          <div className="row row-wrap between">
            <div className="stack-sm">
              <span className="strong">Delete permanently</span>
              <span className="small muted">
                {canDelete
                  ? 'This subject has no sessions, so nothing would be lost but the roster.'
                  : `${pluralize(subject.session_count, 'recorded session')} — deleting would rewrite past reports, so the server refuses. Archive it instead.`}
              </span>
            </div>
            <Button variant="danger" disabled={!canDelete} onClick={() => setConfirmDelete(true)}>
              Delete subject
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmArchive}
        title={`Archive ${subject.code}?`}
        message="It disappears from subject pickers and no new session can be opened for it. Every attendance record, report and export stays exactly as it is, and you can un-archive it here at any time."
        confirmLabel="Archive subject"
        tone="danger"
        busy={archive.loading}
        onConfirm={() => archive.run(true)}
        onCancel={() => setConfirmArchive(false)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${subject.code}?`}
        message="The subject and its roster are removed permanently. This cannot be undone."
        confirmLabel="Delete permanently"
        busy={remove.loading}
        onConfirm={() => remove.run()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
