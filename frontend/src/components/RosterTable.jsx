import { useState } from 'react';

import { Badge, Button, Checkbox, EmptyState, Pill, Table } from './ui/index.js';
import {
  AttendanceStatus,
  ENROLLMENT_STATUS_LABELS,
  EnrollmentStatus,
  METHOD_LABELS,
  METHOD_TONES,
} from '../lib/constants.js';
import { formatConfidence, formatTime, pluralize } from '../lib/format.js';

/** `POST /api/attendance/override/bulk` rejects a batch larger than this. */
const BULK_LIMIT = 200;

const STATUS_LABELS = {
  [AttendanceStatus.PRESENT]: 'Present',
  [AttendanceStatus.ABSENT]: 'Absent',
};

const STATUS_TONES = {
  [AttendanceStatus.PRESENT]: 'success',
  // Absent is the starting state of every row, not a fault: red would have a
  // freshly opened session screaming at the teacher before the photo is taken.
  [AttendanceStatus.ABSENT]: 'muted',
};

function isPresent(row) {
  return row.status === AttendanceStatus.PRESENT;
}

/**
 * Why the class photo could not have matched this student.
 *
 * Without it a teacher blames the camera and retakes the shot four times; the
 * student was never enrolled and the fifth photo will miss them too.
 */
function enrollmentGap(row) {
  if (row.face_enrolled) return null;
  const incomplete =
    row.enrollment_status && row.enrollment_status !== EnrollmentStatus.COMPLETE
      ? ENROLLMENT_STATUS_LABELS[row.enrollment_status]
      : null;
  const label = incomplete || 'No face data';
  return {
    label,
    title: `${label} — face recognition cannot match ${row.name}. Mark them by hand, or ask them to finish enrolment.`,
  };
}

function overrideTitle(row) {
  const reason = (row.override_reason || '').trim();
  return reason
    ? `Manual override — ${reason}`
    : 'Manual override — no reason was recorded with it.';
}

/**
 * The present/absent roster: per-row override plus bulk selection.
 *
 * Rows arrive already sorted by the backend (present first, then alphabetical),
 * and are rendered in that order on purpose — the teacher's eye lands on who is
 * still missing. Nothing here re-sorts them.
 *
 * `onOverride` is called with the target and the presence being asked for:
 * a single row object for a row's own button, or the array of selected rows for
 * a bulk action, which is what lets the caller collect one reason for the whole
 * batch and send it to `/override/bulk`. Omit `onOverride` entirely for the
 * read-only student-facing view and the checkbox and action columns disappear
 * rather than rendering controls that do nothing.
 */
