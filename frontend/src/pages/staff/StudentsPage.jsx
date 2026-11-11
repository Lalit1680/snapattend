import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import InviteResult from '../../components/InviteResult.jsx';
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
  StatGrid,
  StatTile,
  Table,
} from '../../components/ui/index.js';
import { StudentsAPI, SubjectsAPI } from '../../lib/api.js';
import {
  ENROLLMENT_STATUS_LABELS,
  EnrollmentStatus,
  UserStatus,
} from '../../lib/constants.js';
import { formatBytes, formatNumber, pluralize } from '../../lib/format.js';
import useAsync from '../../hooks/useAsync.js';
import useDebouncedValue from '../../hooks/useDebouncedValue.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
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

const ACCOUNT_LABELS = {
  [UserStatus.INVITED]: 'Not activated',
  [UserStatus.ACTIVE]: 'Active',
  [UserStatus.DISABLED]: 'Disabled',
};

const STATUS_OPTIONS = [
  { value: '', label: 'Any enrollment state' },
  { value: EnrollmentStatus.INVITED, label: 'Invited — not signed in' },
  { value: EnrollmentStatus.PENDING_BIOMETRICS, label: 'Signed in — biometrics pending' },
  { value: EnrollmentStatus.COMPLETE, label: 'Enrolled' },
];

/** `clamp_int(limit, 200, minimum=1, maximum=1000)` in `routes/students.py`. */
const DEFAULT_LIMIT = 200;
const SEARCH_LIMIT = 1000;

/**
 * The student directory: who exists, how far through enrollment they are, and the
 * two ways to add more of them.
 *
 * Enrollment state is the column that matters. A student who has not enrolled a
 * face cannot be matched from a class photo, and a student who never activated
 * their account cannot check themselves in at all — both are invisible failures at
 * the moment they matter, so they are visible here instead.
 */
