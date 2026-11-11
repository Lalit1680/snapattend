import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import BarList from '../../components/charts/BarList.jsx';
import SubjectPicker from '../../components/SubjectPicker.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingBlock,
  ProgressBar,
  StatGrid,
  StatTile,
  Table,
  Tabs,
} from '../../components/ui/index.js';
import { AnalyticsAPI, SubjectsAPI } from '../../lib/api.js';
import { AttendanceMethod, METHOD_LABELS, METHOD_TONES } from '../../lib/constants.js';
import {
  attendanceTone,
  dayEndIso,
  dayStartIso,
  formatNumber,
  formatPercent,
  pluralize,
} from '../../lib/format.js';
import useAsync from '../../hooks/useAsync.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';

const TABS = [
  { key: 'defaulters', label: 'Defaulters' },
  { key: 'methods', label: 'How attendance was captured' },
  { key: 'coverage', label: 'Enrollment coverage' },
];

/** `clamp_int(min_sessions, 3, minimum=1, maximum=100)` in `routes/analytics.py`. */
const MIN_SESSIONS_DEFAULT = 3;

/**
 * The three institution-level reports, as three tabs.
 *
 * They are separate tabs because they take different filters, not to tidy the
 * page: the defaulter list ignores a date range entirely (the server builds it
 * from every session a subject has ever held), the method breakdown honours one,
 * and coverage is a snapshot of who has enrolled — no dates apply at all. One
 * shared filter bar above all three would appear to narrow reports it does not
 * touch, which is the kind of quiet lie a report cannot afford.
 */
