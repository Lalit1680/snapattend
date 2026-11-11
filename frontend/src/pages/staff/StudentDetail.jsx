import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

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
  ProgressBar,
  StatGrid,
  StatTile,
  Table,
  Textarea,
} from '../../components/ui/index.js';
import InviteResult from '../../components/InviteResult.jsx';
import { AnalyticsAPI, StudentsAPI } from '../../lib/api.js';
import {
  AttendanceStatus,
  ENROLLMENT_STATUS_LABELS,
  EnrollmentStatus,
  METHOD_LABELS,
  METHOD_TONES,
  UserStatus,
} from '../../lib/constants.js';
import {
  attendanceTone,
  formatConfidence,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  initials,
  pluralize,
} from '../../lib/format.js';
import useAsync from '../../hooks/useAsync.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';

const ENROLLMENT_TONES = {
  [EnrollmentStatus.INVITED]: 'muted',
  [EnrollmentStatus.PENDING_BIOMETRICS]: 'warn',
  [EnrollmentStatus.COMPLETE]: 'success',
};

const ACCOUNT_TONES = {
  [UserStatus.INVITED]: 'warn',
  [UserStatus.ACTIVE]: 'success',
  [UserStatus.DISABLED]: 'danger',
};

/**
 * One student, from the staff side.
 *
 * Two requests rather than one: the profile and enrollment state load immediately,
 * and the attendance report — which aggregates every record they have — loads
 * alongside. Opening this page to fix a roll number should not wait on an
 * aggregation.
 */
