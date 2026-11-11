import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

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
  Pill,
  StatGrid,
  StatTile,
  Table,
} from '../../components/ui/index.js';
import { AdminAPI } from '../../lib/api.js';
import {
  attendanceTone,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelative,
  pluralize,
} from '../../lib/format.js';
import useAsync from '../../hooks/useAsync.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';

/** `_SETTING_VALIDATORS` in `routes/admin.py` clamps this; matching it here means
 *  the number that gets rejected is the one the field would not accept. */
const COOLDOWN_MIN = 1;
const COOLDOWN_MAX = 90;

/** The built-in fallback when neither the subject nor the institution sets one. */
const BUILT_IN_THRESHOLD = 75;

export default function SettingsPage() {
  useDocumentTitle('Settings');

  const institution = useResource(() => AdminAPI.institution(), []);
  const data = institution.data || null;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            What this institution is called, what counts as enough attendance, and who gets warned.
          </p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={institution.reload} loading={institution.loading}>
            Reload
          </Button>
        </div>
      </div>

      {institution.error && !institution.data ? (
        <ErrorState
          error={institution.error}
          onRetry={institution.reload}
          title="Could not load settings"
        />
      ) : institution.loading && !institution.data ? (
        <LoadingBlock label="Loading settings…" />
      ) : data ? (
        <>
          <IdentityCard
            institution={data.institution}
            counts={data.counts}
            onSaved={institution.reload}
          />
          <AttendanceCard institution={data.institution} onSaved={institution.reload} />
          <MailCard mail={data.mail} />
          <AlertRunner
            settings={data.institution.settings || {}}
            mailConfigured={Boolean(data.mail && data.mail.configured)}
          />
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Identity                                                                   */
/* ------------------------------------------------------------------------- */

function IdentityCard({ institution, counts, onSaved }) {
  const toast = useToast();
  const { refreshUser } = useAuth();
  const [name, setName] = useState(institution.name || '');

  // A reload after saving replaces the object this card was built from.
  useEffect(() => {
    setName(institution.name || '');
  }, [institution.name]);

  const save = useAsync(() => AdminAPI.updateInstitution({ name: name.trim() }), {
    onSuccess: () => {
      toast.success('Renamed.');
      // The name is baked into the signed-in user's context and shown in the
      // sidebar, so the session has to be re-read or the header stays stale.
      refreshUser();
      onSaved();
    },
    onError: (error) => toast.notifyError(error),
  });

  const submit = (event) => {
    event.preventDefault();
    if (name.trim() === (institution.name || '')) {
      toast.info('That is already the name.');
      return;
    }
    save.run();
  };

  return (
    <Card
      title="Institution"
      subtitle="The name appears in every email this system sends."
      footer={
        <Button type="submit" form="institution-form" loading={save.loading}>
          Save name
        </Button>
      }
    >
      <form id="institution-form" className="stack" onSubmit={submit}>
        <div className="grid grid-2">
          <Input
            label="Name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="Used in invitations, password resets and low-attendance warnings."
          />
          <Input
            label="Identifier"
            value={institution.slug || ''}
            readOnly
            // Not a disabled field with a shrug: it is deliberately fixed, and the
            // reason is worth reading before somebody asks for it to be editable.
            hint="Fixed for good. It is embedded in invitation links that are already sitting in people's inboxes, and changing it would break them silently."
          />
        </div>

        {counts ? (
          <StatGrid>
            <StatTile label="Administrators" value={formatNumber(counts.admins)} tone="primary" />
            <StatTile label="Teachers" value={formatNumber(counts.teachers)} tone="info" />
            <StatTile label="Students" value={formatNumber(counts.students)} tone="muted" />
            <StatTile
              label="Subjects"
              value={formatNumber(counts.subjects)}
              tone="muted"
              meta="archived ones excluded"
            />
          </StatGrid>
        ) : null}

        <p className="small muted">
          Created {institution.created_at ? formatDate(institution.created_at) : 'unknown'}.
        </p>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------------- */
/* Attendance requirement and alerts                                          */
/* ------------------------------------------------------------------------- */

function AttendanceCard({ institution, onSaved }) {
  const toast = useToast();
  const settings = institution.settings || {};

  const currentThreshold =
    settings.attendance_threshold === undefined || settings.attendance_threshold === null
      ? ''
      : String(settings.attendance_threshold);
  const currentEnabled = settings.low_attendance_alerts_enabled !== false;
  const currentCooldown = String(settings.alert_cooldown_days || 7);

  const [threshold, setThreshold] = useState(currentThreshold);
  const [enabled, setEnabled] = useState(currentEnabled);
  const [cooldown, setCooldown] = useState(currentCooldown);

  useEffect(() => {
    setThreshold(currentThreshold);
    setEnabled(currentEnabled);
    setCooldown(currentCooldown);
  }, [currentThreshold, currentEnabled, currentCooldown]);

  const save = useAsync((settingsPatch) => AdminAPI.updateInstitution({ settings: settingsPatch }), {
    onSuccess: () => {
      toast.success('Saved. Every report is judged against the new figures from now on.');
      onSaved();
    },
    onError: (error) => toast.notifyError(error),
  });

  const submit = (event) => {
    event.preventDefault();
    const next = {};

    if (threshold.trim() !== currentThreshold) {
      const parsed = Number(threshold);
      if (threshold.trim() === '') {
        toast.warn('Leave a number here, or the requirement cannot be judged. 75 is the default.');
        return;
      }
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        toast.warn('The requirement has to be a percentage between 0 and 100.');
        return;
      }
      next.attendance_threshold = parsed;
    }
    if (enabled !== currentEnabled) next.low_attendance_alerts_enabled = enabled;
    if (cooldown !== currentCooldown) {
      const days = Number(cooldown);
      if (!Number.isFinite(days) || days < COOLDOWN_MIN || days > COOLDOWN_MAX) {
        toast.warn(`The cooldown has to be between ${COOLDOWN_MIN} and ${COOLDOWN_MAX} days.`);
        return;
      }
      next.alert_cooldown_days = days;
    }

    // `PATCH /api/admin/institution` answers 400 "Nothing to update" on an empty
    // body, which is the right thing for an API and the wrong thing to show
    // somebody who pressed Save without changing anything.
    if (!Object.keys(next).length) {
      toast.info('Nothing has changed.');
      return;
    }
    save.run(next);
  };

  const unset = threshold.trim() === '';
  const effective = unset ? BUILT_IN_THRESHOLD : Number(threshold);

  return (
    <Card
      title="Attendance requirement"
      subtitle="The figure every report judges against, unless a subject sets its own."
      footer={
        <div className="row between row-wrap">
          <span className="small muted">
            Changing this re-judges every report immediately, including past terms. No attendance
            record is altered — only the line that decides who is short.
          </span>
          <Button type="submit" form="attendance-form" loading={save.loading}>
            Save
          </Button>
        </div>
      }
    >
      <form id="attendance-form" className="stack" onSubmit={submit}>
        <div className="grid grid-2">
          <Input
            label="Minimum attendance"
            type="number"
            min={0}
            max={100}
            step="0.5"
            required
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            hint={`Percent. A subject with its own requirement ignores this; a subject without one uses it. With neither, the built-in ${BUILT_IN_THRESHOLD}% applies.`}
          />
          <div className="stack-sm">
            <span className="small muted">In force for a subject that sets no figure of its own</span>
            <div className="row row-sm">
              <Badge tone="info">{formatPercent(effective, { digits: 0 })}</Badge>
              {unset ? <Pill tone="warn">built-in default</Pill> : null}
            </div>
            <span className="small faint">
              Anyone below this counts as short and appears in the defaulter report. It is the line
              the report draws, not a rule that blocks anything.
            </span>
          </div>
        </div>

        <div className="divider" />

        <div className="stack">
          <Checkbox
            label="Email students who fall below the requirement"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            hint="On for a new institution. Turned off, the check below stops before it looks — it does not compute a list and hold it back, so there is nothing to review either."
          />
          <div className="grid grid-2">
            <Input
              label="Wait between warnings"
              type="number"
              min={COOLDOWN_MIN}
              max={COOLDOWN_MAX}
              value={cooldown}
              onChange={(event) => setCooldown(event.target.value)}
              disabled={!enabled}
              hint={`Days. A student is not warned about the same subject again until this has passed — without it a nightly run would email them every night until they attend. ${COOLDOWN_MIN}–${COOLDOWN_MAX}.`}
            />
          </div>
        </div>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------------- */
/* Mail                                                                       */
/* ------------------------------------------------------------------------- */

function MailCard({ mail }) {
  if (!mail) return null;

  return (
    <Card
      title="Email delivery"
      subtitle="Read from the server's environment. Changing it means editing .env and restarting the server — it is not a setting this page can write."
    >
      <div className="stack">
        {mail.configured ? (
          <Alert tone="success" title="Mail is working">
            Invitations, password resets and low-attendance warnings are delivered by the server.
          </Alert>
        ) : mail.suppressed ? (
          <Alert tone="warn" title="Delivery is suppressed">
            <span className="mono">MAIL_SUPPRESS_SEND</span> is on. Messages are composed and thrown
            away — which is what you want in a demo and not what you want with real students.
          </Alert>
        ) : (
          <Alert tone="danger" title="No mail account is configured">
            Nothing is delivered. Invitation and reset links are handed back in the response instead,
            shown once, and have to be passed on by hand. Set <span className="mono">MAIL_USERNAME</span>{' '}
            and its companions in the server's <span className="mono">.env</span>.
          </Alert>
        )}

        <div className="kv">
          <span className="kv-key">Server</span>
          <span className="kv-value mono">
            {mail.server || '—'}
            {mail.port ? `:${mail.port}` : ''}
          </span>
          <span className="kv-key">From</span>
          <span className="kv-value mono">{mail.sender || '—'}</span>
          <span className="kv-key">Waiting to go out</span>
          <span className="kv-value">
            {mail.queued ? (
              <Badge tone="info">{pluralize(mail.queued, 'message')}</Badge>
            ) : (
              <span className="faint">nothing queued</span>
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------------- */
/* Low-attendance alert runner                                                */
/* ------------------------------------------------------------------------- */

/**
 * Run the low-attendance check by hand.
 *
 * Always a dry run first. The server defaults `dry_run` to true for the same
 * reason: the button says "check", and a check that emails fifty students before
 * showing anyone the list is not a check. The real send is a second, separate
 * decision made against the list that was actually produced.
 */
function AlertRunner({ settings, mailConfigured }) {
  const toast = useToast();
  const [result, setResult] = useState(null);
  const [live, setLive] = useState(false);

  const history = useResource(() => AdminAPI.alerts({ limit: 50 }), []);

  const check = useAsync(() => AdminAPI.runAlerts({ dry_run: true }), {
    onSuccess: (data) => {
      setResult(data);
      setLive(false);
    },
    onError: (error) => toast.notifyError(error),
  });

  const send = useAsync(() => AdminAPI.runAlerts({ dry_run: false }), {
    onSuccess: (data) => {
      setResult(data);
      setLive(true);
      const count = (data.sent || []).length;
      if (count) {
        toast.success(`${pluralize(count, 'email')} queued.`);
      } else {
        toast.info('Nobody needed warning.');
      }
      history.reload();
    },
    onError: (error) => toast.notifyError(error),
  });

  const enabled = settings.low_attendance_alerts_enabled !== false;
  const sent = (result && result.sent) || [];
  const skipped = (result && result.skipped) || [];
  const rows = (history.data && history.data.alerts) || [];

  return (
    <>
      <Card
        title="Low-attendance warnings"
        subtitle="The same check the nightly script runs, on demand, so you can see the list before anyone is emailed."
        actions={
          <Button variant="secondary" size="sm" onClick={() => check.run()} loading={check.loading}>
            Check who is short
          </Button>
        }
        footer={
          result && result.dry_run && sent.length > 0 ? (
            <div className="row between row-wrap">
              <span className="small muted">
                {mailConfigured
                  ? `Nothing has been sent yet. Sending starts the ${pluralize(result.cooldown_days, 'day')} cooldown for each of these students.`
                  : 'This server cannot send mail, so a real run would record the warnings as sent and deliver nothing.'}
              </span>
              <Button
                variant="danger"
                onClick={() => send.run()}
                loading={send.loading}
                disabled={!mailConfigured}
                // A real run writes an alert_log row per student whether or not the
                // mail leaves the building, and that row is what suppresses the next
                // warning. With no mailer, sending burns the cooldown silently.
                title={
                  mailConfigured
                    ? undefined
                    : 'Configure mail first — otherwise the cooldown is spent on emails nobody receives.'
                }
              >
                Send {pluralize(sent.length, 'email')}
              </Button>
            </div>
          ) : null
        }
      >
        <div className="stack">
          {!enabled ? (
            <Alert tone="warn" title="Warnings are turned off">
              The check returns nothing while the setting above is off — it does not compute a list and
              hold it back, it stops before looking. Turn it on to use this.
            </Alert>
          ) : null}

          {result && result.disabled ? (
            <Alert tone="warn" title="The server stopped before looking">
              {result.message}
            </Alert>
          ) : null}

          {result && result.error ? (
            <Alert tone="danger" title="The check could not run">
              The server answered <span className="mono">{result.error}</span>.
            </Alert>
          ) : null}

          {result && !result.disabled && !result.error ? (
            <>
              <StatGrid>
                <StatTile
                  label="Below the requirement"
                  value={formatNumber(result.candidates)}
                  tone={result.candidates ? 'warn' : 'success'}
                  meta={`after at least ${pluralize(result.min_sessions, 'session')}`}
                />
                <StatTile
                  label={live ? 'Emailed' : 'Would be emailed'}
                  value={formatNumber(sent.length)}
                  tone={sent.length ? 'info' : 'muted'}
                />
                <StatTile
                  label="Held back"
                  value={formatNumber(skipped.length)}
                  tone="muted"
                  meta="cooldown, no email, or inactive"
                />
              </StatGrid>

              {sent.length ? (
                <div className="stack-sm">
                  <h3 className="section-title">
                    {live ? 'Emailed just now' : 'Would be emailed'}
                  </h3>
                  <Table
                    compact
                    columns={[
                      // The row carries an address, not a name — this is the list
                      // of who would be written to, so the address is the fact
                      // that matters.
                      { key: 'email', header: 'Email' },
                      { key: 'subject', header: 'Subject' },
                      {
                        key: 'percentage',
                        header: 'Attendance',
                        align: 'right',
                        nowrap: true,
                        render: (row) => (
                          <Badge tone="danger">{formatPercent(row.percentage, { digits: 0 })}</Badge>
                        ),
                      },
                    ]}
                    rows={sent}
                    rowKey={(row, index) => `${row.student_id}-${row.subject}-${index}`}
                  />
                </div>
              ) : null}

              {skipped.length ? (
                <div className="stack-sm">
                  <h3 className="section-title">Held back</h3>
                  <Table
                    compact
                    columns={[
                      { key: 'subject', header: 'Subject' },
                      {
                        key: 'reason',
                        header: 'Why',
                        render: (row) => <Pill>{row.reason}</Pill>,
                      },
                    ]}
                    rows={skipped}
                    rowKey={(row, index) => `${row.student_id}-${row.subject}-${index}`}
                  />
                  <p className="small muted">
                    A student is held back when they were warned about the same subject inside the
                    cooldown, have no email address on file, or never activated their account — a
                    percentage computed for someone who never signed in is an artefact, not a warning.
                  </p>
                </div>
              ) : null}

              {!sent.length && !skipped.length ? (
                <Alert tone="success" title="Nobody needs warning">
                  Every student is either above the requirement or does not have enough recorded
                  sessions yet to judge.
                </Alert>
              ) : null}
            </>
          ) : !result ? (
            <EmptyState
              title="Nothing checked yet"
              message="The check reads every roster, finds who is short, and lists them. It sends nothing until you ask it to."
              action={
                <Button onClick={() => check.run()} loading={check.loading} disabled={!enabled}>
                  Check who is short
                </Button>
              }
            />
          ) : null}
        </div>
      </Card>

      <Card
        flush
        title="Warnings already sent"
        subtitle="What suppresses a repeat. Newest first."
        actions={
          <Link className="btn btn-secondary btn-sm" to="/reports">
            Defaulter report
          </Link>
        }
      >
        <Table
          compact
          columns={[
            { key: 'student_name', header: 'Student', render: (row) => row.student_name },
            { key: 'subject_name', header: 'Subject' },
            {
              key: 'percentage',
              header: 'Attendance then',
              align: 'right',
              nowrap: true,
              render: (row) => (
                <Badge tone={attendanceTone(row.percentage, row.threshold)}>
                  {formatPercent(row.percentage, { digits: 0 })}
                </Badge>
              ),
            },
            {
              key: 'threshold',
              header: 'Required then',
              align: 'right',
              nowrap: true,
              // Stored on the alert, not looked up now: it is what the student was
              // told, and the requirement may have moved since.
              render: (row) => <span className="mono">{formatPercent(row.threshold, { digits: 0 })}</span>,
            },
            {
              key: 'sent_at',
              header: 'Sent',
              align: 'right',
              nowrap: true,
              render: (row) => (
                <span title={formatDateTime(row.sent_at)}>{formatRelative(row.sent_at)}</span>
              ),
            },
          ]}
          rows={rows}
          rowKey={(row, index) => `${row.student_id}-${index}`}
          loading={history.loading}
          empty={
            <EmptyState
              title="No warning has been sent"
              message="Either nobody has fallen below the requirement, or the nightly check has not run here yet."
            />
          }
        />
      </Card>
    </>
  );
}
