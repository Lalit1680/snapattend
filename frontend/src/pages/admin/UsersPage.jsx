import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import InviteResult from '../../components/InviteResult.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  Pill,
  Select,
  Table,
  Tabs,
  Textarea,
} from '../../components/ui/index.js';
import { AdminAPI } from '../../lib/api.js';
import {
  ENROLLMENT_STATUS_LABELS,
  InviteStatus,
  ROLE_LABELS,
  Role,
  UserStatus,
} from '../../lib/constants.js';
import {
  formatDateTime,
  formatRelative,
  initials,
  pluralize,
} from '../../lib/format.js';
import useDebouncedValue from '../../hooks/useDebouncedValue.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';

const TABS = [
  { key: 'people', label: 'People' },
  { key: 'invites', label: 'Invitations' },
];

const ROLE_OPTIONS = [
  { value: '', label: 'Every role' },
  { value: Role.ADMIN, label: 'Administrators' },
  { value: Role.TEACHER, label: 'Teachers' },
  { value: Role.STUDENT, label: 'Students' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: UserStatus.ACTIVE, label: 'Active' },
  { value: UserStatus.INVITED, label: 'Invited, never signed in' },
  { value: UserStatus.DISABLED, label: 'Disabled' },
];

const STATUS_TONES = {
  [UserStatus.INVITED]: 'warn',
  [UserStatus.ACTIVE]: 'success',
  [UserStatus.DISABLED]: 'danger',
};

const STATUS_LABELS = {
  [UserStatus.INVITED]: 'Invited',
  [UserStatus.ACTIVE]: 'Active',
  [UserStatus.DISABLED]: 'Disabled',
};

const ROLE_TONES = {
  [Role.ADMIN]: 'primary',
  [Role.TEACHER]: 'info',
  [Role.STUDENT]: 'muted',
};

const INVITE_TONES = {
  [InviteStatus.PENDING]: 'warn',
  [InviteStatus.ACCEPTED]: 'success',
  [InviteStatus.REVOKED]: 'danger',
};

/**
 * A filter value, not a status.
 *
 * `?status=` on `GET /api/admin/invites` goes straight into the Mongo query at
 * `routes/admin.py:394`, and no code path ever writes `"expired"` — a lapsed
 * invitation is still `pending` with `expires_at` in the past. Asking the server
 * for it would return an empty table every time, so this value fetches the pending
 * set and narrows it here instead. Namespaced so it can never collide with a status
 * the backend might add later.
 */
const EXPIRED_FILTER = 'derived:expired';

const INVITE_STATUS_OPTIONS = [
  { value: InviteStatus.PENDING, label: 'Still pending' },
  { value: EXPIRED_FILTER, label: 'Pending but lapsed' },
  { value: InviteStatus.ACCEPTED, label: 'Accepted' },
  { value: InviteStatus.REVOKED, label: 'Revoked' },
  { value: 'all', label: 'Everything' },
];

/** True once the signed link inside the invitation would be rejected. */
const hasLapsed = (row) =>
  row.status === InviteStatus.PENDING && row.expires_at && new Date(row.expires_at) < new Date();

/**
 * Everyone with an account here, and every invitation that has been issued.
 *
 * Two tabs because they answer different questions: the people list is "who can
 * sign in and what can they do", the invitation list is "who was asked and never
 * turned up". They overlap but do not agree — revoking an invitation deletes the
 * placeholder user, so an invitation can outlive the account it created.
 */