export default function StudentDetail() {
  const { studentId } = useParams();
  const { isAdmin } = useAuth();

  const detail = useResource(() => StudentsAPI.get(studentId), [studentId]);
  const attendance = useResource(() => StudentsAPI.attendance(studentId), [studentId]);

  const student = (detail.data && detail.data.student) || null;
  const subjects = (detail.data && detail.data.subjects) || [];
  const enrollment = (detail.data && detail.data.enrollment) || null;

  // `GET /api/students/:id` lists every roster this student is on, but
  // `GET /api/students/:id/attendance` filters its rows to the subjects the caller
  // teaches — and the report holds a row for every enrolled subject it does not
  // filter out. So its subject ids are exactly the set a non-admin is allowed to
  // open, and a link to anything else would 404. `null` means no restriction; a
  // teacher gets an empty set until the report lands, which withholds a link
  // rather than offering a broken one.
  const reportRows =
    (attendance.data && attendance.data.report && attendance.data.report.subjects) || [];
  const openable = isAdmin ? null : new Set(reportRows.map((row) => row.subject_id));

  useDocumentTitle(student ? student.name || 'Student' : 'Student');

  if (detail.error && !detail.data) {
    return <ErrorState error={detail.error} onRetry={detail.reload} title="Could not load the student" />;
  }
  if (!student) return <LoadingBlock label="Loading the student…" />;

  const notActivated = student.account_status === UserStatus.INVITED;
  const drifted = enrollment ? (enrollment.steps || []).filter((step) => step.drift) : [];

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <div className="row row-sm">
            <span className="avatar" aria-hidden="true">
              {initials(student.name)}
            </span>
            <h1 className="page-title">{student.name || 'Unnamed student'}</h1>
          </div>
          <p className="page-sub">
            {student.email}
            {student.roll_number ? (
              <>
                {' · '}
                <span className="mono">{student.roll_number}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="page-actions">
          <Badge tone={ENROLLMENT_TONES[student.enrollment_status] || 'muted'}>
            {ENROLLMENT_STATUS_LABELS[student.enrollment_status] || 'Unknown'}
          </Badge>
          <Badge tone={ACCOUNT_TONES[student.account_status] || 'muted'}>
            {student.account_status === UserStatus.INVITED
              ? 'Not activated'
              : student.account_status === UserStatus.DISABLED
                ? 'Disabled'
                : 'Active'}
          </Badge>
          <Link className="btn btn-secondary" to="/students">
            All students
          </Link>
        </div>
      </div>

      {/* Both of these are silent failures at the moment they matter — in a room,
          mid-class — so they are loud here. */}
      {notActivated ? (
        <ResendInvitePanel studentId={studentId} name={student.name} onDone={detail.reload} />
      ) : null}

      {drifted.length ? (
        <Alert tone="danger" title="Enrolled, but the stored vector is missing">
          {drifted.map((step) => step.label).join(' and ')} shows as enrolled while the matching data
          is not in the vector store, so recognition will simply never match. Reset that biometric
          below and have the student enroll again.
        </Alert>
      ) : null}

      {student.account_status === UserStatus.DISABLED ? (
        <Alert tone="warn" title="This account is disabled">
          They cannot sign in or check themselves in. Their attendance history is unchanged, and they
          are excluded from the list of students available to add to a roster.
        </Alert>
      ) : null}

      <div className="grid grid-2">
        <EnrollmentCard
          studentId={studentId}
          student={student}
          enrollment={enrollment}
          onChanged={() => {
            detail.reload();
            attendance.reload();
          }}
        />
        <ProfileCard studentId={studentId} student={student} onSaved={detail.reload} />
      </div>

      <SubjectsCard subjects={subjects} openable={openable} />

      <AttendanceSection studentId={studentId} resource={attendance} isAdmin={isAdmin} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Invitation                                                                  */
/* -------------------------------------------------------------------------- */

function ResendInvitePanel({ studentId, name, onDone }) {
  const [result, setResult] = useState(null);

  const resend = useAsync(() => StudentsAPI.resendInvite(studentId), {
    onSuccess: (data) => {
      setResult(data);
      onDone();
    },
  });

  if (result) return <InviteResult result={result} onDismiss={() => setResult(null)} />;

  return (
    <Alert
      tone="warn"
      title="This student has never signed in"
      actions={
        <Button size="sm" onClick={() => resend.run()} loading={resend.loading}>
          Resend invitation
        </Button>
      }
    >
      {resend.error ? (
        <p>{resend.error.message}</p>
      ) : (
        <p>
          {name ? `${name} has` : 'They have'} an account but have not accepted the invitation, so
          they cannot enroll a face or voice and cannot check themselves in. Resending issues a fresh
          link and invalidates the previous one.
        </p>
      )}
    </Alert>
  );
}

/* -------------------------------------------------------------------------- */
/* Enrollment                                                                  */
/* -------------------------------------------------------------------------- */

function EnrollmentCard({ studentId, student, enrollment, onChanged }) {
  const [resetting, setResetting] = useState(false);
  const steps = (enrollment && enrollment.steps) || [];
  const done = steps.filter((step) => step.done).length;

  return (
    <Card
      title="Biometric enrollment"
      subtitle="What the student has on file. Only they can add samples — this page can only clear them."
      actions={
        <Button
          variant="danger"
          size="sm"
          onClick={() => setResetting(true)}
          disabled={!student.face_enrolled && !student.voice_enrolled}
        >
          Reset
        </Button>
      }
      footer={
        enrollment && enrollment.passphrase ? (
          <span className="small muted">
            Voice passphrase: <span className="mono">{enrollment.passphrase}</span>
          </span>
        ) : null
      }
    >
      <div className="stack">
        <ProgressBar
          value={done}
          max={steps.length || 1}
          tone={done === steps.length ? 'success' : 'warn'}
          label={`${done} of ${steps.length} complete`}
        />

        {steps.map((step) => (
          <div className="row row-wrap between" key={step.key}>
            <div className="stack-sm">
              <span className="strong">{step.label}</span>
              <span className="small muted">
                {step.detail} · {pluralize(step.required_samples, 'sample')} needed
              </span>
            </div>
            {step.drift ? (
              <Badge tone="danger">Vector missing</Badge>
            ) : step.done ? (
              <Badge tone="success" dot>
                Done
              </Badge>
            ) : (
              <Badge tone="muted" dot>
                Not started
              </Badge>
            )}
          </div>
        ))}

        {!steps.length ? <p className="muted small">No enrollment data.</p> : null}
      </div>

      <ResetBiometricsDialog
        open={resetting}
        studentId={studentId}
        student={student}
        onClose={() => setResetting(false)}
        onReset={() => {
          setResetting(false);
          onChanged();
        }}
      />
    </Card>
  );
}

function ResetBiometricsDialog({ open, studentId, student, onClose, onReset }) {
  const toast = useToast();
  const [face, setFace] = useState(true);
  const [voice, setVoice] = useState(true);
  const [reason, setReason] = useState('');

  const reset = useAsync(
    (payload) => StudentsAPI.resetBiometrics(studentId, payload),
    {
      onSuccess: (data) => {
        toast.success(data.message || 'Biometric data cleared.');
        setReason('');
        onReset();
      },
      onError: (error) => toast.notifyError(error),
    },
  );

  const close = () => {
    reset.reset();
    setReason('');
    onClose();
  };

  const fieldErrors = reset.error ? reset.error.fieldErrors : null;

  return (
    <Modal
      open={open}
      title="Reset biometric data"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={reset.loading}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => reset.run({ reason: reason.trim(), face, voice })}
            loading={reset.loading}
            disabled={(!face && !voice) || reason.trim().length < 3}
          >
            Clear data
          </Button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="warn" title="This deletes the stored vectors, not just the flags">
          The samples are removed from the vector store, so nothing keeps matching a face the student
          has asked us to forget. They will have to enroll again from their own device before a class
          photo or voice check-in can identify them. Attendance already recorded is untouched.
        </Alert>

        <Checkbox
          label={`Face samples${student.face_enrolled ? ` (${student.face_sample_count || 0} on file)` : ' — none on file'}`}
          checked={face}
          onChange={(event) => setFace(event.target.checked)}
        />
        <Checkbox
          label={`Voice recordings${student.voice_enrolled ? ` (${student.voice_sample_count || 0} on file)` : ' — none on file'}`}
          checked={voice}
          onChange={(event) => setVoice(event.target.checked)}
        />

        <Textarea
          label="Reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
          rows={2}
          placeholder="Student changed appearance and asked to re-enroll"
          hint="Recorded in the audit trail against your name. At least three characters — this is a destructive action on someone else's account."
          error={fieldErrors && fieldErrors.reason}
        />
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

function ProfileCard({ studentId, student, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(student.name || '');
  const [rollNumber, setRollNumber] = useState(student.roll_number || '');

  const save = useAsync((payload) => StudentsAPI.update(studentId, payload), {
    onSuccess: () => {
      toast.success('Student updated.');
      onSaved();
    },
    onError: (error) => toast.notifyError(error),
  });

  const submit = (event) => {
    event.preventDefault();
    const payload = {};
    if (name.trim() && name.trim() !== (student.name || '')) payload.name = name.trim();
    // `roll_number` is presence-checked on the server, so sending it as an empty
    // string is how a roll number is *cleared* — which means it can only be sent
    // when it really changed, or every save would rewrite it.
    if (rollNumber.trim() !== (student.roll_number || '')) {
      payload.roll_number = rollNumber.trim() || null;
    }
    if (!Object.keys(payload).length) {
      toast.info('Nothing has changed.');
      return;
    }
    save.run(payload);
  };

  const fieldErrors = save.error ? save.error.fieldErrors : null;

  return (
    <Card
      title="Profile"
      subtitle="The email address is their sign-in identity and cannot be changed here."
      footer={
        <div className="row between">
          <span className="small muted">Changes are recorded in the audit trail.</span>
          <Button type="submit" form="student-profile-form" loading={save.loading}>
            Save
          </Button>
        </div>
      }
    >
      <form id="student-profile-form" className="stack" onSubmit={submit} noValidate>
        <Input
          label="Full name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          error={fieldErrors && fieldErrors.name}
        />
        <Input
          label="Roll number"
          value={rollNumber}
          onChange={(event) => setRollNumber(event.target.value)}
          hint="Up to 32 characters. Clear the field to remove it."
          className="mono"
          maxLength={32}
        />
        <div className="kv">
          <span className="kv-key">Email</span>
          <span className="kv-value truncate">{student.email}</span>
          <span className="kv-key">Account created</span>
          <span className="kv-value">{formatDate(student.created_at)}</span>
        </div>
      </form>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Subjects                                                                    */
/* -------------------------------------------------------------------------- */

function SubjectsCard({ subjects, openable }) {
  const hidden = openable ? subjects.filter((subject) => !openable.has(subject.id)).length : 0;

  return (
    <Card
      flush
      title="Subjects"
      subtitle="Rosters this student is on. Their attendance in each counts only sessions held since they joined it."
      footer={
        hidden ? (
          <span className="small muted">
            {pluralize(hidden, 'subject')} you do not teach{' '}
            {hidden === 1 ? 'is' : 'are'} listed but cannot be opened, and does not appear in the
            attendance figures below.
          </span>
        ) : null
      }
    >
      <Table
        compact
        columns={[
          {
            key: 'code',
            header: 'Code',
            nowrap: true,
            render: (subject) => <span className="mono strong">{subject.code}</span>,
          },
          { key: 'name', header: 'Subject' },
          {
            key: 'go',
            header: '',
            align: 'right',
            nowrap: true,
            render: (subject) =>
              !openable || openable.has(subject.id) ? (
                <Link className="btn btn-secondary btn-sm" to={`/subjects/${subject.id}`}>
                  Open
                </Link>
              ) : (
                <span className="small faint">Not yours</span>
              ),
          },
        ]}
        rows={subjects}
        rowKey="id"
        empty={
          <EmptyState
            title="Not on any roster"
            message="Nothing will be recorded for this student until they are added to a subject. Add them from a subject's roster tab."
            action={
              <Link className="btn btn-primary btn-sm" to="/subjects">
                Go to Subjects
              </Link>
            }
          />
        }
      />
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Attendance                                                                  */
/* -------------------------------------------------------------------------- */

function AttendanceSection({ studentId, resource, isAdmin }) {
  const toast = useToast();

  const exportCsv = useAsync(() => AnalyticsAPI.exportStudent(studentId), {
    onSuccess: () => toast.success('Export downloaded.'),
    onError: (error) => toast.notifyError(error),
  });

  if (resource.error && !resource.data) {
    return (
      <ErrorState
        error={resource.error}
        onRetry={resource.reload}
        title="Could not load attendance"
      />
    );
  }
  if (resource.loading && !resource.data) return <LoadingBlock label="Loading attendance…" />;

  const report = resource.data.report || {};
  const overall = report.overall || { present: 0, total: 0, percentage: 0 };
  const rows = report.subjects || [];
  const history = resource.data.history || [];

  // `GET /api/students/:id/attendance` filters the rows a teacher may see but
  // leaves `overall` computed across every subject the student is enrolled in, so
  // the headline and the table can disagree. `routes/analytics.py:170` recomputes it
  // for exactly this reason — "both a leak and a number they cannot explain to
  // anyone" — and that is what happens here for the endpoint that does not.
  const visible = rows.reduce(
    (sum, row) => ({ present: sum.present + row.present, total: sum.total + row.total }),
    { present: 0, total: 0 },
  );
  const scoped = !isAdmin && visible.total !== overall.total;
  const headline = scoped
    ? {
        present: visible.present,
        total: visible.total,
        percentage: visible.total ? (visible.present / visible.total) * 100 : 0,
      }
    : overall;

  return (
    <>
      <StatGrid>
        <StatTile
          label={scoped ? 'Across your subjects' : 'Overall attendance'}
          value={formatPercent(headline.percentage)}
          tone={attendanceTone(headline.percentage)}
          meta={`${headline.present} of ${headline.total} sessions`}
        />
        <StatTile
          label="Subjects"
          value={formatNumber(rows.length)}
          tone="muted"
          meta={scoped ? 'that you teach' : 'with a recorded session'}
        />
        <StatTile
          label="Below requirement"
          value={formatNumber(rows.filter((row) => row.below_threshold).length)}
          tone={rows.some((row) => row.below_threshold) ? 'danger' : 'success'}
          meta="subjects needing attention"
        />
      </StatGrid>

      {scoped ? (
        <Alert tone="info" title="These figures cover your subjects only">
          This student is enrolled in subjects you do not teach; those are left out of the tiles above
          and the table below. Recent activity, further down, is not filtered — it is their whole
          record. An administrator sees the full figures.
        </Alert>
      ) : null}

      <Card
        flush
        title="By subject"
        subtitle="Each subject is judged against its own requirement, which may differ from the institution default."
        actions={
          // Per-student CSV is admin-only by design: a teacher's copy would have to
          // be silently truncated to their own subjects, and the endpoint refuses
          // rather than hand out a file that looks complete and is not.
          isAdmin ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => exportCsv.run()}
              loading={exportCsv.loading}
            >
              Export CSV
            </Button>
          ) : null
        }
        footer={
          isAdmin ? null : (
            <span className="small muted">
              Per-student exports are admin-only. Export the report from a subject's page instead —
              that file is complete for the subject it covers.
            </span>
          )
        }
      >
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
              key: 'below_threshold',
              header: '',
              align: 'right',
              nowrap: true,
              render: (row) => (row.below_threshold ? <Badge tone="danger">Defaulter</Badge> : null),
            },
          ]}
          rows={rows}
          rowKey="subject_id"
          empty={
            <EmptyState
              title="No attendance recorded yet"
              message="Nothing is recorded until a session runs for a subject this student is on."
            />
          }
        />
      </Card>

      <Card
        title="Recent activity"
        subtitle={
          scoped
            ? `The last ${pluralize(history.length, 'record')}, newest first, across every subject they are on.`
            : `The last ${pluralize(history.length, 'record')}, newest first.`
        }
      >
        {history.length ? (
          <div className="timeline">
            {history.map((record, index) => {
              const present = record.status === AttendanceStatus.PRESENT;
              return (
                <div className="timeline-item" key={`${record.session_id}-${index}`}>
                  {/* The dot's colour is data, and the stylesheet scopes no tone
                      class to it — same call BarList makes for a per-row tone. */}
                  <span
                    className="timeline-dot"
                    style={{ background: present ? 'var(--success)' : 'var(--danger)' }}
                    aria-hidden="true"
                  />
                  <div className="timeline-body">
                    <div className="row row-wrap between">
                      <span className="strong">
                        {record.session_title || record.subject_name || 'Session'}
                      </span>
                      <span className="small faint nowrap">
                        {formatDateTime(record.session_start)}
                      </span>
                    </div>
                    <div className="row row-wrap row-sm">
                      <Badge tone={present ? 'success' : 'danger'}>
                        {present ? 'Present' : 'Absent'}
                      </Badge>
                      {record.subject_code ? <Pill>{record.subject_code}</Pill> : null}
                      {record.method_used ? (
                        <Pill tone={METHOD_TONES[record.method_used] || 'muted'}>
                          {METHOD_LABELS[record.method_used] || record.method_used}
                        </Pill>
                      ) : null}
                      {record.confidence_score !== null &&
                      record.confidence_score !== undefined ? (
                        <span className="small faint">
                          {formatConfidence(record.confidence_score)} confidence
                        </span>
                      ) : null}
                      {/* A manual override always wins over the recognition result,
                          so it has to be visible wherever the result is. */}
                      {record.was_manual_override ? <Badge tone="warn">Manual override</Badge> : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="Nothing yet"
            message="Records appear here as soon as this student is marked in a session."
          />
        )}
      </Card>
    </>
  );
}
