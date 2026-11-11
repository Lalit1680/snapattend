import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

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
  Table,
} from '../../components/ui/index.js';
import { AdminAPI, SubjectsAPI } from '../../lib/api.js';
import { Role } from '../../lib/constants.js';
import { formatNumber, pluralize } from '../../lib/format.js';
import useAsync from '../../hooks/useAsync.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';

/**
 * Subjects, and the form that creates one.
 *
 * A subject is the unit everything else hangs off: sessions belong to one, rosters
 * belong to one, and every report is scoped to one. So this is the first page a new
 * institution has to use, and the empty state has to say so.
 *
 * Editing, archiving and the roster all live on the detail page. Two places to
 * change the same thing is two places to keep correct.
 */
export default function SubjectsPage() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  useDocumentTitle('Subjects');

  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const subjects = useResource(
    () => SubjectsAPI.list(includeArchived ? { include_archived: 'true' } : null),
    [includeArchived],
  );
  const rows = (subjects.data && subjects.data.subjects) || [];

  const columns = [
    {
      key: 'code',
      header: 'Code',
      nowrap: true,
      render: (subject) => <span className="mono strong">{subject.code}</span>,
    },
    {
      key: 'name',
      header: 'Subject',
      render: (subject) => (
        <div className="stack-sm">
          <span className="strong truncate">{subject.name}</span>
          {/* Who to chase when the register is wrong. Truncated by the cell, not
              by JS, so a wide screen shows the whole list. */}
          <span className="small faint truncate">
            {(subject.teachers || []).length
              ? subject.teachers.map((teacher) => teacher.name || 'Unknown').join(', ')
              : 'No teacher assigned'}
          </span>
        </div>
      ),
    },
    {
      key: 'roster_size',
      header: 'Students',
      align: 'right',
      nowrap: true,
      render: (subject) => formatNumber(subject.roster_size),
    },
    {
      key: 'session_count',
      header: 'Sessions',
      align: 'right',
      nowrap: true,
      render: (subject) => formatNumber(subject.session_count),
    },
    {
      key: 'attendance_threshold',
      header: 'Required',
      align: 'right',
      nowrap: true,
      // `null` means "inherit the institution setting", which is a different
      // statement from a number and has to read differently.
      render: (subject) =>
        subject.attendance_threshold === null || subject.attendance_threshold === undefined ? (
          <span className="faint small">Institution default</span>
        ) : (
          <span className="mono">{subject.attendance_threshold}%</span>
        ),
    },
    {
      key: 'archived',
      header: '',
      align: 'right',
      nowrap: true,
      render: (subject) =>
        subject.archived ? (
          <Badge tone="muted">Archived</Badge>
        ) : !subject.roster_size ? (
          // The one state that stops a subject working: `POST /api/sessions`
          // refuses an empty roster with a 409.
          <Badge tone="warn">No roster</Badge>
        ) : null,
    },
    {
      key: 'go',
      header: '',
      align: 'right',
      nowrap: true,
      render: (subject) => (
        <Link className="btn btn-secondary btn-sm" to={`/subjects/${subject.id}`}>
          Open
        </Link>
      ),
    },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Subjects</h1>
          <p className="page-sub">
            Each subject has its own roster, its own sessions and its own attendance requirement.
          </p>
        </div>
        <div className="page-actions">
          <Checkbox
            label="Show archived"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          <Button onClick={() => setCreating(true)}>New subject</Button>
        </div>
      </div>

      {subjects.error && !subjects.data ? (
        <ErrorState error={subjects.error} onRetry={subjects.reload} title="Could not load subjects" />
      ) : subjects.loading && !subjects.data ? (
        <LoadingBlock label="Loading subjects…" />
      ) : (
        <Card
          flush
          title={rows.length ? pluralize(rows.length, 'subject') : 'Subjects'}
          actions={
            <Button variant="ghost" size="sm" onClick={subjects.reload} loading={subjects.loading}>
              Refresh
            </Button>
          }
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey="id"
            loading={subjects.loading}
            onRowClick={(subject) => navigate(`/subjects/${subject.id}`)}
            empty={
              <EmptyState
                title={includeArchived ? 'No subjects at all yet' : 'No active subjects'}
                message="A subject is where a roster, its sessions and its reports live. Create one, add students to it, then open a session."
                action={<Button onClick={() => setCreating(true)}>New subject</Button>}
              />
            }
          />
        </Card>
      )}

      <NewSubjectDialog
        open={creating}
        isAdmin={isAdmin}
        onClose={() => setCreating(false)}
        onCreated={(subject) => {
          setCreating(false);
          // Straight to the detail page, because a subject with no roster cannot
          // hold a session and adding students is the only sensible next move.
          navigate(`/subjects/${subject.id}`);
        }}
      />
    </div>
  );
}

/** `_clean_code` in `routes/subjects.py`: uppercased, spaces stripped, 2–24 chars. */
function normaliseCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '');
}

