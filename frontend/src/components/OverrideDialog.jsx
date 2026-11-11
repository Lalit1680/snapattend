import { useEffect, useState } from 'react';

import { Alert, Badge, Button, Modal, Pill, Textarea } from './ui/index.js';
import { AttendanceStatus, METHOD_LABELS, METHOD_TONES } from '../lib/constants.js';
import { formatConfidence, formatTime, truncate } from '../lib/format.js';

/**
 * `clean_reason` in `backend/app/utils/validators.py`: a reason under three
 * characters is a 422, and anything past 500 is silently truncated on the way
 * into the database. Both are enforced here so the teacher sees exactly what
 * will be stored instead of meeting the rule as an error message.
 */
const MIN_REASON = 3;
const MAX_REASON = 500;

/** One row, or the array a bulk selection hands over — one reason covers either. */
function toTargets(student) {
  if (Array.isArray(student)) return student.filter(Boolean);
  return student ? [student] : [];
}

function isPresent(row) {
  return row.status === AttendanceStatus.PRESENT;
}

/**
 * Manual override, with the reason the API and the audit trail both insist on.
 *
 * `onConfirm` receives the trimmed reason only; the caller already knows which
 * student and which direction it asked about, and re-deriving that here would
 * give two components an opinion about the same request.
 *
 * `student` accepts either a single roster row or an array of them, because
 * `/override/bulk` takes one reason for the whole batch and a second dialog with
 * its own copy of this validation is exactly how a blank reason ships.
 */
export default function OverrideDialog({ open, student, present, onConfirm, onCancel, busy }) {
  const targets = toTargets(student);
  const targetKey = targets.map((row) => row.student_id).join(',');

  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  // Keyed on the ids rather than on `student`: the live view re-polls the roster
  // every 3 s and passes down a freshly built row object each time, which as a
  // dependency would wipe the field out from under whoever is typing in it.
  // Resetting on open is the point — last override's reason pre-filled against a
  // different student is a plausible-looking, permanent, wrong audit entry.
  useEffect(() => {
    if (!open) return;
    setReason('');
    setTouched(false);
  }, [open, targetKey]);

  if (!open || targets.length === 0) return null;

  const batch = targets.length > 1;
  const single = batch ? null : targets[0];
  const goingPresent = Boolean(present);
  const targetWord = goingPresent ? 'present' : 'absent';
  const who = batch ? `${targets.length} students` : single.name;

  const hasMark = Boolean(single && (single.method_used || single.marked_at || isPresent(single)));
  const alreadyCount = targets.filter((row) => isPresent(row) === goingPresent).length;

  // Trimmed before validating, so a space bar does not buy its way past a
  // required field and leave "  " in the audit log.
  const trimmed = reason.trim();
  const canConfirm = trimmed.length >= MIN_REASON;
  // Too-short shows while typing — a disabled button with no stated reason reads
  // as a broken dialog. "Required" waits for a blur rather than scolding a field
  // nobody has touched yet.
  let error;
  if (trimmed.length > 0 && !canConfirm) {
    error = `Give a slightly more descriptive reason — ${MIN_REASON} characters minimum.`;
  } else if (touched && !canConfirm) {
    error = 'A reason is required.';
  }

  const handleConfirm = () => {
    if (!canConfirm) {
      setTouched(true);
      return;
    }
    onConfirm(trimmed);
  };

  let lead;
  if (goingPresent) {
    lead = `Nothing detected ${batch ? 'them' : 'this student'}, so this records your decision that they were in the room.`;
  } else if (batch || hasMark) {
    lead =
      'This withdraws the mark already on the register and records your decision that they were not in the room.';
  } else {
    lead = 'This records your decision that this student was not in the room.';
  }

  let registerNow;
  if (batch) {
    registerNow = alreadyCount
      ? `${alreadyCount} of ${targets.length} already ${targetWord}`
      : `None of them are marked ${targetWord} yet`;
  } else if (!hasMark) {
    registerNow = <span className="muted">Nothing recorded yet</span>;
  } else {
    registerNow = (
      <span className="row row-sm row-wrap">
        <Badge tone={isPresent(single) ? 'success' : 'muted'} dot>
          {isPresent(single) ? 'Present' : 'Absent'}
        </Badge>
        {single.method_used ? (
          <Pill tone={METHOD_TONES[single.method_used] || 'muted'}>
            {METHOD_LABELS[single.method_used] || METHOD_LABELS.unknown}
          </Pill>
        ) : null}
        {single.confidence_score === null || single.confidence_score === undefined ? null : (
          <span className="small mono">{formatConfidence(single.confidence_score)}</span>
        )}
        {single.marked_at ? (
          <span className="small muted">{formatTime(single.marked_at)}</span>
        ) : null}
      </span>
    );
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      {/* Withdrawing a mark someone earned is the direction worth a red button. */}
      <Button
        variant={goingPresent ? 'primary' : 'danger'}
        onClick={handleConfirm}
        loading={busy}
        disabled={!canConfirm}
      >
        {`Mark ${targetWord}`}
      </Button>
    </>
  );

  return (
    <Modal
      open={open}
      title={`Mark ${who} ${targetWord}`}
      // Mid-request there is no safe way out: dismissing would hide the outcome of
      // something the server is already writing to the register.
      onClose={busy ? undefined : onCancel}
      closeOnBackdrop={!busy}
      footer={footer}
    >
      <div className="stack">
        <div className="stack-sm">
          <p>{lead}</p>
          <p className="small muted">
            A manual mark outranks the class photo, the QR code and the voice check.
          </p>
        </div>

        <dl className="kv">
          <dt className="kv-key">{batch ? 'Students' : 'Student'}</dt>
          <dd className="kv-value">
            {batch ? truncate(targets.map((row) => row.name).join(', '), 160) : single.name}
          </dd>

          {!batch && single.roll_number ? (
            <>
              <dt className="kv-key">Roll no.</dt>
              <dd className="kv-value mono">{single.roll_number}</dd>
            </>
          ) : null}

          <dt className="kv-key">On the register now</dt>
          <dd className="kv-value">{registerNow}</dd>
        </dl>

        {single && single.was_manual_override ? (
          <Alert tone="warn" title="This student was already overridden by hand">
            <p className="small">
              {single.override_reason
                ? `Recorded reason: "${single.override_reason}".`
                : 'No reason was recorded with it.'}{' '}
              Your reason replaces it on the register; the earlier one stays in the audit log.
            </p>
          </Alert>
        ) : null}

        <Textarea
          label="Reason"
          required
          rows={3}
          value={reason}
          maxLength={MAX_REASON}
          disabled={busy}
          error={error}
          hint="Required. It is the only thing that will tell a correction from a mistake when someone reads this register back in six weeks."
          placeholder="e.g. arrived late, or stood behind the pillar and the photo missed them"
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
    </Modal>
  );
}
