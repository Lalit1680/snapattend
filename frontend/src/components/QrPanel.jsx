import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge, Button, CopyField, EmptyState, ProgressBar, Spinner } from './ui/index.js';
import { useToast } from '../context/ToastContext.jsx';
import { useCountdown } from '../hooks/useCountdown.js';
import { formatClock } from '../lib/format.js';

/**
 * Mirrors `Config.QR_TOKEN_TTL_SECONDS` (30 s).
 *
 * It only scales the progress track and the wording of the hint, never the clock:
 * the clock comes from `qr.expires_at`, so a deployment that lengthened the TTL
 * still counts down correctly and merely shows a full bar for the extra seconds.
 */
const ROTATION_SECONDS = 30;

/**
 * A student who starts unlocking their phone with fewer seconds than this left
 * will be posting a token the server has already rotated past. Telling them to
 * wait is kinder than letting them collect a rejection.
 */
const WARN_SECONDS = 6;

const QR_GLYPH = (
  <svg
    viewBox="0 0 24 24"
    width="28"
    height="28"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3z" />
    <path d="M18 18h3v3h-3z" />
  </svg>
);

function statusFor({ busy, stale, warning }) {
  if (busy) return { tone: 'muted', label: 'Refreshing', hint: 'A new code is being generated.' };
  if (stale) {
    return {
      tone: 'warn',
      label: 'Waiting',
      hint: 'This code has expired. Wait for the next one before scanning.',
    };
  }
  if (warning) {
    return {
      tone: 'warn',
      label: 'Refreshing',
      hint: 'Almost gone — wait for the next code before you scan.',
    };
  }
  return {
    tone: 'success',
    label: 'Live',
    hint: `Scan the code on screen. It changes every ${ROTATION_SECONDS} seconds.`,
  };
}

/** What stands in for the image. The order matches the checks in `showImage`. */
function frameCopy({ busy, stale }) {
  if (busy) return { title: 'Fetching a code', detail: 'The next code is on its way.' };
  if (stale) {
    return {
      title: 'Waiting for the next code',
      detail: 'Do not scan yet — the code on screen has expired.',
    };
  }
  return {
    title: 'Waiting for the next code',
    detail: 'The code is being prepared for this session.',
  };
}

/**
 * The projected check-in code.
 *
 * Deliberately presentational. `GET /api/sessions/:id/live` returns a fresh `qr`
 * on every 3 s poll and the rotation itself happens server-side inside
 * `ensure_fresh_token`, so this component never fetches and never rotates on a
 * timer of its own — a second clock in here would drift out of step with the one
 * that actually decides which token is valid. `onRotate` is the manual
 * "regenerate now" button and nothing else.
 */
export default function QrPanel({ sessionId, qr, onRotate, loading }) {
  const { notifyError } = useToast();
  const [rotating, setRotating] = useState(false);
  const liveRef = useRef(true);

  useEffect(() => {
    // Reset on mount, not just on unmount: StrictMode runs the cleanup once in
    // development, and a latched `false` would leave the button stuck spinning.
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  const { secondsLeft, expired } = useCountdown(qr ? qr.expires_at : null);

  const pngDataUrl = qr ? qr.png_data_url : null;
  const targetUrl = qr ? qr.target_url : null;
  // The hook reports `expired: false` when it has no target, so a payload without
  // an expiry would otherwise sit on "0:00" forever while claiming to be live.
  const hasClock = Boolean(qr && qr.expires_at);
  const canRotate = typeof onRotate === 'function' && Boolean(sessionId);

  const handleRotate = useCallback(async () => {
    if (!canRotate) return;
    setRotating(true);
    try {
      await onRotate();
    } catch (err) {
      // Parents normally route this through `useAsync`, whose `run` never throws;
      // this covers a caller that hands us the API promise directly.
      notifyError(err, 'Could not generate a new code.');
    } finally {
      if (liveRef.current) setRotating(false);
    }
  }, [canRotate, notifyError, onRotate]);

  const busy = Boolean(loading) || rotating;
  const stale = hasClock && expired;
  const warning = hasClock && !expired && secondsLeft <= WARN_SECONDS;
  const status = statusFor({ busy, stale, warning });
  const placeholder = frameCopy({ busy, stale });

  // A rotate forces a new token server-side and the poll replaces this one every
  // 30 s, so anything mid-flight means the pixels on screen are already suspect.
  const showImage = Boolean(pngDataUrl) && !stale && !busy;

  const rotateButton = canRotate ? (
    <Button
      variant="secondary"
      onClick={handleRotate}
      loading={rotating}
      title="Invalidates the code on screen straight away"
    >
      New code
    </Button>
  ) : null;

  // No `qr` means the mode does not use QR check-in, or the session has closed and
  // the backend refuses to mint another token.
  if (!qr && !busy) {
    return (
      <div className="qr-panel">
        <EmptyState
          icon={QR_GLYPH}
          title="No check-in code"
          message="A rotating code appears here while the session is open and its verification mode includes QR."
          action={rotateButton}
        />
      </div>
    );
  }

  return (
    <div className="qr-panel stack">
      <div className="qr-frame">
        {showImage ? (
          // No `key` on the image: React swaps `src` on the same element, so the
          // browser keeps painting the old PNG until the new one has decoded and
          // the projection never flashes white between codes.
          <img className="qr-image" src={pngDataUrl} alt="Check-in QR code for this session" />
        ) : (
          <div className="stack stack-sm text-center">
            <Spinner size="lg" />
            <span className="strong">{placeholder.title}</span>
            <span className="small muted">{placeholder.detail}</span>
          </div>
        )}
      </div>

      {hasClock ? (
        <div className="qr-countdown" role="timer" aria-label="Time until this code refreshes">
          {formatClock(secondsLeft)}
        </div>
      ) : null}

      {hasClock ? (
        // Pure reinforcement for whoever is at the back of the room: the timer
        // above already carries this for a screen reader, and a second
        // progressbar node would only announce the same seconds twice.
        <div aria-hidden="true">
          <ProgressBar
            value={secondsLeft}
            max={ROTATION_SECONDS}
            tone={warning || stale ? 'warn' : 'primary'}
          />
        </div>
      ) : null}

      <div className="qr-meta row between row-wrap">
        <span className="row row-sm row-wrap">
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
          {/* Live region on the sentence, not on the clock: announcing a new
              number every second would make the panel unusable with a screen
              reader, while "wait for the next code" is worth interrupting for. */}
          <span className="small muted" aria-live="polite">
            {status.hint}
          </span>
        </span>
        {rotateButton}
      </div>

      {targetUrl ? (
        <CopyField
          label="Check-in link"
          value={targetUrl}
          hint={
            stale
              ? 'This link has expired with the code above. Send the next one instead.'
              : 'For a phone that cannot focus on the projection. It stops working when the code rotates.'
          }
        />
      ) : null}
    </div>
  );
}