function NewSubjectDialog({ open, isAdmin, onClose, onCreated }) {
  const toast = useToast();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [useOwnThreshold, setUseOwnThreshold] = useState(false);
  const [threshold, setThreshold] = useState('75');
  const [teacherIds, setTeacherIds] = useState([]);

  // Admin only: `PATCH`/`POST` reject `teacher_ids` from a teacher with a 409, and
  // `GET /api/admin/users` is admin-gated, so a teacher must not even request it.
  const teachers = useResource(
    () => (isAdmin && open ? AdminAPI.users({ role: Role.TEACHER }) : Promise.resolve({ users: [] })),
    [isAdmin, open],
  );
  const teacherList = (teachers.data && teachers.data.users) || [];

  const create = useAsync((payload) => SubjectsAPI.create(payload), {
    onSuccess: (data) => {
      toast.success(`${data.subject.code} created.`);
      onCreated(data.subject);
    },
  });

  const close = () => {
    create.reset();
    onClose();
  };

  const toggleTeacher = (id) => {
    setTeacherIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : current.concat(id),
    );
  };

  const submit = (event) => {
    event.preventDefault();
    const cleanCode = normaliseCode(code);
    if (!name.trim() || cleanCode.length < 2) return;
    create.run({
      name: name.trim(),
      code: cleanCode,
      // Omitted entirely when inheriting: sending `null` is also "inherit", but
      // omitting it keeps the create body to what the teacher actually chose.
      attendance_threshold: useOwnThreshold ? Number(threshold) : undefined,
      teacher_ids: isAdmin && teacherIds.length ? teacherIds : undefined,
    });
  };

  const fieldErrors = create.error ? create.error.fieldErrors : null;

  return (
    <Modal
      open={open}
      title="New subject"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={create.loading}>
            Cancel
          </Button>
          <Button type="submit" form="new-subject-form" loading={create.loading}>
            Create subject
          </Button>
        </>
      }
    >
      <form id="new-subject-form" className="stack" onSubmit={submit} noValidate>
        {create.error ? (
          <Alert
            tone={create.error.status === 409 ? 'warn' : 'danger'}
            title={
              create.error.status === 409 ? 'That code is taken' : 'The subject was not created'
            }
          >
            {create.error.message}
          </Alert>
        ) : null}

        <Input
          label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Data Structures"
          required
          error={fieldErrors && fieldErrors.name}
          maxLength={120}
        />

        <Input
          label="Code"
          value={code}
          // Normalised as it is typed so the field shows exactly what will be
          // stored — otherwise "cs 101" looks accepted and comes back "CS101".
          onChange={(event) => setCode(normaliseCode(event.target.value))}
          placeholder="CS101"
          required
          hint="2–24 characters, uppercase, no spaces. Unique across the institution."
          error={fieldErrors && fieldErrors.code}
          maxLength={24}
          className="mono"
        />

        <Checkbox
          label="Set a different attendance requirement for this subject"
          checked={useOwnThreshold}
          onChange={(event) => setUseOwnThreshold(event.target.checked)}
          hint="Leave unchecked to follow the institution-wide setting, so changing it once changes it everywhere."
        />

        {useOwnThreshold ? (
          <Input
            label="Required attendance"
            type="number"
            min="1"
            max="100"
            step="1"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            hint="Students below this appear as defaulters in reports and in the alert digest."
            error={fieldErrors && fieldErrors.attendance_threshold}
          />
        ) : null}

        {isAdmin ? (
          <fieldset className="fieldset">
            <legend className="legend">Assigned teachers</legend>
            <p className="field-hint">
              A teacher can only see and manage subjects they are assigned to. You can change this
              later; leaving it empty assigns nobody but you keep admin access.
            </p>
            {teachers.loading ? (
              <LoadingBlock label="Loading teachers…" />
            ) : teacherList.length === 0 ? (
              <Alert
                tone="info"
                title="No teachers yet"
                actions={
                  <Link className="btn btn-secondary btn-sm" to="/admin/users">
                    Invite a teacher
                  </Link>
                }
              >
                You can create the subject now and assign teachers once they have accepted an
                invitation.
              </Alert>
            ) : (
              <div className="stack-sm">
                {teacherList.map((teacher) => (
                  <Checkbox
                    key={teacher.id}
                    label={teacher.name || teacher.email}
                    hint={teacher.name ? teacher.email : undefined}
                    checked={teacherIds.includes(teacher.id)}
                    onChange={() => toggleTeacher(teacher.id)}
                  />
                ))}
              </div>
            )}
          </fieldset>
        ) : (
          <Alert tone="info" title="You will be assigned to this subject">
            <Pill>Automatic</Pill> A subject you create is yours to manage — an admin can add other
            teachers to it later.
          </Alert>
        )}
      </form>
    </Modal>
  );
}
