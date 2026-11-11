import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Pill,
  ProgressBar,
  Select,
  StatGrid,
  StatTile,
  Table,
} from '../../components/ui/index.js';
import { AttendanceAPI } from '../../lib/api.js';
import { AttendanceStatus, METHOD_LABELS, METHOD_TONES } from '../../lib/constants.js';
import {
  attendanceTone,
  formatConfidence,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelative,
  pluralize,
} from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import useAsync from '../../hooks/useAsync.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';

/**
 * How many rows of the register to ask for.
 *
 * `GET /api/attendance/me` clamps `limit` to 1–100, so 100 is the whole of what
 * this endpoint will ever return and there is no point offering more. The default
 * matches the server's own.
 */
const LIMIT_OPTIONS = [
  { value: 30, label: '30 most recent' },
  { value: 60, label: '60 most recent' },
  { value: 100, label: '100 most recent' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'Present and absent' },
  { value: AttendanceStatus.PRESENT, label: 'Present only' },
  { value: AttendanceStatus.ABSENT, label: 'Absent only' },
];

/**
 * The whole of a student's own record.
 *
 * The dashboard answers "how am I doing"; this page answers "what exactly does the
 * register say, and can I have that in writing". Hence the CSV, and hence the two
 * counting rules spelled out at the bottom — a student who thinks a defaulter list
 * is wrong needs to know which sessions were counted before arguing about the
 * percentage.
 *
 * Filtering happens here rather than in the request: `GET /attendance/me` takes
 * only `limit`, so narrowing the rows client side is both instant and honest about
 * the scope — nothing outside the rows already on screen is being hidden.
 */
export default function MyAttendance() {
  useDocumentTitle('Your attendance');
  const toast = useToast();
  const { student } = useAuth();

  const [limit, setLimit] = useState(LIMIT_OPTIONS[0].value);
  const [subjectId, setSubjectId] = useState('');
  const [status, setStatus] = useState('');

  const mine = useResource(() => AttendanceAPI.mine({ limit }), [limit]);
  const exportCsv = useAsync(() => AttendanceAPI.exportMine(), {
    onSuccess: () => toast.success('Export downloaded.'),
    onError: (error) => toast.notifyError(error),
  });

  const report = (mine.data && mine.data.report) || null;
  const overall = (report && report.overall) || null;
  const subjects = (report && report.subjects) || [];
  const history = (mine.data && mine.data.history) || [];
  const short = subjects.filter((row) => row.below_threshold);

  // Built from the rows being filtered rather than from the subject report: a row
  // can name a subject the student has since been taken off, and leaving it out of
  // the picker would make that row the one thing on the page that cannot be
  // filtered for.
  const subjectOptions = useMemo(() => buildSubjectOptions(history), [history]);

  const rows = history.filter(
    (row) => (!subjectId || row.subject_id === subjectId) && (!status || row.status === status),
  );

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Your attendance</h1>
          <p className="page-sub">
            Every subject you are on and every row the register holds against you
            {student && student.roll_number ? (
              <>
                {' '}
                as <span className="mono">{student.roll_number}</span>
              </>
            ) : null}
            .
          </p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={mine.reload} loading={mine.loading}>
            Refresh
          </Button>
          <Button
            variant="secondary"
            onClick={exportCsv.run}
            loading={exportCsv.loading}
            disabled={!report}
          >
            Download CSV
          </Button>
        </div>
      </div>

      {mine.error && !mine.data ? (
        <ErrorState error={mine.error} onRetry={mine.reload} title="Could not read your record" />
      ) : mine.loading && !mine.data ? (
        <LoadingBlock label="Reading the register…" />
      ) : report && overall ? (
        <>
          <StatGrid>
            <StatTile
              label="Overall"
              // Not `attendanceTone`: the requirement is per subject, so this
              // figure has no single line to be above or below.
              tone="info"
              value={formatPercent(overall.percentage, { digits: 1 })}
              meta="every subject together"
            />
            <StatTile
              label="Sessions counted"
              value={formatNumber(overall.total)}
              tone="muted"
              meta="held while you were on the roster"
            />
            <StatTile
              label="Marked present"
              value={formatNumber(overall.present)}
              tone={overall.total && overall.present === overall.total ? 'success' : 'muted'}
              meta={`${formatNumber(Math.max(0, overall.total - overall.present))} missed`}
            />
            <StatTile
              label="Subjects below the line"
              value={formatNumber(short.length)}
              tone={short.length ? 'danger' : 'success'}
              meta={short.length ? 'you are in the defaulter report' : 'all of them clear'}
            />
          </StatGrid>

          <Card
            title="Where you stand"
            subtitle="Each subject against its own requirement. Lowest first — the server sorts them that way, so the top row is the one to fix."
          >
            {subjects.length ? (
              <SubjectStanding rows={subjects} />
            ) : (
              <EmptyState
                title="You are not on any subject's roster"
                message="A teacher adds you to a subject. Until then there is nothing to attend and nothing to count."
                action={
                  <Link className="btn btn-secondary" to="/student">
                    Back to overview
                  </Link>
                }
              />
            )}
          </Card>

          <Card
            title="The register, row by row"
            subtitle="How each session of yours was recorded, newest first."
          >
            <div className="stack">
              <div className="form-grid">
                <Select
                  label="Rows to read"
                  options={LIMIT_OPTIONS}
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value))}
                  hint="Asked of the server; the two filters beside it narrow what came back."
                />
                <Select
                  label="Subject"
                  options={subjectOptions}
                  value={subjectId}
                  onChange={(event) => setSubjectId(event.target.value)}
                />
                <Select
                  label="Status"
                  options={STATUS_OPTIONS}
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                />
              </div>
              <HistoryTable rows={rows} total={history.length} loading={mine.loading} />
            </div>
          </Card>

          <CountingRules />
          <ExportNote busy={exportCsv.loading} onExport={exportCsv.run} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The subject picker's options, taken from the rows themselves.
 *
 * Deduplicated on `subject_id` and labelled with the code where there is one, so
 * two subjects sharing a name are still tellable apart.
 */