export default function UsersPage() {
  useDocumentTitle('People');

  const [tab, setTab] = useState('people');
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState(null);
  // Bumped after any mutation. Both panels take it as a `useResource` dep, so the
  // list the admin is looking at reloads whether or not it owned the action.
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh((n) => n + 1);

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">People</h1>
          <p className="page-sub">
            Staff and students, their access, and the invitations that created them.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-secondary" to="/students">
            Invite students
          </Link>
          <Button onClick={() => setInviting(true)}>Invite a teacher</Button>
        </div>
      </div>

      {invite ? <InviteResult result={invite} onDismiss={() => setInvite(null)} /> : null}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'people' ? (
        <PeoplePanel refresh={refresh} onChanged={bump} />
      ) : (
        <InvitesPanel refresh={refresh} />
      )}

      <InviteTeacherDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onDone={(result) => {
          setInvite(result);
          setInviting(false);
          bump();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* People                                                                     */
/* ------------------------------------------------------------------------- */

function PeoplePanel({ refresh, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();

  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim(), 300);

  const [busyId, setBusyId] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [reason, setReason] = useState('');

  // Unlike `GET /api/students`, this endpoint puts `q` in the Mongo query rather
  // than filtering the page it already fetched, so the default limit is honest and
  // there is nothing to work around here.
  const params = useMemo(() => {
    const next = { limit: 500 };
    if (role) next.role = role;
    if (status) next.status = status;
    if (query) next.q = query;
    return next;
  }, [role, status, query]);

  const users = useResource(() => AdminAPI.users(params), [params, refresh]);
  const rows = (users.data && users.data.users) || [];
  const myId = (user && user.id) || null;

  const openConfirm = (kind, row) => {
    setReason('');
    setConfirm({ kind, row });
  };

  const runAction = async () => {
    if (!confirm) return;
    const { kind, row } = confirm;
    setBusyId(row.id);
    try {
      if (kind === 'disable') {
        await AdminAPI.disableUser(row.id, reason.trim() || undefined);
        toast.success(`${row.name} can no longer sign in.`);
      } else if (kind === 'enable') {
        const result = await AdminAPI.enableUser(row.id);
        // The server decides between `active` and `invited` by whether a password
        // was ever set, so the message reports what came back rather than guessing.
        toast.success(
          result.status === UserStatus.ACTIVE
            ? `${row.name} can sign in again.`
            : `${row.name} is enabled, but never set a password — they need a fresh invitation.`,
        );
      } else if (kind === 'revoke') {
        await AdminAPI.revokeInvite(row.id);
        toast.success(`The invitation for ${row.email} was revoked and the placeholder removed.`);
      } else if (kind === 'promote') {
        await AdminAPI.changeRole(row.id, Role.ADMIN);
        toast.success(`${row.name} is now an administrator.`);
      } else if (kind === 'demote') {
        await AdminAPI.changeRole(row.id, Role.TEACHER);
        toast.success(`${row.name} is now a teacher.`);
      }
      setConfirm(null);
      onChanged();
    } catch (error) {
      // The three refusals this endpoint can raise (own account, institution
      // owner, last active admin) are 409s with a written reason. Showing that
      // reason is better than a guess: the owner's id is not in any response, so
      // the client cannot know in advance which button will be refused.
      toast.notifyError(error);
    } finally {
      setBusyId(null);
    }
  };

  const resend = async (row) => {
    setBusyId(row.id);
    try {
      const result = await AdminAPI.resendInvite(row.id);
      // Routed through the same component the invite dialog uses, so a server with
      // no mailer surfaces the link instead of claiming an email went out.
      setConfirm({ kind: 'resent', row, result });
      onChanged();
    } catch (error) {
      toast.notifyError(error);
    } finally {
      setBusyId(null);
    }
  };

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    },
    {},
  );

  return (
    <>
      <Card
        title="Directory"
        subtitle="Sorted by name. Disabling keeps a person's attendance history — it only ends their access."
        actions={
          <Button variant="ghost" size="sm" onClick={users.reload} loading={users.loading}>
            Refresh
          </Button>
        }
      >
        <div className="grid grid-3">
          <Input
            label="Search"
            type="search"
            placeholder="Name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            hint="Matched against both name and email."
          />
          <Select
            label="Role"
            options={ROLE_OPTIONS}
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          />
        </div>
      </Card>

      {counts[UserStatus.DISABLED] ? (
        <Alert tone="muted" title={`${pluralize(counts[UserStatus.DISABLED], 'account')} disabled`}>
          A disabled account keeps every attendance record it earned — that is the point of disabling
          rather than deleting. It stays on subject rosters and in reports, and stops being able to
          sign in on its next request.
        </Alert>
      ) : null}

      {users.error && !users.data ? (
        <ErrorState error={users.error} onRetry={users.reload} title="Could not load the directory" />
      ) : (
        <Card
          flush
          title={users.data ? `${pluralize(users.data.count, 'person')}` : 'Loading…'}
          subtitle={
            users.data && users.data.count >= users.data.limit
              ? `Showing the first ${users.data.limit}. Narrow the filters to see the rest.`
              : undefined
          }
          footer={
            <p className="small muted">
              Three changes the server will refuse, and says so when it does: disabling your own
              account, disabling the person who created this institution, and disabling or demoting
              the last active administrator.
            </p>
          }
        >
          <Table
            columns={[
              {
                key: 'name',
                header: 'Person',
                render: (row) => (
                  <div className="row row-sm">
                    <span className="avatar" aria-hidden="true">
                      {initials(row.name)}
                    </span>
                    <div className="stack-sm">
                      <span className="strong">
                        {row.student ? (
                          <Link to={`/students/${row.student.id}`}>{row.name}</Link>
                        ) : (
                          row.name
                        )}
                        {row.id === myId ? <span className="faint"> · you</span> : null}
                      </span>
                      <span className="small muted">{row.email}</span>
                    </div>
                  </div>
                ),
              },
              {
                key: 'role',
                header: 'Role',
                nowrap: true,
                render: (row) => (
                  <Badge tone={ROLE_TONES[row.role] || 'muted'}>
                    {ROLE_LABELS[row.role] || row.role}
                  </Badge>
                ),
              },
              {
                key: 'status',
                header: 'Access',
                nowrap: true,
                render: (row) => (
                  <Badge tone={STATUS_TONES[row.status] || 'muted'}>
                    {STATUS_LABELS[row.status] || row.status}
                  </Badge>
                ),
              },
              {
                key: 'enrollment',
                header: 'Biometrics',
                nowrap: true,
                render: (row) => {
                  if (!row.student) return <span className="faint">n/a</span>;
                  const enrolled = [
                    row.student.face_enrolled ? 'face' : null,
                    row.student.voice_enrolled ? 'voice' : null,
                  ].filter(Boolean);
                  return (
                    <div className="row row-sm">
                      <Pill tone={row.student.face_enrolled ? 'success' : 'warn'}>
                        {enrolled.length
                          ? enrolled.join(' + ')
                          : ENROLLMENT_STATUS_LABELS[row.student.enrollment_status] || 'none'}
                      </Pill>
                      {row.student.roll_number ? (
                        <span className="small mono muted">{row.student.roll_number}</span>
                      ) : null}
                    </div>
                  );
                },
              },
              {
                key: 'last_login_at',
                header: 'Last signed in',
                align: 'right',
                nowrap: true,
                render: (row) =>
                  row.last_login_at ? (
                    <span title={formatDateTime(row.last_login_at)}>
                      {formatRelative(row.last_login_at)}
                    </span>
                  ) : (
                    <span className="faint">never</span>
                  ),
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                align: 'right',
                nowrap: true,
                render: (row) => {
                  const isSelf = row.id === myId;
                  const busy = busyId === row.id;
                  return (
                    <div className="row row-sm row-wrap row-end">
                      {row.status === UserStatus.INVITED ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy}
                            onClick={() => resend(row)}
                          >
                            Resend
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => openConfirm('revoke', row)}
                          >
                            Revoke
                          </Button>
                        </>
                      ) : null}

                      {row.status === UserStatus.DISABLED ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy}
                          onClick={() => openConfirm('enable', row)}
                        >
                          Enable
                        </Button>
                      ) : null}

                      {/* Self-disable and self-demotion are the two refusals the
                          client can predict, so the buttons are simply absent
                          rather than offered and rejected. */}
                      {row.status !== UserStatus.DISABLED && !isSelf ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => openConfirm('disable', row)}
                        >
                          Disable
                        </Button>
                      ) : null}

                      {row.role === Role.TEACHER ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => openConfirm('promote', row)}
                        >
                          Make admin
                        </Button>
                      ) : null}

                      {row.role === Role.ADMIN && !isSelf ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => openConfirm('demote', row)}
                        >
                          Make teacher
                        </Button>
                      ) : null}
                    </div>
                  );
                },
              },
            ]}
            rows={rows}
            rowKey="id"
            loading={users.loading}
            empty={
              <EmptyState
                title={query || role || status ? 'Nobody matches those filters' : 'Nobody here yet'}
                message={
                  query || role || status
                    ? 'Clear the search or widen the role and status filters.'
                    : 'Invite a teacher above, or import a class of students from the Students page.'
                }
              />
            }
          />
        </Card>
      )}

      <ActionDialog
        confirm={confirm}
        busy={Boolean(busyId)}
        reason={reason}
        onReason={setReason}
        onCancel={() => setConfirm(null)}
        onConfirm={runAction}
      />
    </>
  );
}