export default function ReportsPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState(TABS[0].key);
  useDocumentTitle('Reports');

  const subjects = useResource(() => SubjectsAPI.list(), []);
  const subjectList = (subjects.data && subjects.data.subjects) || [];

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">
            {isAdmin
              ? 'Every subject in the institution.'
              : 'The subjects you teach. Asking for another teacher’s subject narrows the result rather than widening access.'}
          </p>
        </div>
      </div>

      {/* Stated once, at the top, because it explains numbers that otherwise look
          wrong: a student who joined late has a smaller denominator than their
          classmates, and a session nobody attended is not in anyone's. */}
      <Alert tone="muted" title="How these figures are counted">
        A student's total counts only sessions held since they joined that subject, and sessions where
        nobody was marked present are left out entirely — those are nearly always classes that never
        happened, and counting them would drag every percentage down.
      </Alert>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {subjects.error && !subjects.data ? (
        <ErrorState error={subjects.error} onRetry={subjects.reload} title="Could not load subjects" />
      ) : null}

      {tab === 'defaulters' ? <DefaultersPanel subjects={subjectList} /> : null}
      {tab === 'methods' ? <MethodsPanel subjects={subjectList} /> : null}
      {tab === 'coverage' ? <CoveragePanel subjects={subjectList} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Defaulters                                                                  */
/* -------------------------------------------------------------------------- */

function DefaultersPanel({ subjects }) {
  const toast = useToast();
  const [subjectId, setSubjectId] = useState('');
  const [threshold, setThreshold] = useState('');
  const [minSessions, setMinSessions] = useState(String(MIN_SESSIONS_DEFAULT));

  const params = useMemo(
    () => ({
      subject_id: subjectId || undefined,
      // Empty means "each subject's own requirement", which is not the same as 0 —
      // and `serializeParams` drops the key entirely when it is undefined.
      threshold: threshold === '' ? undefined : threshold,
      min_sessions: minSessions || undefined,
    }),
    [subjectId, threshold, minSessions],
  );

  const report = useResource(() => AnalyticsAPI.defaulters(params), [params]);
  const exportCsv = useAsync(() => AnalyticsAPI.exportDefaulters(params), {
    onSuccess: () => toast.success('Export downloaded.'),
    onError: (error) => toast.notifyError(error),
  });

  const rows = (report.data && report.data.defaulters) || [];
  const students = new Set(rows.map((row) => row.student_id)).size;
  const worst = rows.length ? rows[0] : null;

  return (
    <>
      <Card
        title="Who is below the requirement"
        subtitle="Worst first. A student appears once per subject they are short in."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => exportCsv.run()}
            loading={exportCsv.loading}
            disabled={!rows.length}
          >
            Export CSV
          </Button>
        }
      >
        <div className="grid grid-3">
          <SubjectPicker
            value={subjectId}
            onChange={setSubjectId}
            subjects={subjects}
            includeAll
            label="Subject"
          />
          <Input
            label="Judge against"
            type="number"
            min={0}
            max={100}
            step={1}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            placeholder="Each subject's own"
            hint="Leave empty to use each subject's own requirement. A number here overrides all of them, which is how you answer “who would be short at 80%?”."
          />
          <Input
            label="Only after at least"
            type="number"
            min={1}
            max={100}
            step={1}
            value={minSessions}
            onChange={(event) => setMinSessions(event.target.value)}
            hint="Sessions held. Below this a student is not flagged: 0 out of 1 is 0% and says nothing yet."
          />
        </div>

        {/* The list is built from every session the subject has ever held; there is
            no `since`/`until` on this endpoint. Offering a date range here would
            filter nothing. */}
        <p className="small muted">
          This covers every session held so far — it is not affected by any date range.
        </p>
      </Card>

      {report.error && !report.data ? (
        <ErrorState error={report.error} onRetry={report.reload} title="Could not load the report" />
      ) : report.loading && !report.data ? (
        <LoadingBlock label="Working out who is falling behind…" />
      ) : (
        <>
          <StatGrid>
            <StatTile
              label="Flagged"
              value={formatNumber(rows.length)}
              tone={rows.length ? 'warn' : 'success'}
              meta="student–subject pairs"
            />
            <StatTile
              label="Students involved"
              value={formatNumber(students)}
              tone="muted"
              meta={students === rows.length ? 'one subject each' : 'some are short in more than one'}
            />
            <StatTile
              label="Lowest"
              value={worst ? formatPercent(worst.percentage, { digits: 0 }) : '—'}
              tone={worst ? attendanceTone(worst.percentage, worst.threshold) : 'muted'}
              meta={worst ? `${worst.name} · ${worst.subject_code}` : 'nobody is short'}
            />
          </StatGrid>

          <Card flush>
            <Table
              columns={[
                {
                  key: 'roll_number',
                  header: 'Roll no.',
                  nowrap: true,
                  render: (row) =>
                    row.roll_number ? (
                      <span className="mono">{row.roll_number}</span>
                    ) : (
                      <span className="faint">—</span>
                    ),
                },
                {
                  key: 'name',
                  header: 'Student',
                  render: (row) => (
                    <div className="stack-sm">
                      <Link className="strong" to={`/students/${row.student_id}`}>
                        {row.name}
                      </Link>
                      {row.email ? <span className="small faint truncate">{row.email}</span> : null}
                    </div>
                  ),
                },
                {
                  key: 'subject_name',
                  header: 'Subject',
                  render: (row) => (
                    <Link to={`/subjects/${row.subject_id}`}>
                      <span className="mono">{row.subject_code}</span> {row.subject_name}
                    </Link>
                  ),
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
                  key: 'threshold',
                  header: 'Required',
                  align: 'right',
                  nowrap: true,
                  render: (row) => <span className="mono">{row.threshold}%</span>,
                },
                {
                  key: 'percentage',
                  header: 'Attendance',
                  align: 'right',
                  nowrap: true,
                  render: (row) => (
                    <Badge tone={attendanceTone(row.percentage, row.threshold)}>
                      {formatPercent(row.percentage, { digits: 0 })}
                    </Badge>
                  ),
                },
                {
                  key: 'shortfall',
                  header: 'Short by',
                  align: 'right',
                  nowrap: true,
                  render: (row) => <span className="mono">{formatPercent(row.shortfall)}</span>,
                },
              ]}
              rows={rows}
              rowKey={(row) => `${row.student_id}-${row.subject_id}`}
              loading={report.loading}
              empty={
                <EmptyState
                  title="Nobody is below the requirement"
                  message={
                    report.data && report.data.min_sessions > 1
                      ? `Either attendance is healthy, or no subject has held ${pluralize(report.data.min_sessions, 'session')} yet.`
                      : 'Either attendance is healthy, or no sessions have been held yet.'
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
/* Capture methods                                                             */
/* -------------------------------------------------------------------------- */

function MethodsPanel({ subjects }) {
  const [subjectId, setSubjectId] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const params = useMemo(
    () => ({
      subject_id: subjectId || undefined,
      since: dayStartIso(since),
      until: dayEndIso(until),
    }),
    [subjectId, since, until],
  );

  const report = useResource(() => AnalyticsAPI.methods(params), [params]);

  const rows = (report.data && report.data.methods) || [];
  const total = (report.data && report.data.total) || 0;
  const countOf = (method) => {
    const row = rows.find((item) => item.method === method);
    return row ? row.count : 0;
  };

  const auto = countOf(AttendanceMethod.FACE_PHOTO);
  const reviewed = countOf(AttendanceMethod.FACE_PHOTO_REVIEW);
  const manual = countOf(AttendanceMethod.MANUAL);

  return (
    <>
      <Card
        title="Range"
        subtitle="Present records only — an absence has no capture method."
      >
        <div className="grid grid-3">
          <SubjectPicker
            value={subjectId}
            onChange={setSubjectId}
            subjects={subjects}
            includeAll
            label="Subject"
          />
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
        <ErrorState error={report.error} onRetry={report.reload} title="Could not load the breakdown" />
      ) : report.loading && !report.data ? (
        <LoadingBlock label="Counting how attendance was captured…" />
      ) : (
        <>
          {/* The reason this report exists. Recognition that keeps landing in the
              review band is not a queue problem — it is a threshold or an
              enrollment-quality problem, and this ratio is the only place it shows. */}
          {reviewed > 0 && reviewed >= auto ? (
            <Alert tone="warn" title="More faces needed review than matched outright">
              {formatNumber(reviewed)} of {formatNumber(reviewed + auto)} class-photo matches were
              close enough to need a human. That usually means students enrolled from poor photos, or
              a class photo taken too far back for the faces to carry detail — not that the reviewers
              are behind.
            </Alert>
          ) : null}

          {manual > 0 && total > 0 && manual / total >= 0.5 ? (
            <Alert tone="warn" title="Most attendance was marked by hand">
              {formatPercent((manual / total) * 100, { digits: 0 })} of records came from a manual
              override. The automation is not doing the work — check enrollment coverage, and check
              that sessions are being opened in a mode students can actually use.
            </Alert>
          ) : null}

          <div className="grid grid-2">
            <Card title="Share of present records" subtitle={`${pluralize(total, 'record')} in range.`}>
              <BarList
                items={rows.map((row) => ({
                  key: row.method,
                  label: METHOD_LABELS[row.method] || row.method,
                  value: row.count,
                  display: `${formatNumber(row.count)} · ${formatPercent(row.percentage, { digits: 0 })}`,
                  tone: METHOD_TONES[row.method] || 'muted',
                }))}
              />
            </Card>

            <Card flush title="By method">
              <Table
                compact
                columns={[
                  {
                    key: 'method',
                    header: 'Method',
                    render: (row) => (
                      <Badge tone={METHOD_TONES[row.method] || 'muted'}>
                        {METHOD_LABELS[row.method] || row.method}
                      </Badge>
                    ),
                  },
                  {
                    key: 'count',
                    header: 'Records',
                    align: 'right',
                    nowrap: true,
                    render: (row) => <span className="mono">{formatNumber(row.count)}</span>,
                  },
                  {
                    key: 'percentage',
                    header: 'Share',
                    align: 'right',
                    nowrap: true,
                    render: (row) => formatPercent(row.percentage, { digits: 1 }),
                  },
                ]}
                rows={rows}
                rowKey="method"
                loading={report.loading}
                empty={
                  <EmptyState
                    title="Nothing recorded in this range"
                    message="Either no session ran, or nobody was marked present. Widen the dates or clear the subject filter."
                  />
                }
                footer={
                  rows.length ? (
                    <div className="row between">
                      <span className="small muted">Total</span>
                      <span className="mono strong">{formatNumber(total)}</span>
                    </div>
                  ) : null
                }
              />
            </Card>
          </div>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Enrollment coverage                                                         */
/* -------------------------------------------------------------------------- */

function CoveragePanel({ subjects }) {
  const [subjectId, setSubjectId] = useState('');

  const params = useMemo(() => ({ subject_id: subjectId || undefined }), [subjectId]);
  const report = useResource(() => AnalyticsAPI.enrollmentCoverage(params), [params]);

  const rows = (report.data && report.data.subjects) || [];
  // An empty roster is reported as 0% coverage, which reads as a failure when it is
  // simply a subject nobody is on yet. The two need separating before anything is
  // averaged or judged.
  const staffed = rows.filter((row) => row.roster_size > 0);
  const emptyRosters = rows.length - staffed.length;
  const fullyCovered = staffed.filter((row) => row.face_enrolled >= row.roster_size).length;
  const missing = staffed.reduce(
    (sum, row) => sum + Math.max(0, row.roster_size - row.face_enrolled),
    0,
  );

  return (
    <>
      <Card
        title="Who can be recognised"
        subtitle="Face-photo attendance can only mark students who have enrolled a face. This is the number to check before relying on it."
      >
        <div className="grid grid-3">
          <SubjectPicker
            value={subjectId}
            onChange={setSubjectId}
            subjects={subjects}
            includeAll
            label="Subject"
          />
        </div>
      </Card>

      {report.error && !report.data ? (
        <ErrorState error={report.error} onRetry={report.reload} title="Could not load coverage" />
      ) : report.loading && !report.data ? (
        <LoadingBlock label="Checking enrollment coverage…" />
      ) : (
        <>
          <StatGrid>
            <StatTile
              label="Fully covered"
              value={`${formatNumber(fullyCovered)} / ${formatNumber(staffed.length)}`}
              tone={staffed.length && fullyCovered === staffed.length ? 'success' : 'warn'}
              meta="subjects where everyone has a face on file"
            />
            <StatTile
              label="Still to enroll"
              value={formatNumber(missing)}
              tone={missing ? 'warn' : 'success'}
              meta="roster places with no face"
            />
            <StatTile
              label="Empty rosters"
              value={formatNumber(emptyRosters)}
              tone={emptyRosters ? 'muted' : 'success'}
              meta="no students, so nothing to cover"
            />
          </StatGrid>

          {missing ? (
            <Alert
              tone="warn"
              title={`${pluralize(missing, 'student')} cannot be matched from a class photo`}
              actions={
                <Link className="btn btn-secondary btn-sm" to="/students">
                  Work through the list
                </Link>
              }
            >
              A class photo will simply not find them, and they will show as absent unless someone
              marks them by hand. Only the student can enroll — from their own device, after signing
              in.
            </Alert>
          ) : null}

          <Card flush title="By subject" subtitle="Lowest coverage first.">
            <Table
              columns={[
                {
                  key: 'subject_name',
                  header: 'Subject',
                  render: (row) => (
                    <Link className="strong" to={`/subjects/${row.subject_id}`}>
                      <span className="mono">{row.subject_code}</span> {row.subject_name}
                    </Link>
                  ),
                },
                {
                  key: 'roster_size',
                  header: 'On the roster',
                  align: 'right',
                  nowrap: true,
                  render: (row) => <span className="mono">{formatNumber(row.roster_size)}</span>,
                },
                {
                  key: 'face_enrolled',
                  header: 'Face',
                  align: 'right',
                  nowrap: true,
                  render: (row) => (
                    <span className="mono">
                      {row.face_enrolled} / {row.roster_size}
                    </span>
                  ),
                },
                {
                  key: 'voice_enrolled',
                  header: 'Voice',
                  align: 'right',
                  nowrap: true,
                  render: (row) => (
                    <span className="mono">
                      {row.voice_enrolled} / {row.roster_size}
                    </span>
                  ),
                },
                {
                  key: 'face_coverage',
                  header: 'Face coverage',
                  width: '11rem',
                  render: (row) =>
                    row.roster_size ? (
                      <ProgressBar
                        value={row.face_coverage}
                        // Coverage is not attendance: anything short of everyone is
                        // a gap, so the bands are tighter than attendanceTone's.
                        tone={
                          row.face_coverage >= 100
                            ? 'success'
                            : row.face_coverage >= 75
                              ? 'warn'
                              : 'danger'
                        }
                        label={formatPercent(row.face_coverage, { digits: 0 })}
                      />
                    ) : (
                      <span className="small faint">Nobody on the roster</span>
                    ),
                },
              ]}
              rows={rows}
              rowKey="subject_id"
              loading={report.loading}
              empty={
                <EmptyState
                  title="No subjects to report on"
                  message="Create a subject and add students to it, and their enrollment progress appears here."
                />
              }
            />
          </Card>
        </>
      )}
    </>
  );
}