function buildSubjectOptions(history) {
  const seen = new Map();
  history.forEach((row) => {
    if (!row.subject_id || seen.has(row.subject_id)) return;
    const name = row.subject_name || 'Unknown subject';
    seen.set(row.subject_id, row.subject_code ? `${name} (${row.subject_code})` : name);
  });
  const options = Array.from(seen, ([value, label]) => ({ value, label }));
  options.sort((a, b) => a.label.localeCompare(b.label));
  return [{ value: '', label: 'Every subject' }].concat(options);
}

/** Every subject, each against the requirement the server resolved for it. */
function SubjectStanding({ rows }) {
  const columns = [
    {
      key: 'subject',
      header: 'Subject',
      render: (row) => (
        <div className="row row-sm row-wrap">
          <span className="strong">{row.subject_name || 'Unknown subject'}</span>
          {row.subject_code ? <Pill>{row.subject_code}</Pill> : null}
          {row.below_threshold ? <Badge tone="danger">short</Badge> : null}
        </div>
      ),
    },
    {
      key: 'attended',
      header: 'Attended',
      align: 'right',
      nowrap: true,
      render: (row) => `${formatNumber(row.present)} of ${formatNumber(row.total)}`,
    },
    { key: 'absent', header: 'Missed', align: 'right', render: (row) => formatNumber(row.absent) },
    {
      key: 'needs',
      header: 'Needs',
      align: 'right',
      nowrap: true,
      // `threshold` is `effective_threshold`, already resolved subject →
      // institution → built-in default. Re-deriving it here would ignore an
      // override the server has already applied.
      render: (row) => formatPercent(row.threshold, { digits: 0 }),
    },
    {
      key: 'standing',
      header: 'Standing',
      width: '12rem',
      render: (row) => <Standing row={row} />,
    },
  ];

  return <Table columns={columns} rows={rows} rowKey="subject_id" compact />;
}

/** The percentage and the bar, coloured the same way so they cannot disagree. */
function Standing({ row }) {
  const tone = attendanceTone(row.percentage, row.threshold);
  return (
    <div className="stack-sm">
      <Badge tone={tone}>{formatPercent(row.percentage, { digits: 1 })}</Badge>
      <ProgressBar value={row.percentage} tone={tone} />
    </div>
  );
}

/**
 * The register itself.
 *
 * A table rather than the dashboard's timeline: this is the page a student opens to
 * check one particular lecture, and scanning a column for it beats reading prose.
 */
