import { useMemo, useRef, useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  ProgressBar,
  Select,
} from './ui/index.js';
import { SessionsAPI } from '../lib/api.js';
import {
  AttendanceStatus,
  ErrorCode,
  REVIEW_REASON_HINTS,
  REVIEW_REASON_LABELS,
  ReviewReason,
  ReviewResolution,
} from '../lib/constants.js';
import { formatConfidence, formatRelative, pluralize } from '../lib/format.js';

/** `clean_reason` in `backend/app/utils/validators.py` truncates past this. */
const MAX_NOTE_LENGTH = 500;

/** Keep the outcome strip readable: the queue below it is the interface. */
const MAX_NOTICES = 4;

/**
 * No tone here is green.
 *
 * Every face in this queue already failed the automatic threshold, so a
 * reassuring colour would be the interface arguing for a decision the pipeline
 * refused to make.
 */
const REASON_TONES = {
  [ReviewReason.LOW_CONFIDENCE]: 'warn',
  [ReviewReason.AMBIGUOUS]: 'warn',
  [ReviewReason.NO_MATCH]: 'muted',
  [ReviewReason.LOW_RESOLUTION]: 'info',
};

/* Inline SVG: the contract allows no icon package. */
const CLEAR_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="32"
    height="32"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.6 2.6L16 9.6" />
  </svg>
);

const CAMERA_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="32"
    height="32"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 9a2 2 0 0 1 2-2h2l1.6-2h6.8L17 7h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.4" />
  </svg>
);

const DELETED_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="26"
    height="26"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M4.5 19.5 19.5 4.5" />
  </svg>
);

/** `confidence_score` arrives as 0..1 or as an already-scaled percentage. */
function toPercent(value) {
  const number = Number(value);
  if (value === null || value === undefined || Number.isNaN(number)) return null;
  return number > 1 ? number : number * 100;
}

/**
 * Raw recognition distance, deliberately not run through `formatConfidence`:
 * a distance of 0.55 is a *good* match, and rendering it as "55%" would invert
 * its meaning to anyone reading quickly.
 */
function formatDistance(value) {
  const number = Number(value);
  if (value === null || value === undefined || Number.isNaN(number)) return '—';
  return number.toFixed(3);
}

/**
 * Turn a resolve response into one honest sentence.
 *
 * `marked` carries the outcome of `attendance.mark_present`, which can decline:
 * a manual override outranks a human-confirmed face match just as it outranks an
 * automatic one, and claiming "marked present" over the top of that would be a
 * lie the roster then contradicts.
 */
function outcomeNotice(result, resolution, name) {
  const marked = result && result.marked;
  const who = name || 'that student';

  if (!marked) {
    return {
      tone: 'info',
      text:
        resolution === ReviewResolution.NOT_A_STUDENT
          ? 'Recorded as not one of your students. Nobody was marked and the crop is deleted.'
          : 'Dismissed. Nobody was marked and the crop is deleted.',
    };
  }
  if (marked.blocked_by_override) {
    return {
      tone: 'warn',
      text:
        marked.message ||
        `A teacher's manual override for ${who} stands, so their attendance was not changed.`,
    };
  }
  if (marked.created === false) {
    return {
      tone: 'info',
      text: marked.message || `${who} was already marked present, so nothing changed.`,
    };
  }
  return { tone: 'success', text: `${who} is now marked present from this face.` };
}

/**
 * One queued face.
 *
 * A component per item rather than maps keyed by id in the parent: React keeps
 * this state alive across the parent's 3-second poll as long as `key={item.id}`
 * holds, so resolving one card cannot wipe a half-made choice on another.
 */