export default function StudentsPage() {
  const navigate = useNavigate();
  useDocumentTitle('Students');

  const [query, setQuery] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [status, setStatus] = useState('');
  const [faceMissingOnly, setFaceMissingOnly] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [importing, setImporting] = useState(false);

  const search = useDebouncedValue(query.trim(), 250);

  const subjects = useResource(() => SubjectsAPI.list(), []);
  const subjectList = (subjects.data && subjects.data.subjects) || [];

  const params = useMemo(
    () => ({
      q: search || undefined,
      subject_id: subjectId || undefined,
      enrollment_status: status || undefined,
      // The backend reads `face_enrolled` as a literal "0"/"false" to mean "only
      // those without one"; any other value is ignored.
      face_enrolled: faceMissingOnly ? 'false' : undefined,
      // `q` is matched *after* the row limit is applied, so a search against the
      // default 200 would silently miss people further down the alphabet. Asking
      // for the maximum only while searching keeps the common case cheap.
      limit: search ? SEARCH_LIMIT : DEFAULT_LIMIT,
    }),
    [search, subjectId, status, faceMissingOnly],
  );

  const students = useResource(() => StudentsAPI.list(params), [params]);
  const rows = (students.data && students.data.students) || [];
  const filtered = Boolean(search || subjectId || status || faceMissingOnly);

  const counts = useMemo(
    () => ({
      face: rows.filter((row) => row.face_enrolled).length,
      voice: rows.filter((row) => row.voice_enrolled).length,
      notActivated: rows.filter((row) => row.account_status === UserStatus.INVITED).length,
    }),
    [rows],
  );

  const columns = [
    {
      key: 'name',
      header: 'Student',
      render: (row) => (
        <div className="stack-sm">
          <Link className="strong" to={`/students/${row.student_id}`}>
            {row.name || 'Unnamed'}
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
      // Sample counts, not just a tick: two face samples work, five work better,
      // and only the count says which one a student has.
      render: (row) => (
        <div className="row row-sm">
          <Pill tone={row.face_enrolled ? 'success' : 'muted'}>
            {row.face_enrolled ? `Face ×${row.face_sample_count || 0}` : 'No face'}
          </Pill>
          <Pill tone={row.voice_enrolled ? 'success' : 'muted'}>
            {row.voice_enrolled ? `Voice ×${row.voice_sample_count || 0}` : 'No voice'}
          </Pill>
        </div>
      ),
    },
    {
      key: 'account_status',
      header: 'Account',
      nowrap: true,
      render: (row) => (
        <Badge tone={ACCOUNT_TONES[row.account_status] || 'muted'}>
          {ACCOUNT_LABELS[row.account_status] || row.account_status || 'Unknown'}
        </Badge>
      ),
    },
    {
      key: 'go',
      header: '',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <Link className="btn btn-secondary btn-sm" to={`/students/${row.student_id}`}>
          Open
        </Link>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Students</h1>
          <p className="page-sub">
            Every student account in the institution. Add them one at a time, or import a class list.
          </p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={() => setImporting(true)}>
            Import CSV
          </Button>
          <Button onClick={() => setInviting(true)}>Invite student</Button>
        </div>
      </div>

      <StatGrid>
        <StatTile
          label={filtered ? 'Matching students' : 'Students'}
          value={formatNumber(rows.length)}
          tone="info"
          meta={filtered ? 'in the current filter' : undefined}
        />
        <StatTile
          label="Face enrolled"
          value={`${counts.face} / ${rows.length}`}
          tone={rows.length && counts.face === rows.length ? 'success' : 'warn'}
          meta="can be marked from a class photo"
        />
        <StatTile
          label="Voice enrolled"
          value={`${counts.voice} / ${rows.length}`}
          tone="muted"
          meta="can use voice check-in"
        />
        <StatTile
          label="Never signed in"
          value={formatNumber(counts.notActivated)}
          tone={counts.notActivated ? 'warn' : 'success'}
          meta="invitation not accepted yet"
        />
      </StatGrid>

      <Card title="Filter">
        <div className="form-grid">
          <Input
            label="Search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, email or roll number"
          />
          <SubjectPicker
            value={subjectId}
            onChange={setSubjectId}
            subjects={subjectList}
            includeAll
            label="On the roster of"
          />
          <Select
            label="Enrollment"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          />
        </div>
        <Checkbox
          label="Only students with no face enrolled"
          checked={faceMissingOnly}
          onChange={(event) => setFaceMissingOnly(event.target.checked)}
          hint="The list to work from before a class-photo session — nobody here can be matched by the photo."
        />
      </Card>

      {students.error && !students.data ? (
        <ErrorState error={students.error} onRetry={students.reload} title="Could not load students" />
      ) : students.loading && !students.data ? (
        <LoadingBlock label="Loading students…" />
      ) : (
        <Card
          flush
          title={rows.length ? pluralize(rows.length, 'student') : 'Students'}
          subtitle={
            rows.length >= params.limit
              ? `Showing the first ${formatNumber(params.limit)}. Narrow by subject or search to see the rest.`
              : undefined
          }
          actions={
            <Button variant="ghost" size="sm" onClick={students.reload} loading={students.loading}>
              Refresh
            </Button>
          }
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey="student_id"
            loading={students.loading}
            onRowClick={(row) => navigate(`/students/${row.student_id}`)}
            empty={
              <EmptyState
                title={filtered ? 'No student matches those filters' : 'No students yet'}
                message={
                  filtered
                    ? 'Try clearing the filters — a student only appears under a subject once they are on its roster.'
                    : 'Invite students by email, or import a class list as CSV. There is no public signup link, so every account starts here.'
                }
                action={
                  filtered ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setQuery('');
                        setSubjectId('');
                        setStatus('');
                        setFaceMissingOnly(false);
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : (
                    <Button onClick={() => setInviting(true)}>Invite student</Button>
                  )
                }
              />
            }
          />
        </Card>
      )}

      <InviteStudentDialog
        open={inviting}
        subjects={subjectList}
        onClose={() => setInviting(false)}
        onInvited={students.reload}
      />

      <ImportDialog
        open={importing}
        subjects={subjectList}
        onClose={() => setImporting(false)}
        onImported={students.reload}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Invite one                                                                  */
/* -------------------------------------------------------------------------- */

function InviteStudentDialog({ open, subjects, onClose, onInvited }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [rollNumber, setRollNumber] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [result, setResult] = useState(null);

  const invite = useAsync((payload) => StudentsAPI.invite(payload), {
    onSuccess: (data) => {
      setResult(data);
      // The form clears but the dialog stays open: inviting three students in a row
      // is the normal case, and the result of each one has to be readable — it may
      // hold the only copy of the invitation link.
      setName('');
      setEmail('');
      setRollNumber('');
      onInvited();
    },
  });

  const close = () => {
    invite.reset();
    setResult(null);
    onClose();
  };

  const submit = (event) => {
    event.preventDefault();
    if (!name.trim() || !email.trim()) return;
    invite.run({
      name: name.trim(),
      email: email.trim(),
      roll_number: rollNumber.trim() || undefined,
      subject_id: subjectId || undefined,
    });
  };

  const fieldErrors = invite.error ? invite.error.fieldErrors : null;

  return (
    <Modal
      open={open}
      title="Invite a student"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={invite.loading}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          <Button type="submit" form="invite-student-form" loading={invite.loading}>
            Send invitation
          </Button>
        </>
      }
    >
      <form id="invite-student-form" className="stack" onSubmit={submit} noValidate>
        {result ? <InviteResult result={result} onDismiss={() => setResult(null)} /> : null}

        {invite.error ? (
          <Alert
            tone={invite.error.status === 409 ? 'warn' : 'danger'}
            title={
              invite.error.status === 409
                ? 'That address is already in use'
                : 'The invitation was not created'
            }
          >
            {invite.error.message}
          </Alert>
        ) : null}

        <Input
          label="Full name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ada Lovelace"
          required
          error={fieldErrors && fieldErrors.name}
          autoComplete="off"
        />

        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="ada@example.edu"
          required
          hint="Where the invitation goes. It becomes their sign-in address and cannot be changed here later."
          error={fieldErrors && fieldErrors.email}
          autoComplete="off"
        />

        <Input
          label="Roll number"
          value={rollNumber}
          onChange={(event) => setRollNumber(event.target.value)}
          placeholder="2024CS042"
          hint="Optional, up to 32 characters. Appears on every export next to their name."
          className="mono"
          maxLength={32}
        />

        <SubjectPicker
          value={subjectId}
          onChange={setSubjectId}
          subjects={subjects}
          includeAll
          label="Add to subject (optional)"
        />
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Import many                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * CSV import, always previewed first.
 *
 * The importer is partial-success by design — 198 of 200 rows land and the two bad
 * ones are reported by line number. That is the right behaviour and the wrong thing
 * to discover afterwards, so this runs `dry_run` first and only commits on a second,
 * explicit click.
 */
function ImportDialog({ open, subjects, onClose, onImported }) {
  const toast = useToast();

  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [subjectId, setSubjectId] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);

  const dryRun = useAsync(
    (chosen) => StudentsAPI.importFile(chosen, { subject_id: subjectId || undefined, dry_run: true }),
    {
      onSuccess: setPreview,
      onError: (error) => toast.notifyError(error),
    },
  );

  const commit = useAsync(
    (chosen) => StudentsAPI.importFile(chosen, { subject_id: subjectId || undefined }),
    {
      onSuccess: (data) => {
        setResult(data);
        setPreview(null);
        toast.success(`${pluralize(data.invited_count, 'student')} invited.`);
        onImported();
      },
      onError: (error) => toast.notifyError(error),
    },
  );

  const template = useAsync(() => StudentsAPI.downloadTemplate(), {
    onError: (error) => toast.notifyError(error),
  });

  const choose = (chosen) => {
    if (!chosen) return;
    setFile(chosen);
    setPreview(null);
    setResult(null);
    dryRun.reset();
    commit.reset();
  };

  const close = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setDragging(false);
    dryRun.reset();
    commit.reset();
    onClose();
  };

  // The parse failure is a 400 whose details carry the offending lines, which is
  // far more useful than the sentence — a header typo is invisible otherwise.
  const parseError = dryRun.error || commit.error;
  const parseRows =
    parseError && parseError.details && Array.isArray(parseError.details.row_errors)
      ? parseError.details.row_errors
      : null;

  return (
    <Modal
      open={open}
      title="Import students from CSV"
      wide
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={dryRun.loading || commit.loading}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          {preview ? (
            <Button
              onClick={() => commit.run(file)}
              loading={commit.loading}
              disabled={!preview.would_invite_count}
            >
              Invite {preview.would_invite_count}
            </Button>
          ) : (
            <Button onClick={() => dryRun.run(file)} loading={dryRun.loading} disabled={!file}>
              Check the file
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        {result ? (
          <ImportOutcome result={result} />
        ) : (
          <>
            <Alert
              tone="info"
              title="Two columns: name and email"
              actions={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => template.run()}
                  loading={template.loading}
                >
                  Download template
                </Button>
              }
            >
              Extra columns are ignored, a missing header is tolerated, and a row with no name falls
              back to the part of the email before the @. Up to 512 KB per file.
            </Alert>

            {/* A plain file input inside a label: it keeps the keyboard and screen
                reader behaviour the browser already gets right, and drag-and-drop
                is added on top rather than replacing it. */}
            <label
              className={dragging ? 'dropzone is-active' : 'dropzone'}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                choose(event.dataTransfer.files && event.dataTransfer.files[0]);
              }}
            >
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => choose(event.target.files && event.target.files[0])}
              />
              {file ? (
                <div className="stack-sm center">
                  <span className="strong">{file.name}</span>
                  <span className="small muted">{formatBytes(file.size)} — click to choose another</span>
                </div>
              ) : (
                <div className="stack-sm center">
                  <span className="strong">Choose a CSV file</span>
                  <span className="small muted">or drop one here</span>
                </div>
              )}
            </label>

            <SubjectPicker
              value={subjectId}
              onChange={setSubjectId}
              subjects={subjects}
              includeAll
              label="Also add everyone to (optional)"
            />

            {parseError ? (
              <Alert tone="danger" title="That file could not be read">
                <div className="stack-sm">
                  <p>{parseError.message}</p>
                  {parseRows ? <RowErrors rows={parseRows} /> : null}
                  {parseRows && Number(parseError.details.error_count) > parseRows.length ? (
                    <p className="small muted">
                      {formatNumber(parseError.details.error_count)} rows have problems; the first{' '}
                      {parseRows.length} are shown.
                    </p>
                  ) : null}
                </div>
              </Alert>
            ) : null}

            {preview ? <ImportPreview preview={preview} /> : null}
          </>
        )}
      </div>
    </Modal>
  );
}

function ImportPreview({ preview }) {
  const errors = preview.row_errors || [];
  return (
    <div className="stack">
      <Alert
        tone={errors.length ? 'warn' : 'success'}
        title={
          errors.length
            ? `${pluralize(preview.would_invite_count, 'student')} will be invited, ${pluralize(errors.length, 'row')} will be skipped`
            : `${pluralize(preview.would_invite_count, 'student')} will be invited`
        }
      >
        Nothing has been written yet. The skipped rows stay skipped — fix them in the file and import
        it again, which is safe: an address that already has an account is skipped rather than
        duplicated.
        {preview.subject ? ` Everyone invited will also be added to ${preview.subject}.` : ''}
      </Alert>

      {errors.length ? <RowErrors rows={errors} /> : null}

      {preview.would_invite_count ? (
        <Card flush title="Will be invited">
          <Table
            compact
            columns={[
              { key: 'name', header: 'Name' },
              { key: 'email', header: 'Email' },
            ]}
            rows={preview.would_invite}
            rowKey={(row, index) => `${row.email}-${index}`}
          />
        </Card>
      ) : null}
    </div>
  );
}

function ImportOutcome({ result }) {
  const skipped = result.skipped || [];
  const errors = result.row_errors || [];

  return (
    <div className="stack">
      <Alert tone="success" title={`${pluralize(result.invited_count, 'student')} invited`}>
        <div className="stack-sm">
          {result.subject ? (
            <p>
              {pluralize(result.enrolled_in_subject, 'student')} were also added to{' '}
              <strong>{result.subject}</strong>.
            </p>
          ) : null}
          {/* This endpoint reports how many invitations it *created*, and gives no
              signal about whether mail is configured — so it must not be read as
              "delivered". Semantics #5. */}
          <p className="small muted">
            Accounts are created immediately. If this server has no mail account configured, nothing
            was delivered — open a student and use Resend invitation to get their link.
          </p>
        </div>
      </Alert>

      {skipped.length ? (
        <Card flush title={`${pluralize(skipped.length, 'address')} skipped`}>
          <Table
            compact
            columns={[
              { key: 'email', header: 'Email' },
              { key: 'reason', header: 'Why' },
            ]}
            rows={skipped}
            rowKey={(row, index) => `${row.email}-${index}`}
          />
        </Card>
      ) : null}

      {errors.length ? <RowErrors rows={errors} /> : null}
    </div>
  );
}

/** Line-numbered parse failures, so the file can be fixed in one pass. */
function RowErrors({ rows }) {
  return (
    <Card flush title={`${pluralize(rows.length, 'row')} could not be read`}>
      <Table
        compact
        columns={[
          {
            key: 'line',
            header: 'Line',
            align: 'right',
            nowrap: true,
            width: '4.5rem',
            render: (row) => <span className="mono">{row.line}</span>,
          },
          {
            key: 'value',
            header: 'Content',
            render: (row) => <span className="mono small truncate">{row.value}</span>,
          },
          { key: 'error', header: 'Problem' },
        ]}
        rows={rows}
        rowKey={(row, index) => `${row.line}-${index}`}
      />
    </Card>
  );
}