function HistoryTable({ rows, total, loading }) {
  const columns = [
    {
      key: 'session',
      header: 'Session',
      render: (row) => (
        <div className="stack-sm">
          <span className="strong">{row.subject_name || 'Unknown subject'}</span>
          <span className="small faint" title={formatDateTime(row.session_start)}>
            {row.session_start ? formatRelative(row.session_start) : 'no start time recorded'}
            {row.subject_code ? ` · ${row.subject_code}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      nowrap: true,
      render: (row) => <StatusCell status={row.status} />,
    },
    {
      key: 'method',
      header: 'How',
      render: (row) => <MethodCell row={row} />,
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (row) => <NotesCell row={row} />,
    },
    {
      key: 'marked',
      header: 'Recorded',
      align: 'right',
      nowrap: true,
      render: (row) => (row.marked_at ? formatDateTime(row.marked_at) : '—'),
    },
  ];

  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey="session_id"
      loading={loading}
      compact
      empty={
        total ? (
          <EmptyState
            title="No rows match those filters"
            message="Widen the subject or status filter to see the rest of what was read."
          />
        ) : (
          <EmptyState
            title="Nothing recorded yet"
            message="Your first check-in — or the first class photo you appear in — starts this list."
          />
        )
      }
      footer={
        rows.length === total
          ? `${pluralize(total, 'row')} on the register.`
          : `Showing ${formatNumber(rows.length)} of the ${pluralize(total, 'row')} read.`
      }
    />
  );
}

/** Present or absent, with a dot so the two are distinguishable without colour. */
function StatusCell({ status }) {
  const present = status === AttendanceStatus.PRESENT;
  return (
    <Badge tone={present ? 'success' : 'danger'} dot>
      {present ? 'Present' : 'Absent'}
    </Badge>
  );
}

/** What recognised the student, and how sure it was. */
function MethodCell({ row }) {
  // An absent row has no method, because nothing recognised anybody.
  if (row.status !== AttendanceStatus.PRESENT || !row.method_used) {
    return <span className="faint">—</span>;
  }

  return (
    <div className="row row-sm row-wrap">
      <Badge tone={METHOD_TONES[row.method_used] || 'muted'}>
        {METHOD_LABELS[row.method_used] || METHOD_LABELS.unknown}
      </Badge>
      {/* Absent from a manual mark and from a QR redemption — there is no
          measurement to report for either, only for a face or voice match. */}
      {typeof row.confidence_score === 'number' ? (
        <span className="small faint">{formatConfidence(row.confidence_score)}</span>
      ) : null}
    </div>
  );
}

/** The two things worth saying about a row that the other columns cannot. */
function NotesCell({ row }) {
  if (!row.was_manual_override && !row.session_title) return <span className="faint">—</span>;

  return (
    <div className="row row-sm row-wrap">
      {row.was_manual_override ? <Pill tone="warn">set by a teacher</Pill> : null}
      {row.session_title ? (
        <span className="small muted truncate">{row.session_title}</span>
      ) : null}
    </div>
  );
}

/**
 * Why the percentage is the number it is.
 *
 * Both rules are the server's and neither is guessable from the figures:
 * `_eligible_totals` counts only sessions that started on or after the student
 * joined the subject, and `_countable_sessions` keeps a still-open session out of
 * the denominator until something has been recorded in it. A student counting
 * lectures in their diary and comparing needs both, or this page looks wrong.
 */
function CountingRules() {
  return (
    <Card title="How these numbers are counted">
      <div className="stack-sm">
        <p className="small muted">
          <span className="strong">Sessions held before you joined a subject do not count.</span> If
          you were added in week four, the three weeks of lectures before that are neither present
          nor missed for you.
        </p>
        <p className="small muted">
          <span className="strong">
            A session still running counts only once something has been recorded in it.
          </span>{' '}
          A teacher who opens a lecture five minutes early does not put the whole class at absent
          while the room fills up.
        </p>
        <p className="small muted">
          <span className="strong">A lecture you missed leaves no row in the table above.</span> The
          register stores what happened — a check-in, a face matched in a class photo, or a mark a
          teacher set by hand. Absence is the absence of a row, which is why the percentages are the
          count to trust and the table is the evidence behind them.
        </p>
        <div className="divider" />
        <p className="small faint">
          Each subject is measured against its own requirement, set on the subject or, failing that,
          for the whole institution. Whichever applied is the figure in the Needs column.
        </p>
      </div>
    </Card>
  );
}

/**
 * The CSV, and what is actually in it.
 *
 * `GET /me/export` builds `student_report_csv`, which is the subject summary and not
 * the row-by-row table — and it takes no filters, so it is always all time. Saying
 * so beats a student opening the file expecting the table they were just looking at.
 */
function ExportNote({ busy, onExport }) {
  return (
    <Card title="Take it with you">
      <div className="row between row-wrap">
        <span className="small muted">
          Your name, roll number and email, the overall figures, then one line per subject with the
          present, absent and total counts, the percentage and the requirement. It covers all time
          and ignores the filters above, so it is the same file however you leave this page.
        </span>
        <Button variant="secondary" onClick={onExport} loading={busy}>
          Download CSV
        </Button>
      </div>
    </Card>
  );
}