function ReviewItemCard({ sessionId, item, position, total, students, options, onSettled }) {
  // `null` means "untouched", which is not the same as "cleared": it lets the
  // suggestion below follow the roster as it loads, while a teacher's own choice
  // is never overwritten by a later render.
  const [choice, setChoice] = useState(null);
  const [note, setNote] = useState('');
  const [busyAction, setBusyAction] = useState(null);
  const [error, setError] = useState(null);

  const suggestedId =
    item.best_guess_student_id &&
    students.some((student) => student.student_id === item.best_guess_student_id)
      ? item.best_guess_student_id
      : '';
  const studentId = choice === null ? suggestedId : choice;
  const selected = students.find((student) => student.student_id === studentId) || null;

  const busy = Boolean(busyAction);
  const rosterEmpty = options.length === 0;
  const hasCrop = Boolean(item.crop_available && item.crop_data_url);
  const confidence = toPercent(item.confidence_score);
  const reasonLabel = REVIEW_REASON_LABELS[item.reason] || 'Needs a decision';
  const reasonHint =
    REVIEW_REASON_HINTS[item.reason] ||
    'The pipeline would not match this face on its own, so it is yours to decide.';

  let selectHint;
  if (rosterEmpty) {
    selectHint = 'Nobody is on this subject’s roster yet, so there is no one to assign this face to.';
  } else if (selected && selected.status === AttendanceStatus.PRESENT) {
    selectHint = `${selected.name} is already marked present — assigning this face will not change their record. Moving attendance from one student to another is an override on the roster.`;
  }

  const submit = async (resolution) => {
    if (resolution === ReviewResolution.ASSIGNED && !studentId) {
      setError('Choose the student this face belongs to first.');
      return;
    }
    setError(null);
    setBusyAction(resolution);

    const payload = { resolution };
    if (resolution === ReviewResolution.ASSIGNED) payload.student_id = studentId;
    const trimmedNote = note.trim();
    if (trimmedNote) payload.reason = trimmedNote;

    try {
      const result = await SessionsAPI.resolveReview(sessionId, item.id, payload);
      onSettled(item.id, outcomeNotice(result, resolution, selected && selected.name), result);
    } catch (err) {
      // 409 `already_resolved` (another teacher, another device) and a 404 for a
      // record that no longer exists are both information, not failures: there is
      // nothing left for this card to do either way.
      if (err && (err.code === ErrorCode.ALREADY_RESOLVED || err.status === 404)) {
        onSettled(
          item.id,
          {
            tone: 'info',
            text: 'That face had already been resolved elsewhere — on another device, or by another teacher. It has been taken out of the queue.',
          },
          null,
        );
        return;
      }
      const message = (err && err.message) || 'That decision did not go through. Try it again.';
      const wait =
        err && err.code === ErrorCode.RATE_LIMITED && err.retryAfter
          ? ` Try again in ${pluralize(err.retryAfter, 'second')}.`
          : '';
      setError(`${message}${wait}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="review-card" role="listitem">
      {hasCrop ? (
        <img
          className="review-crop"
          src={item.crop_data_url}
          alt={`Unmatched face ${position} of ${total}, cropped from the class photo`}
        />
      ) : (
        <div className="review-crop-missing">
          {DELETED_ICON}
          <p className="small strong">Image deleted for privacy</p>
          <p className="small faint">
            Crops are kept for at most 24 hours and are destroyed the moment the session ends. You
            can still record a decision, but there is no longer an image to check it against.
          </p>
        </div>
      )}

      <div className="review-body stack-sm">
        <div className="row between row-wrap">
          <span className="strong">{`Face ${position} of ${total}`}</span>
          <Badge tone={REASON_TONES[item.reason] || 'muted'}>{reasonLabel}</Badge>
        </div>
        <p className="small muted">{reasonHint}</p>

        {item.reason === ReviewReason.AMBIGUOUS ? (
          <Alert tone="warn">
            Two students scored almost identically. The suggestion below is only the first of them —
            taking it without looking at the face is the exact mistake this queue exists to catch.
          </Alert>
        ) : null}

        {item.best_guess_name ? (
          <div className="stack-sm">
            <span className="small muted">Suggested match, to verify — not an answer to confirm:</span>
            <span className="strong">{item.best_guess_name}</span>
            {confidence === null ? (
              <span className="small faint">No confidence score was recorded for this face.</span>
            ) : (
              <ProgressBar
                value={confidence}
                tone="warn"
                label={`Confidence ${formatConfidence(item.confidence_score)} — below the automatic threshold`}
              />
            )}
            {item.distance === null || item.distance === undefined ? null : (
              <div className="kv">
                <span className="kv-key">Distance (lower is a closer match)</span>
                <span className="kv-value mono">{formatDistance(item.distance)}</span>
              </div>
            )}
          </div>
        ) : (
          <p className="small muted">
            Nobody scored close enough to suggest. Assign this face only if you recognise the person
            yourself.
          </p>
        )}

        <Select
          label={`Assign face ${position} to`}
          placeholder="Choose a student…"
          options={options}
          value={studentId}
          onChange={(event) => setChoice(event.target.value)}
          disabled={busy || rosterEmpty}
          hint={selectHint}
        />

        {/* Optional, unlike an override's reason: the backend takes `reason` here
            with `required=False`, and it is the only free text the audit entry for
            this decision will ever carry. */}
        <Input
          label="Note for the audit log (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={MAX_NOTE_LENGTH}
          placeholder="e.g. recognised him in the back row"
          disabled={busy}
        />

        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}

        {/* No <form>: pressing Enter in the note must not commit a name to a face. */}
        <div className="review-actions">
          <Button
            size="sm"
            variant="primary"
            loading={busyAction === ReviewResolution.ASSIGNED}
            disabled={busy || !studentId}
            onClick={() => submit(ReviewResolution.ASSIGNED)}
            aria-label={
              selected
                ? `Assign face ${position} to ${selected.name} and mark them present`
                : `Assign face ${position} to the selected student`
            }
          >
            Assign and mark present
          </Button>
          <Button
            size="sm"
            variant="subtle"
            loading={busyAction === ReviewResolution.NOT_A_STUDENT}
            disabled={busy}
            onClick={() => submit(ReviewResolution.NOT_A_STUDENT)}
            aria-label={`Record face ${position} as not one of your students`}
          >
            Not a student
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busyAction === ReviewResolution.DISMISSED}
            disabled={busy}
            onClick={() => submit(ReviewResolution.DISMISSED)}
            aria-label={`Dismiss face ${position} without marking anybody`}
          >
            Cannot tell — dismiss
          </Button>
        </div>

        {hasCrop && item.expires_at ? (
          <p className="small faint">{`This crop is deleted ${formatRelative(item.expires_at)}.`}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The review queue: one card per face the class-photo pipeline would not match.
 *
 * This is the screen where a human attaches a name to a face, so it is written to
 * make the machine's uncertainty visible rather than to move the teacher through
 * it quickly. Every number the pipeline produced is shown, the best guess is
 * framed as a suggestion, and nothing is submitted without a click.
 *
 * `sessionId` is used for `SessionsAPI.resolveReview`; discarding the rest is the
 * parent's call (`onDiscardAll`), because the parent also owns the counts that
 * disappear with it.
 */
export default function ReviewQueue({ sessionId, items, roster, onResolved, onDiscardAll }) {
  // itemId -> 'resolved' | 'discarded'. One map, keyed by id, so a reload that
  // still lists an item we have already settled cannot resurrect its card.
  const [removed, setRemoved] = useState({});
  const [notices, setNotices] = useState([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState(null);
  const noticeSeq = useRef(0);

  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  // Memoised so `options` below has a stable input, and so the pre-selected
  // suggestion inside each card is not recomputed on every poll tick.
  const students = useMemo(() => (Array.isArray(roster) ? roster.filter(Boolean) : []), [roster]);

  // Already-present students stay in the list on purpose: a teacher resolving a
  // face is often correcting a mis-attributed automatic match, and hiding them
  // would make that correction impossible. Their status is in the label so the
  // choice is made with open eyes.
  const options = useMemo(
    () =>
      students.map((student) => ({
        value: student.student_id,
        label:
          student.status === AttendanceStatus.PRESENT
            ? `${student.name} — already marked present`
            : student.name,
      })),
    [students],
  );

  const visible = list.filter((item) => !item.resolved && !removed[item.id]);
  const settledKinds = Object.values(removed);
  const resolvedHere = settledKinds.filter((kind) => kind === 'resolved').length;
  const discardedHere = settledKinds.filter((kind) => kind === 'discarded').length;
  const resolvedRemotely = list.filter((item) => item.resolved && !removed[item.id]).length;
  const reviewedCount = resolvedHere + resolvedRemotely;

  const pushNotice = (notice) => {
    if (!notice) return;
    noticeSeq.current += 1;
    const entry = { id: `review-notice-${noticeSeq.current}`, ...notice };
    setNotices((current) => current.concat(entry).slice(-MAX_NOTICES));
  };

  const dismissNotice = (id) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  };

  const handleSettled = (itemId, notice, result) => {
    setRemoved((current) => ({ ...current, [itemId]: 'resolved' }));
    pushNotice(notice);
    // The parent owns the unresolved count, the roster and the photo status; only
    // a real response can update them, so a 409 passes `null` and the next poll
    // straightens the numbers out.
    if (result && typeof onResolved === 'function') onResolved(result);
  };

  const handleDiscard = async () => {
    if (typeof onDiscardAll !== 'function') {
      setConfirmOpen(false);
      return;
    }
    setDiscardError(null);
    setDiscarding(true);
    const doomed = visible.map((item) => item.id);
    try {
      await onDiscardAll();
      setRemoved((current) => {
        const next = { ...current };
        doomed.forEach((id) => {
          next[id] = 'discarded';
        });
        return next;
      });
      setConfirmOpen(false);
    } catch (err) {
      // Reported inside the dialog rather than as a toast: the modal is on top of
      // the page, and an error hidden behind it reads as a request that worked.
      setDiscardError((err && err.message) || 'The queue could not be discarded.');
    } finally {
      setDiscarding(false);
    }
  };

  const noticeStrip = notices.length ? (
    // No wrapping live region: every Alert is already a status/alert role, and
    // nesting them makes some screen readers read the whole strip twice.
    <div className="stack-sm">
      {notices.map((notice) => (
        <Alert key={notice.id} tone={notice.tone} onClose={() => dismissNotice(notice.id)}>
          {notice.text}
        </Alert>
      ))}
    </div>
  ) : null;

  if (visible.length === 0) {
    let empty;
    if (discardedHere) {
      empty = {
        icon: CLEAR_ICON,
        title: 'Remaining faces discarded',
        message: `${pluralize(discardedHere, 'crop')} deleted, and nobody was marked from them. Anyone the photo missed needs marking by hand on the roster.`,
      };
    } else if (reviewedCount) {
      empty = {
        icon: CLEAR_ICON,
        title: 'Review queue clear',
        message: `Every face the photo was unsure about has been dealt with — ${pluralize(reviewedCount, 'face')} reviewed. Anything marked from here shows on the roster as a reviewed face match.`,
      };
    } else if (students.some((student) => student.status === AttendanceStatus.PRESENT)) {
      // Nothing queued, nothing resolved here, yet students are already marked:
      // the photo ran and the pipeline had nothing to ask about. That is a result,
      // not an absence, so it is worth reading as one. (The distinction is a
      // heuristic — this component is given the queue and the roster, not the
      // session's `photo_review_status`.)
      empty = {
        icon: CLEAR_ICON,
        title: 'No faces need checking',
        message:
          'Every face the class photo recognised matched an enrolled student confidently, so the system had nothing to ask you about.',
      };
    } else {
      empty = {
        icon: CAMERA_ICON,
        title: 'Nothing to review yet',
        message:
          'Upload a class photo above. Any face the system cannot place confidently arrives here with its crop, so you can decide instead of the machine guessing.',
      };
    }

    return (
      <div className="stack">
        {noticeStrip}
        <EmptyState title={empty.title} message={empty.message} icon={empty.icon} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row between row-wrap">
        <div className="stack-sm">
          <span className="strong" aria-live="polite">
            {`${pluralize(visible.length, 'face')} waiting for a decision`}
          </span>
          <span className="small muted">
            Nobody is marked from these faces until you say so. Assigning marks that student present;
            “Not a student” and “dismiss” mark nobody. Every decision deletes its crop immediately.
          </span>
        </div>
        <Button
          variant="subtle"
          onClick={() => {
            setDiscardError(null);
            setConfirmOpen(true);
          }}
          disabled={discarding}
        >
          Discard the rest
        </Button>
      </div>

      {noticeStrip}

      <div className="review-grid" role="list">
        {visible.map((item, index) => (
          <ReviewItemCard
            key={item.id}
            sessionId={sessionId}
            item={item}
            position={index + 1}
            total={visible.length}
            students={students}
            options={options}
            onSettled={handleSettled}
          />
        ))}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title="Discard the rest of the queue?"
        message={`This deletes the ${pluralize(visible.length, 'face crop')} still waiting here, straight away, and marks nobody present. It cannot be undone: once the crops are gone there is no image left to review, so anyone the photo missed has to be marked by hand on the roster.`}
        confirmLabel={`Discard ${pluralize(visible.length, 'crop')}`}
        cancelLabel="Keep reviewing"
        busy={discarding}
        onConfirm={handleDiscard}
        onCancel={() => setConfirmOpen(false)}
      >
        {discardError ? (
          <p className="field-error" role="alert">
            {discardError}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