/**
 * One dialog for every row action, because they differ only in wording and in
 * whether a reason is offered. `resent` is not a confirmation at all — it is the
 * outcome of an action that already ran, shown here so the invitation link (on a
 * server with no mailer) has somewhere to live.
 */
function ActionDialog({ confirm, busy, reason, onReason, onCancel, onConfirm }) {
  if (!confirm) return null;
  const { kind, row } = confirm;

  if (kind === 'resent') {
    return (
      <Modal open title={`Invitation for ${row.name}`} onClose={onCancel}>
        <InviteResult result={confirm.result} />
      </Modal>
    );
  }

  const copy = {
    disable: {
      title: `Disable ${row.name}?`,
      message:
        'They stay on every roster and keep every attendance record. Their access ends on their next request — an already-issued access token stops working because the user loader rejects disabled accounts.',
      confirmLabel: 'Disable account',
      tone: 'danger',
    },
    enable: {
      title: `Enable ${row.name}?`,
      message:
        'They can sign in again with the password they already had. If they never set one, the account goes back to being invited and needs a fresh invitation.',
      confirmLabel: 'Enable account',
      tone: 'primary',
    },
    revoke: {
      title: 'Revoke this invitation?',
      message: `The placeholder account for ${row.email} is deleted along with the invitation, and the link that was emailed stops working. Inviting them again later creates a new account.`,
      confirmLabel: 'Revoke invitation',
      tone: 'danger',
    },
    promote: {
      title: `Make ${row.name} an administrator?`,
      message:
        'Administrators see every subject, every session and every student in the institution, can invite and disable people, and can read the audit log. There is no way for them to see less.',
      confirmLabel: 'Make administrator',
      tone: 'primary',
    },
    demote: {
      title: `Make ${row.name} a teacher?`,
      message:
        'They keep the subjects assigned to them and lose everything else — institution-wide reports, people, settings, the audit log and privacy controls.',
      confirmLabel: 'Make teacher',
      tone: 'primary',
    },
  }[kind];

  return (
    <ConfirmDialog
      open
      title={copy.title}
      message={copy.message}
      confirmLabel={copy.confirmLabel}
      tone={copy.tone}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {kind === 'disable' ? (
        <Textarea
          label="Reason"
          rows={2}
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          hint="Optional, but it is what the audit log will show next to your name in six months' time."
          placeholder="Left the institution"
        />
      ) : null}
    </ConfirmDialog>
  );
}

