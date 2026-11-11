import { Link } from 'react-router-dom';

import BarList from '../../components/charts/BarList.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Pill,
  StatGrid,
  StatTile,
  Table,
} from '../../components/ui/index.js';
import { AnalyticsAPI, SessionsAPI } from '../../lib/api.js';
import { SessionStatus } from '../../lib/constants.js';
import {
  attendanceTone,
  formatNumber,
  formatPercent,
  formatRelative,
  pluralize,
} from '../../lib/format.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
import { useAuth } from '../../context/AuthContext.jsx';

/** Enough to see the shape of the problem without turning the page into a report. */
const DEFAULTER_PREVIEW = 8;

/**
 * The teacher's home screen.
 *
 * Ordered by what is time-critical rather than by what is interesting: a session
 * that is open right now is at the top, because leaving one open is how a class
 * ends up half-marked. Everything below it is a summary with a link to the page
 * that can actually change it.
 *
 * An admin lands here too (the route allows both roles), and
 * `GET /api/analytics/overview` answers with the *institution* shape for them —
 * no per-subject cards. Both shapes are handled rather than assumed.
 */
export default function TeacherDashboard() {
  const { user, isAdmin } = useAuth();
  useDocumentTitle('Dashboard');

  const overview = useResource(() => AnalyticsAPI.overview(), []);
  const active = useResource(() => SessionsAPI.list({ status: SessionStatus.ACTIVE }), []);
  const defaulters = useResource(() => AnalyticsAPI.defaulters(), []);

  const data = overview.data || null;
  // The teacher overview carries `subjects`; the institution one does not.
  const cards = data && Array.isArray(data.subjects) ? data.subjects : null;

  // `status=active` returns scheduled sessions too. Only the ones whose window is
  // still open need attention now.
  const openNow = ((active.data && active.data.sessions) || []).filter(
    (session) => session.is_open,
  );
  const scheduled = ((active.data && active.data.sessions) || []).filter(
    (session) => !session.is_open,
  );
  const defaulterRows = (defaulters.data && defaulters.data.defaulters) || [];

  const firstName = String((user && user.name) || '').trim().split(/\s+/)[0];

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">{firstName ? `Hello, ${firstName}` : 'Dashboard'}</h1>
          <p className="page-sub">
            {cards
              ? `${pluralize(cards.length, 'subject')} you teach, and what attendance looks like across them.`
              : 'Sessions in progress and students below the attendance requirement.'}
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-primary" to="/sessions">
            Open a session
          </Link>
        </div>
      </div>

      {isAdmin && !cards ? (
        <Alert
          tone="info"
          title="You are signed in as an administrator"
          actions={
            <Link className="btn btn-secondary btn-sm" to="/admin">
              Admin dashboard
            </Link>
          }
        >
          Institution-wide figures, users and privacy controls live on the admin dashboard. This page
          shows what is happening right now and who is falling behind.
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Open right now                                                      */}
      {/* ------------------------------------------------------------------ */}
      {active.error && !active.data ? (
        <ErrorState error={active.error} onRetry={active.reload} title="Could not load sessions" />
      ) : active.loading && !active.data ? (
        <LoadingBlock label="Checking for open sessions…" />
      ) : openNow.length ? (
        <Card
          title={`${pluralize(openNow.length, 'session')} open now`}
          subtitle="Self-service check-in is live. End the session when class finishes so the register stops moving."
          actions={
            <Button variant="ghost" size="sm" onClick={active.reload} loading={active.loading}>
              Refresh
            </Button>
          }
        >
          <div className="stack">
            {openNow.map((session) => (
              <div className="row row-wrap between" key={session.id}>
                <div className="stack-sm">
                  <span className="strong">
                    {session.title || (session.subject && session.subject.name) || 'Session'}
                  </span>
                  <span className="small muted">
                    {session.subject ? `${session.subject.code} · ` : ''}
                    started {formatRelative(session.start_time)}
                    {session.end_time ? ` · window closes ${formatRelative(session.end_time)}` : ''}
                  </span>
                </div>
                <div className="row row-sm">
                  <Pill>{session.mode_label}</Pill>
                  <Badge tone="info">
                    {session.present_count || 0} / {session.roster_size || 0} present
                  </Badge>
                  <Link className="btn btn-primary btn-sm" to={`/sessions/${session.id}`}>
                    Go live
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card title="Nothing is open right now">
          <EmptyState
            title="No session in progress"
            message="Open one as class begins — the QR code and the class-photo upload both live on the session console."
            action={
              <Link className="btn btn-primary" to="/sessions">
                Open a session
              </Link>
            }
          />
        </Card>
      )}

      {scheduled.length ? (
        <Alert tone="muted" title={`${pluralize(scheduled.length, 'session')} scheduled but not open`}>
          Their windows have not started, or have already closed without the session being ended. A
          closed window stops students checking themselves in; the register stays editable until you
          end the session.
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Summary                                                             */}
      {/* ------------------------------------------------------------------ */}
      {overview.error && !overview.data ? (
        <ErrorState error={overview.error} onRetry={overview.reload} title="Could not load your summary" />
      ) : overview.loading && !overview.data ? (
        <LoadingBlock label="Loading your summary…" />
      ) : cards ? (
        <>
          <StatGrid>
            <StatTile label="Subjects" value={formatNumber(cards.length)} tone="info" />
            <StatTile
              label="Sessions held"
              value={formatNumber(data.sessions_total)}
              tone="muted"
              meta="across every subject you teach"
            />
            <StatTile
              label="Average attendance"
              value={formatPercent(data.average_attendance)}
              // No single threshold applies across subjects that may each set their
              // own, so this tile stays neutral rather than picking one to judge by.
              tone="primary"
              meta="mean of your subject averages"
            />
            <StatTile
              label="Below requirement"
              value={formatNumber(
                cards.reduce((sum, card) => sum + (Number(card.defaulter_count) || 0), 0),
              )}
              tone={cards.some((card) => card.defaulter_count) ? 'warn' : 'success'}
              meta="student–subject pairs"
            />
          </StatGrid>

          <div className="grid grid-2">
            <Card
              title="Attendance by subject"
              subtitle="Each subject's average against its own requirement."
            >
              <BarList
                items={cards.map((card) => ({
                  key: card.subject_id,
                  label: `${card.code} · ${card.name}`,
                  value: card.average_attendance,
                  display: formatPercent(card.average_attendance, { digits: 0 }),
                  tone: attendanceTone(card.average_attendance, card.threshold),
                }))}
              />
            </Card>

            <Card
              flush
              title="Your subjects"
              subtitle="Open one to manage its roster or read its report."
            >
              <Table
                compact
                columns={[
                  {
                    key: 'name',
                    header: 'Subject',
                    render: (card) => (
                      <Link className="strong" to={`/subjects/${card.subject_id}`}>
                        <span className="mono">{card.code}</span> {card.name}
                      </Link>
                    ),
                  },
                  {
                    key: 'roster_size',
                    header: 'Students',
                    align: 'right',
                    nowrap: true,
                    render: (card) => formatNumber(card.roster_size),
                  },
                  {
                    key: 'sessions_total',
                    header: 'Sessions',
                    align: 'right',
                    nowrap: true,
                    render: (card) => formatNumber(card.sessions_total),
                  },
                  {
                    key: 'average_attendance',
                    header: 'Average',
                    align: 'right',
                    nowrap: true,
                    render: (card) => (
                      <Badge tone={attendanceTone(card.average_attendance, card.threshold)}>
                        {formatPercent(card.average_attendance, { digits: 0 })}
                      </Badge>
                    ),
                  },
                  {
                    key: 'defaulter_count',
                    header: 'Below',
                    align: 'right',
                    nowrap: true,
                    render: (card) =>
                      card.defaulter_count ? (
                        <Badge tone="danger">{card.defaulter_count}</Badge>
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                ]}
                rows={cards}
                rowKey="subject_id"
                empty={
                  <EmptyState
                    title="No subjects assigned to you"
                    message="An admin assigns subjects to teachers. Ask for one, or create your own."
                    action={
                      <Link className="btn btn-primary btn-sm" to="/subjects">
                        Go to Subjects
                      </Link>
                    }
                  />
                }
              />
            </Card>
          </div>
        </>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Needs attention                                                     */}
      {/* ------------------------------------------------------------------ */}
      {defaulters.error && !defaulters.data ? (
        <ErrorState
          error={defaulters.error}
          onRetry={defaulters.reload}
          title="Could not load defaulters"
        />
      ) : defaulters.loading && !defaulters.data ? (
        <LoadingBlock label="Finding students who are falling behind…" />
      ) : (
        <Card
          flush
          title="Needs attention"
          subtitle={
            defaulters.data
              ? `Below the requirement after at least ${pluralize(defaulters.data.min_sessions, 'session')}. Worst first.`
              : undefined
          }
          actions={
            <Link className="btn btn-secondary btn-sm" to="/reports">
              Full report
            </Link>
          }
          footer={
            defaulterRows.length > DEFAULTER_PREVIEW ? (
              <div className="row between">
                <span className="small muted">
                  Showing {DEFAULTER_PREVIEW} of {formatNumber(defaulterRows.length)}.
                </span>
                <Link className="btn btn-ghost btn-sm" to="/reports">
                  See all
                </Link>
              </div>
            ) : null
          }
        >
          <Table
            compact
            columns={[
              {
                key: 'name',
                header: 'Student',
                render: (row) => (
                  <Link className="strong" to={`/students/${row.student_id}`}>
                    {row.name}
                  </Link>
                ),
              },
              {
                key: 'subject_name',
                header: 'Subject',
                render: (row) => (
                  <Link to={`/subjects/${row.subject_id}`}>
                    <span className="mono">{row.subject_code}</span>
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
                // The number that answers "how many more classes?" better than the
                // percentage does — it is the gap to close, not the score.
                render: (row) => <span className="mono">{formatPercent(row.shortfall)}</span>,
              },
            ]}
            rows={defaulterRows.slice(0, DEFAULTER_PREVIEW)}
            rowKey={(row) => `${row.student_id}-${row.subject_id}`}
            empty={
              <EmptyState
                title="Nobody is below the requirement"
                message="Either attendance is healthy, or no subject has enough sessions yet to judge."
              />
            }
          />
        </Card>
      )}
    </div>
  );
}
