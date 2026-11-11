import { useMemo, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Pill,
  Select,
  Table,
} from '../../components/ui/index.js';
import { AdminAPI } from '../../lib/api.js';
import { ROLE_LABELS } from '../../lib/constants.js';
import { formatDateTime, formatRelative, humanizeAction, pluralize } from '../../lib/format.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';

/**
 * Every value `target_type` is ever written with, from the `audit.record` calls in
 * `backend/app/`. There is no endpoint that lists them, and a filter built from
 * whatever happens to be on the current page would quietly lose options as it
 * narrowed.
 */
const TARGET_TYPES = [
  { value: '', label: 'Anything' },
  { value: 'user', label: 'A person' },
  { value: 'student', label: 'A student record' },
  { value: 'subject', label: 'A subject' },
  { value: 'session', label: 'A session' },
  { value: 'pending_face_match', label: 'A review item' },
  { value: 'institution', label: 'The institution' },
];

const PAGE_SIZES = [
  { value: '50', label: '50 per page' },
  { value: '100', label: '100 per page' },
  { value: '250', label: '250 per page' },
];

/**
 * The actions worth jumping straight to. Each is a single action value, so the
 * server does the filtering — there is no `$ne` on this endpoint, which is why
 * "everything except check-ins" is not offered.
 */
const PRESETS = [
  { action: 'attendance.manual_override', label: 'Manual overrides' },
  { action: 'biometric.reset', label: 'Biometric resets' },
  { action: 'class_photo.review_resolved', label: 'Review decisions' },
  { action: 'user.disabled', label: 'Accounts disabled' },
];

/** Actions that change what somebody can do, rather than recording what happened. */
const SENSITIVE = new Set([
  'attendance.manual_override',
  'biometric.reset',
  'institution.settings_updated',
  'user.disabled',
  'user.invite_revoked',
  'class_photo.crops_discarded',
]);

function toneFor(action) {
  if (SENSITIVE.has(action)) return 'warn';
  if (action === 'attendance.marked') return 'muted';
  return 'info';
}

/**
 * The audit trail.
 *
 * Unfiltered, this is mostly `attendance.marked`: every QR and voice check-in
 * writes one. That is the correct thing for the log to contain and the wrong
 * thing to open a page with, so the presets above the table lead with the entries
 * an administrator is usually looking for — a mark someone made by hand, a
 * biometric someone reset, an account someone closed.
 */