export default function RosterTable({ rows, onOverride, busyStudentId, showMethod = true }) {
  const [selectedIds, setSelectedIds] = useState([]);

  // `rows` is undefined until the first load lands, and the live view replaces the
  // array every 3 s poll.
  const safeRows = Array.isArray(rows) ? rows : [];
  const interactive = typeof onOverride === 'function';

  // Selection is intersected with the current rows rather than pruned in an
  // effect: a student dropped from the roster mid-session then cannot be carried
  // into a bulk override by an id nobody can see any more.
  const selectedRows = safeRows.filter((row) => selectedIds.includes(row.student_id));
  const selectedCount = selectedRows.length;
  const total = safeRows.length;
  const allSelected = total > 0 && selectedCount === total;
  const overBulkLimit = selectedCount > BULK_LIMIT;

  const presentCount = safeRows.filter(isPresent).length;
  const overrideCount = safeRows.filter((row) => row.was_manual_override).length;
  const gapCount = safeRows.filter((row) => !row.face_enrolled).length;

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : safeRows.map((row) => row.student_id));
  };

  const toggleOne = (studentId) => {
    setSelectedIds((previous) =>
      previous.includes(studentId)
        ? previous.filter((id) => id !== studentId)
        : previous.concat(studentId),
    );
  };

  // The selection deliberately survives the action. The caller cannot tell this
  // component whether the request succeeded, and clearing on click would make a
  // failed batch of six students six re-ticks of penance.
  const runBulk = (present) => onOverride(selectedRows, present);

  const bulkLabel = (word) =>
    selectedCount ? `Mark ${selectedCount} ${word}` : `Mark selected ${word}`;

  const columns = [
    ...(interactive
      ? [
          {
            key: 'select',
            align: 'center',
            width: '2.75rem',
            header: (
              <Checkbox
                checked={allSelected}
                onChange={toggleAll}
                label={
                  <span className="sr-only">
                    {allSelected ? 'Clear selection' : 'Select every student'}
                  </span>
                }
              />
            ),
            render: (row) => (
              <Checkbox
                checked={selectedIds.includes(row.student_id)}
                onChange={() => toggleOne(row.student_id)}
                label={<span className="sr-only">{`Select ${row.name}`}</span>}
              />
            ),
          },
        ]
      : []),
    {
      key: 'student',
      header: 'Student',
      render: (row) => {
        const gap = enrollmentGap(row);
        return (
          <span className="stack-sm">
            <span className="row row-sm row-wrap">
              <span className="strong">{row.name}</span>
              {gap ? (
                <span title={gap.title}>
                  <Pill tone="muted">{gap.label}</Pill>
                </span>
              ) : null}
            </span>
            {row.email ? <span className="small faint truncate">{row.email}</span> : null}
          </span>
        );
      },
    },
    {
      key: 'roll_number',
      header: 'Roll no.',
      nowrap: true,
      render: (row) => <span className="mono">{row.roll_number || '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      nowrap: true,
      render: (row) => (
        <span className="row row-sm row-wrap">
          <Badge tone={STATUS_TONES[row.status] || 'muted'} dot>
            {STATUS_LABELS[row.status] || row.status || 'Unknown'}
          </Badge>
          {/* A manual override outranks anything the pipelines decided, so it is
              marked in the status column and survives `showMethod={false}`. The
              reason is the only thing that tells a correction from a mistake
              six weeks later, so it is both hoverable and readable aloud. */}
          {row.was_manual_override ? (
            <span title={overrideTitle(row)}>
              <Pill tone="warn">
                Override
                <span className="sr-only">
                  {row.override_reason ? `: ${row.override_reason}` : ': no reason recorded'}
                </span>
              </Pill>
            </span>
          ) : null}
        </span>
      ),
    },
    ...(showMethod
      ? [
          {
            key: 'method_used',
            header: 'Method',
            nowrap: true,
            render: (row) =>
              row.method_used ? (
                <Pill tone={METHOD_TONES[row.method_used] || 'muted'}>
                  {METHOD_LABELS[row.method_used] || METHOD_LABELS.unknown}
                </Pill>
              ) : (
                <span className="faint">—</span>
              ),
          },
          {
            key: 'confidence_score',
            header: 'Confidence',
            align: 'right',
            nowrap: true,
            render: (row) => <span className="mono">{formatConfidence(row.confidence_score)}</span>,
          },
        ]
      : []),
    {
      key: 'marked_at',
      header: 'Marked',
      align: 'right',
      nowrap: true,
      render: (row) => <span className="small muted">{formatTime(row.marked_at)}</span>,
    },
    ...(interactive
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Override</span>,
            align: 'right',
            nowrap: true,
            render: (row) => {
              const present = isPresent(row);
              return (
                <Button
                  size="sm"
                  variant={present ? 'subtle' : 'secondary'}
                  // Only this row waits on its own request: a teacher marking
                  // five students should not sit through five round trips.
                  loading={busyStudentId === row.student_id}
                  onClick={() => onOverride(row, !present)}
                  aria-label={`Mark ${row.name} ${present ? 'absent' : 'present'}`}
                >
                  {present ? 'Mark absent' : 'Mark present'}
                </Button>
              );
            },
          },
        ]
      : []),
  ];

  const summary = [
    pluralize(total, 'student'),
    `${presentCount} present`,
    `${total - presentCount} absent`,
    overrideCount ? pluralize(overrideCount, 'manual override') : null,
    gapCount ? `${gapCount} without face data` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="stack">
      {interactive ? (
        <div className="row between row-wrap">
          <span className="small muted" aria-live="polite">
            {selectedCount
              ? `${selectedCount} of ${pluralize(total, 'student')} selected`
              : 'Tick students to override several of them with one reason.'}
          </span>
          <span className="row row-sm row-wrap">
            {overBulkLimit ? (
              <span className="small muted">{`Select at most ${BULK_LIMIT} at a time.`}</span>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={!selectedCount || overBulkLimit}
              onClick={() => runBulk(true)}
            >
              {bulkLabel('present')}
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={!selectedCount || overBulkLimit}
              onClick={() => runBulk(false)}
            >
              {bulkLabel('absent')}
            </Button>
            {selectedCount ? (
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
                Clear
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}

      <Table
        columns={columns}
        rows={safeRows}
        rowKey="student_id"
        footer={<span className="small muted">{summary}</span>}
        empty={
          <EmptyState
            title="No students on this roster"
            message="Enrol students in the subject and they will appear here as soon as the session opens."
          />
        }
      />
    </div>
  );
}