function InviteTeacherDialog({ open, onClose, onDone }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await AdminAPI.inviteTeacher({ name: name.trim(), email: email.trim() });
      setName('');
      setEmail('');
      onDone(result);
    } catch (error) {
      toast.notifyError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Invite a teacher"
      onClose={busy ? undefined : onClose}
      closeOnBackdrop={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="invite-teacher-form" loading={busy}>
            Send invitation
          </Button>
        </>
      }
    >
      <form id="invite-teacher-form" className="stack" onSubmit={submit}>
        {/* Staff have no self-signup path: this route and the institution's own
            registration are the only two ways a staff account comes into being. */}
        <p className="small muted">
          They set their own password from the link in the email. Nothing is created that you have to
          hand over — unless this server has no mail account, in which case the link appears here and
          only here.
        </p>
        <Input
          label="Full name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
        <Input
          label="Email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          hint="Must not already have an account here. If it does, its outstanding invitation is replaced rather than a second account created."
        />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------------- */
/* Invitations                                                                */
/* ------------------------------------------------------------------------- */

function InvitesPanel({ refresh }) {
  const [status, setStatus] = useState(InviteStatus.PENDING);
  const lapsedOnly = status === EXPIRED_FILTER;
  // `EXPIRED_FILTER` is not a status the server knows, so it asks for the pending
  // set and the narrowing happens below.
  const params = useMemo(
    () => ({ status: lapsedOnly ? InviteStatus.PENDING : status, limit: 500 }),
    [lapsedOnly, status],
  );
  const invites = useResource(() => AdminAPI.invites(params), [params, refresh]);
  const fetched = (invites.data && invites.data.invites) || [];

  const expired = fetched.filter(hasLapsed);
  const rows = lapsedOnly ? expired : fetched;

  return (
    <>
      <Card
        title="Invitations"
        subtitle="Newest first. One row per invitation issued, including ones that were replaced by a resend."
      >
        <div className="grid grid-3">
          <Select
            label="Show"
            options={INVITE_STATUS_OPTIONS}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          />
        </div>
      </Card>

      {/* Suppressed while the filter is already showing exactly these rows —
          there it would only count the table underneath it. */}
      {expired.length && !lapsedOnly ? (
        <Alert
          tone="warn"
          title={`${pluralize(expired.length, 'invitation')} has passed its expiry`}
          actions={
            <Button size="sm" variant="secondary" onClick={() => setStatus(EXPIRED_FILTER)}>
              Show them
            </Button>
          }
        >
          Still marked pending because nothing sweeps them — the link is simply rejected when it is
          used. Resend from the people list to issue a working one.
        </Alert>
      ) : null}

      {invites.error && !invites.data ? (
        <ErrorState
          error={invites.error}
          onRetry={invites.reload}
          title="Could not load invitations"
        />
      ) : (
        <Card flush>
          <Table
            columns={[
              { key: 'email', header: 'Email', render: (row) => <span className="strong">{row.email}</span> },
              {
                key: 'invite_type',
                header: 'For',
                nowrap: true,
                render: (row) => (
                  <Pill tone={row.invite_type === 'teacher' ? 'info' : 'muted'}>
                    {row.invite_type === 'teacher' ? 'Teacher' : 'Student'}
                  </Pill>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                nowrap: true,
                render: (row) => (
                  <Badge tone={INVITE_TONES[row.status] || 'muted'}>{row.status}</Badge>
                ),
              },
              {
                key: 'sent_count',
                header: 'Sent',
                align: 'right',
                nowrap: true,
                // A high count is the signature of an invitation nobody is acting on.
                render: (row) =>
                  row.sent_count > 1 ? (
                    <Badge tone="warn">{row.sent_count}×</Badge>
                  ) : (
                    <span className="mono">{row.sent_count || 1}×</span>
                  ),
              },
              {
                key: 'created_at',
                header: 'Issued',
                align: 'right',
                nowrap: true,
                render: (row) => (
                  <span title={formatDateTime(row.created_at)}>{formatRelative(row.created_at)}</span>
                ),
              },
              {
                key: 'expires_at',
                header: 'Expires',
                align: 'right',
                nowrap: true,
                render: (row) => {
                  if (row.status === InviteStatus.ACCEPTED) {
                    return row.accepted_at ? (
                      <span className="faint" title={formatDateTime(row.accepted_at)}>
                        accepted {formatRelative(row.accepted_at)}
                      </span>
                    ) : (
                      <span className="faint">accepted</span>
                    );
                  }
                  if (!row.expires_at) return null;
                  const gone = new Date(row.expires_at) < new Date();
                  return (
                    <span className={gone ? 'strong' : undefined} title={formatDateTime(row.expires_at)}>
                      {gone ? 'expired ' : ''}
                      {formatRelative(row.expires_at)}
                    </span>
                  );
                },
              },
            ]}
            rows={rows}
            rowKey="id"
            loading={invites.loading}
            empty={
              <EmptyState
                title={
                  lapsedOnly
                    ? 'Every outstanding invitation is still valid'
                    : status === InviteStatus.PENDING
                      ? 'No invitation is outstanding'
                      : 'No invitation matches that filter'
                }
                message={
                  lapsedOnly
                    ? 'Nobody is holding a link that would be rejected. Invitations last a week from the day they are sent.'
                    : status === InviteStatus.PENDING
                      ? 'Everyone who was invited has either accepted or had their invitation revoked.'
                      : 'Change the filter above to see other invitations.'
                }
              />
            }
          />
        </Card>
      )}
    </>
  );
}