export default function AuditPage() {
  useDocumentTitle('Audit log');

  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [actor, setActor] = useState(null); // {id, name} — set by clicking a name
  const [limit, setLimit] = useState('50');
  const [skip, setSkip] = useState(0);
  const [detail, setDetail] = useState(null);

  const params = useMemo(() => {
    const next = { limit: Number(limit), skip };
    if (action) next.action = action;
    if (targetType) next.target_type = targetType;
    if (actor) next.actor_id = actor.id;
    return next;
  }, [action, targetType, actor, limit, skip]);

  const audit = useResource(() => AdminAPI.audit(params), [params]);
  const entries = (audit.data && audit.data.entries) || [];
  const size = Number(limit);

  // The endpoint reports what it returned, not how many exist. A full page means
  // "there is probably more", which is all that can honestly be said.
  const maybeMore = entries.length >= size;

  const actionOptions = useMemo(() => {
    const list = (audit.data && audit.data.actions) || [];
    return [{ value: '', label: 'Every action' }].concat(
      list.map((value) => ({ value, label: humanizeAction(value) })),
    );
  }, [audit.data]);

  /** Any filter change invalidates the page number it was read against. */
  const reset = (apply) => {
    setSkip(0);
    apply();
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Audit log</h1>
          <p className="page-sub">
            Who did what, when, and what it changed. Entries are never edited or removed.
          </p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={audit.reload} loading={audit.loading}>
            Refresh
          </Button>
        </div>
      </div>

      <Card title="Filters" subtitle="Newest first.">
        <div className="stack">
          <div className="grid grid-3">
            <Select
              label="Action"
              options={actionOptions}
              value={action}
              onChange={(event) => reset(() => setAction(event.target.value))}
              hint="The list comes from the server, so it covers actions nothing has recorded yet."
            />
            <Select
              label="What it affected"
              options={TARGET_TYPES}
              value={targetType}
              onChange={(event) => reset(() => setTargetType(event.target.value))}
            />
            <Select
              label="Page size"
              options={PAGE_SIZES}
              value={limit}
              onChange={(event) => reset(() => setLimit(event.target.value))}
            />
          </div>

          <div className="row row-sm row-wrap">
            <span className="small muted">Jump to:</span>
            {PRESETS.map((preset) => (
              <Button
                key={preset.action}
                size="sm"
                variant={action === preset.action ? 'primary' : 'ghost'}
                onClick={() =>
                  reset(() => setAction(action === preset.action ? '' : preset.action))
                }
              >
                {preset.label}
              </Button>
            ))}
            {action || targetType || actor ? (
              <Button
                size="sm"
                variant="subtle"
                onClick={() =>
                  reset(() => {
                    setAction('');
                    setTargetType('');
                    setActor(null);
                  })
                }
              >
                Clear filters
              </Button>
            ) : null}
          </div>

          {actor ? (
            <Alert
              tone="muted"
              title={`Only what ${actor.name} did`}
              onClose={() => reset(() => setActor(null))}
            >
              Click any other name in the table to follow them instead.
            </Alert>
          ) : null}
        </div>
      </Card>

      {!action && !actor ? (
        <Alert tone="muted" title="Mostly check-ins, by design">
          Every QR and voice check-in writes an entry, so an unfiltered log is dominated by them. The
          buttons above jump to the entries that record a decision somebody made rather than a
          student arriving.
        </Alert>
      ) : null}

      {audit.error && !audit.data ? (
        <ErrorState error={audit.error} onRetry={audit.reload} title="Could not load the audit log" />
      ) : (
        <Card
          flush
          title={
            audit.data
              ? `${pluralize(audit.data.count, 'entry', 'entries')}${skip ? ` after the first ${skip}` : ''}`
              : 'Loading…'
          }
          footer={
            <div className="row between row-wrap">
              <span className="small muted">
                A role change is filed under “Institution settings updated” — look at the affected
                column to tell the two apart.
              </span>
              <div className="row row-sm">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={skip === 0 || audit.loading}
                  onClick={() => setSkip(Math.max(0, skip - size))}
                >
                  Newer
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!maybeMore || audit.loading}
                  onClick={() => setSkip(skip + size)}
                >
                  Older
                </Button>
              </div>
            </div>
          }
        >
          <Table
            compact
            columns={[
              {
                key: 'timestamp',
                header: 'When',
                nowrap: true,
                render: (entry) => (
                  <span title={formatDateTime(entry.timestamp)}>
                    {formatRelative(entry.timestamp)}
                  </span>
                ),
              },
              {
                key: 'action',
                header: 'Action',
                render: (entry) => (
                  <Badge tone={toneFor(entry.action)}>{humanizeAction(entry.action)}</Badge>
                ),
              },
              {
                key: 'actor',
                header: 'Who',
                render: (entry) => {
                  const who = entry.actor || { name: 'System' };
                  // A system entry has no actor_id, so there is nothing to filter by.
                  if (!entry.actor_id) {
                    return (
                      <span className="faint" title="Written by a scheduled job, not a person">
                        System
                      </span>
                    );
                  }
                  return (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => reset(() => setActor({ id: entry.actor_id, name: who.name }))}
                      title={`${who.email || ''} · show only their entries`}
                    >
                      {who.name || 'Unknown'}
                      {who.role ? (
                        <span className="faint"> · {ROLE_LABELS[who.role] || who.role}</span>
                      ) : null}
                    </Button>
                  );
                },
              },
              {
                key: 'target_type',
                header: 'Affected',
                nowrap: true,
                render: (entry) =>
                  entry.target_type ? (
                    <Pill>
                      {(
                        TARGET_TYPES.find((option) => option.value === entry.target_type) || {
                          label: entry.target_type,
                        }
                      ).label}
                    </Pill>
                  ) : null,
              },
              {
                key: 'reason',
                header: 'Reason',
                render: (entry) =>
                  entry.reason ? (
                    <span className="small">{entry.reason}</span>
                  ) : (
                    <span className="faint">—</span>
                  ),
              },
              {
                key: 'detail',
                header: <span className="sr-only">Detail</span>,
                align: 'right',
                nowrap: true,
                render: (entry) => (
                  <Button size="sm" variant="ghost" onClick={() => setDetail(entry)}>
                    Detail
                  </Button>
                ),
              },
            ]}
            rows={entries}
            rowKey="id"
            loading={audit.loading}
            empty={
              <EmptyState
                title={
                  action || targetType || actor || skip
                    ? 'Nothing matches'
                    : 'Nothing has been recorded yet'
                }
                message={
                  skip
                    ? 'You have paged past the end. Go back to the newest entries.'
                    : action || targetType || actor
                      ? 'Clear the filters, or pick a different action.'
                      : 'The log fills up as people sign in, mark attendance and change things.'
                }
                action={
                  skip ? (
                    <Button variant="secondary" onClick={() => setSkip(0)}>
                      Back to newest
                    </Button>
                  ) : null
                }
              />
            }
          />
        </Card>
      )}

      <EntryDetail entry={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

/**
 * The whole entry, unedited.
 *
 * `previous_state` and `new_state` are written by the code that made the change
 * and their keys differ from one action to the next, so they are printed rather
 * than interpreted — an audit trail that renders a guess is worse than one that
 * renders the record.
 */
function EntryDetail({ entry, onClose }) {
  if (!entry) return null;
  const who = entry.actor || { name: 'System' };

  return (
    <Modal open wide title={humanizeAction(entry.action)} onClose={onClose}>
      <div className="stack">
        <div className="kv">
          <span className="kv-key">When</span>
          <span className="kv-value">{formatDateTime(entry.timestamp)}</span>
          <span className="kv-key">Who</span>
          <span className="kv-value">
            {who.name}
            {who.email ? <span className="faint"> · {who.email}</span> : null}
            {who.role ? <span className="faint"> · {ROLE_LABELS[who.role] || who.role}</span> : null}
          </span>
          <span className="kv-key">Affected</span>
          <span className="kv-value">
            {entry.target_type || '—'}
            {entry.target_id ? <span className="mono faint"> {entry.target_id}</span> : null}
          </span>
          {entry.reason ? (
            <>
              <span className="kv-key">Reason</span>
              <span className="kv-value">{entry.reason}</span>
            </>
          ) : null}
        </div>

        <StateBlock title="Before" value={entry.previous_state} />
        <StateBlock title="After" value={entry.new_state} />
        <StateBlock title="Extra detail" value={entry.metadata} />
      </div>
    </Modal>
  );
}

function StateBlock({ title, value }) {
  const empty = value === null || value === undefined || (typeof value === 'object' && !Object.keys(value).length);
  if (empty) return null;
  return (
    <div className="stack-sm">
      <h3 className="section-title">{title}</h3>
      <pre className="code-block">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
