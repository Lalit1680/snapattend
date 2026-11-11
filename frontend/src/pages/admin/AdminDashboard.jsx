import { Link } from 'react-router-dom';

import BarList from '../../components/charts/BarList.jsx';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Pill,
  ProgressBar,
  StatGrid,
  StatTile,
  Table,
} from '../../components/ui/index.js';
import { AdminAPI, AnalyticsAPI, SessionsAPI } from '../../lib/api.js';
import { SessionStatus } from '../../lib/constants.js';
import {
  attendanceTone,
  formatDate,
  formatNumber,
  formatPercent,
  formatRelative,
  pluralize,
} from '../../lib/format.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';

/**
 * The administrator's landing page.
 *
 * Two things sit above the numbers because they stop the system working rather
 * than merely looking bad: mail that is not configured (every invitation and
 * reset link then has to be copied by hand out of a dialog nobody saw) and
 * students who never enrolled a face (a class photo cannot find them, and they
 * are marked absent while sitting in the room).
 */
export default function AdminDashboard() {
  useDocumentTitle('Admin');

  const overview = useResource(() => AnalyticsAPI.overview(), []);
  const institution = useResource(() => AdminAPI.institution(), []);
  const active = useResource(() => SessionsAPI.list({ status: SessionStatus.ACTIVE }), []);

  const data = overview.data || null;
  const mail = (institution.data && institution.data.mail) || null;
  const counts = (institution.data && institution.data.counts) || null;
  const org = (institution.data && institution.data.institution) || null;
  const openNow = ((active.data && active.data.sessions) || []).filter(
    (session) => session.is_open,
  );

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">{org ? org.name : 'Administration'}</h1>
          <p className="page-sub">
            {org ? (
              <>
                <span className="mono">{org.slug}</span>
                {org.created_at ? ` · since ${formatDate(org.created_at)}` : ''}
              </>
            ) : (
              'Institution-wide figures, people and retention.'
            )}
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-secondary" to="/admin/settings">
            Settings
          </Link>
          <Link className="btn btn-primary" to="/admin/users">
            People
          </Link>
        </div>
      </div>

      {/* Not a warning about a preference — an unconfigured mailer means nobody
          can be invited or reset a password without an admin hand-carrying a
          link, and the link is shown once. */}
      {mail && !mail.configured ? (
        <Alert
          tone="danger"
          title="No mail account is configured"
          actions={
            <Link className="btn btn-secondary btn-sm" to="/admin/settings">
              See mail settings
            </Link>
          }
        >
          Invitations and password resets are created but never delivered. The link appears once, in
          the dialog that created it, and has to be passed on by hand — so inviting a class of sixty
          this way is not realistic. Set <span className="mono">MAIL_SERVER</span> and its companions
          in the server's <span className="mono">.env</span>, then restart it.
        </Alert>
      ) : null}

      {mail && mail.configured && mail.suppressed ? (
        <Alert tone="warn" title="Mail is configured but suppressed">
          <span className="mono">MAIL_SUPPRESS_SEND</span> is on, so messages are composed and
          dropped. That is the right setting for a demo and the wrong one for real users.
        </Alert>
      ) : null}

      {overview.error && !overview.data ? (
        <ErrorState error={overview.error} onRetry={overview.reload} title="Could not load the overview" />
      ) : overview.loading && !overview.data ? (
        <LoadingBlock label="Loading institution figures…" />
      ) : data ? (
        <>
          <StatGrid>
            <StatTile
              label="Students"
              value={formatNumber(data.students_total)}
              tone="info"
              meta={
                data.pending_invites
                  ? `${formatNumber(data.pending_invites)} never signed in`
                  : 'all accounts activated'
              }
            />
            <StatTile
              label="Teachers"
              value={formatNumber(data.teachers_total)}
              tone="muted"
              meta={counts ? `${pluralize(counts.admins, 'administrator')}` : undefined}
            />
            <StatTile
              label="Subjects"
              value={formatNumber(data.subjects_total)}
              tone="muted"
              meta={`${pluralize(data.sessions_total, 'session')} held`}
            />
            <StatTile
              label="Overall attendance"
              value={formatPercent(data.overall_attendance)}
              tone={attendanceTone(data.overall_attendance, data.threshold)}
              meta={`requirement ${data.threshold}%`}
            />
          </StatGrid>

          <div className="grid grid-2">
            <Card
              title="Biometric enrollment"
              subtitle="Face-photo attendance can only mark students who have enrolled. Only the student can do it, from their own device."
              footer={
                <Link className="btn btn-secondary btn-sm" to="/reports">
                  Coverage by subject
                </Link>
              }
            >
              <div className="stack">
                <ProgressBar
                  value={data.enrollment_completion}
                  tone={
                    data.enrollment_completion >= 100
                      ? 'success'
                      : data.enrollment_completion >= 75
                        ? 'warn'
                        : 'danger'
                  }
                  label={`${formatNumber(data.face_enrolled)} of ${formatNumber(data.students_total)} have a face on file`}
                  showValue
                />
                <BarList
                  items={[
                    { key: 'face', label: 'Face enrolled', value: data.face_enrolled, tone: 'success' },
                    { key: 'voice', label: 'Voice enrolled', value: data.voice_enrolled, tone: 'info' },
                    {
                      key: 'none',
                      label: 'No face yet',
                      value: Math.max(0, data.students_total - data.face_enrolled),
                      tone: 'danger',
                    },
                  ]}
                />
                {/* Voice is optional by design — a session only needs it when the
                    teacher opens one in voice mode — so a low count here is a fact,
                    not a fault. */}
                <p className="small muted">
                  Voice is only needed for sessions opened in voice mode, so a low voice count is not
                  itself a problem.
                </p>
              </div>
            </Card>

            <Card
              title="Recorded attendance"
              subtitle="Every present record ever written for this institution."
            >
              <div className="stack">
                <StatGrid>
                  <StatTile
                    label="Present records"
                    value={formatNumber(data.attendance_records)}
                    tone="primary"
                  />
                  <StatTile
                    label="Sessions counted"
                    value={formatNumber(data.sessions_total)}
                    tone="muted"
                    meta="empty ones excluded"
                  />
                </StatGrid>
                <div className="divider" />
                <div className="row row-wrap row-sm">
                  <Link className="btn btn-secondary btn-sm" to="/reports">
                    Reports
                  </Link>
                  <Link className="btn btn-secondary btn-sm" to="/admin/audit">
                    Audit log
                  </Link>
                  <Link className="btn btn-secondary btn-sm" to="/admin/privacy">
                    Privacy
                  </Link>
                </div>
                <p className="small muted">
                  Figures generated {formatRelative(data.generated_at)}.
                </p>
              </div>
            </Card>
          </div>
        </>
      ) : null}

      {institution.error && !institution.data ? (
        <ErrorState
          error={institution.error}
          onRetry={institution.reload}
          title="Could not load institution settings"
        />
      ) : null}

      <Card
        flush
        title={data && data.active_sessions ? `${pluralize(openNow.length, 'session')} open now` : 'Live now'}
        subtitle="Sessions with the check-in window still open."
        actions={
          <Link className="btn btn-secondary btn-sm" to="/sessions">
            All sessions
          </Link>
        }
      >
        <Table
          compact
          columns={[
            {
              key: 'title',
              header: 'Session',
              render: (session) => (
                <Link className="strong" to={`/sessions/${session.id}`}>
                  {session.title || (session.subject && session.subject.name) || 'Session'}
                </Link>
              ),
            },
            {
              key: 'subject',
              header: 'Subject',
              nowrap: true,
              render: (session) =>
                session.subject ? <span className="mono">{session.subject.code}</span> : null,
            },
            {
              key: 'mode_label',
              header: 'Mode',
              nowrap: true,
              render: (session) => <Pill>{session.mode_label}</Pill>,
            },
            {
              key: 'present_count',
              header: 'Present',
              align: 'right',
              nowrap: true,
              render: (session) => (
                <Badge tone="info">
                  {session.present_count || 0} / {session.roster_size || 0}
                </Badge>
              ),
            },
            {
              key: 'start_time',
              header: 'Started',
              align: 'right',
              nowrap: true,
              render: (session) => formatRelative(session.start_time),
            },
          ]}
          rows={openNow}
          rowKey="id"
          loading={active.loading}
          empty={
            <EmptyState
              title="Nothing is live"
              message="Teachers open sessions from their own dashboard; this is a read-only view of what is running."
            />
          }
        />
      </Card>

      {counts && counts.pending_invites ? (
        <Alert
          tone="warn"
          title={`${pluralize(counts.pending_invites, 'invitation')} still outstanding`}
          actions={
            <Link className="btn btn-secondary btn-sm" to="/admin/users">
              Review invitations
            </Link>
          }
        >
          These accounts exist but have never been used. An invitation expires, and a student who
          never accepted theirs cannot enroll a face or check themselves in — they will show as absent
          in every session until they do.
        </Alert>
      ) : null}
    </div>
  );
}
