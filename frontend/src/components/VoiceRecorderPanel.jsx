import { useEffect, useId, useRef, useState } from 'react';

import { Alert, Button, EmptyState, Pill, Spinner } from './ui/index.js';
import {
  RecordingError,
  VoiceRecorder,
  isRecordingSupported,
  isSecureContextForMedia,
} from '../lib/audio.js';
import { AUDIO, SAMPLES } from '../lib/constants.js';
import { formatClock, pluralize } from '../lib/format.js';

/**
 * Every `RecordingError.code` `lib/audio.js` can raise, turned into an instruction.
 *
 * Same reasoning as `CameraCapture`'s table: the library messages are accurate but
 * a blocked permission never re-prompts on its own, and an insecure origin fails
 * in a way that looks exactly like "no microphone" while being purely a URL
 * problem.
 */
const FAILURE_HELP = {
  unsupported:
    'This browser cannot record audio. Use a recent Chrome, Edge, Firefox or Safari, or enroll on a phone instead.',
  insecure_context:
    'Browsers only hand over the microphone on a secure origin. http://localhost:5173 counts as secure; the same dev server reached by its network address — http://192.168.x.x:5173 — does not. Use localhost here, or serve the site over HTTPS.',
  permission_denied:
    'Microphone access is blocked for this site. Click the microphone or lock icon at the left of the address bar and set Microphone to Allow, then press Try again. On iPhone or iPad: Settings → Safari → Microphone.',
  no_device:
    'No microphone was found. Connect one, or open this page on a phone, then press Try again.',
  device_busy:
    'Another program is holding the microphone. Close Zoom, Teams, Meet or any other tab using it, then press Try again.',
  empty_recording: 'The recording came out silent. Check the right microphone is selected and try again.',
  decode_failed:
    'The browser could not read back what it just recorded. Record again; if it keeps happening, try a different browser.',
  already_used: 'That recorder was already used. Press record to start a fresh one.',
};

const FAILURE_TITLE = {
  unsupported: 'This browser cannot record audio',
  insecure_context: 'The microphone needs HTTPS or localhost',
  permission_denied: 'Microphone permission is blocked',
  no_device: 'No microphone found',
  device_busy: 'The microphone is in use elsewhere',
  empty_recording: 'Nothing was recorded',
  decode_failed: 'That recording could not be read',
};

function describeFailure(error) {
  const code = error && error.code;
  return (
    (code && FAILURE_HELP[code]) || (error && error.message) || 'Could not start recording.'
  );
}

const MIC_ICON = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <line x1="12" y1="18" x2="12" y2="21" />
  </svg>
);

const STOP_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </svg>
);

const NO_MIC_ICON = (
  <svg
    width="40"
    height="40"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <line x1="3" y1="3" x2="21" y2="21" />
  </svg>
);

/** ~15 Hz. A level meter animates convincingly at this rate; 60 Hz `setState` does not pay. */
const METER_INTERVAL_MS = 66;

/**
 * Record the passphrase, convert it to what the API accepts, hand it up.
 *
 * `clips` is an array of the clip objects `blobToWavClip` returns — the caller
 * holds them, `onRecorded(clip)` appends one and `onRemove(index)` drops one.
 * Index is the identity for the same reason as in `CameraCapture`: the payload is
 * a large base64 string with no id, and the enrollment API reports its 422
 * rejections by index (`details.rejections[].index`), so the caller can line the
 * two up without inventing a second convention.
 *
 * **This is a toggle, not a press-and-hold.** Holding a button down reads as the
 * more direct gesture, but it fails in ways that leave the microphone live: the
 * pointer slides off the button, the tab loses focus mid-hold, a phone's
 * long-press gesture swallows `pointerup`. A press to start and a press to stop
 * can be driven from the keyboard, survives all of that, and still auto-stops at
 * the server's ceiling.
 */
export default function VoiceRecorderPanel({
  passphrase,
  clips,
  onRecorded,
  onRemove,
  maxClips,
  busy = false,
  buttonLabel,
}) {
  const recorderRef = useRef(null);
  const meterTimerRef = useRef(null);
  const uid = useId();
  const guidanceId = `${uid}-guidance`;

  const [phase, setPhase] = useState('idle'); // idle | starting | recording | converting
  const [failure, setFailure] = useState(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // A clip the pre-flight checks flagged. Held here rather than handed up, so the
  // student gets one chance to redo it before it is spent against a rate limit.
  const [pending, setPending] = useState(null);

  const supported = isRecordingSupported();

  const stopMeter = () => {
    if (meterTimerRef.current) {
      clearInterval(meterTimerRef.current);
      meterTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      // The most important cleanup in this component: an abandoned MediaStream
      // keeps the browser's recording indicator lit, which a student reasonably
      // reads as the page still listening to them.
      stopMeter();
      if (recorderRef.current) {
        recorderRef.current.cancel();
        recorderRef.current = null;
      }
    },
    [],
  );

  const recorded = Array.isArray(clips) ? clips : [];
  const ceiling = Number(maxClips) > 0 ? Math.floor(Number(maxClips)) : SAMPLES.VOICE_MAX;
  const atMax = recorded.length >= ceiling;
  const isRecording = phase === 'recording';
  const isConverting = phase === 'converting';
  // `busy` is the caller's upload in flight. Recording over the top of it would
  // produce a clip with nowhere to go.
  const locked = busy || isConverting || atMax;

  const finish = async (recorder) => {
    setPhase('converting');
    stopMeter();
    try {
      const clip = await recorder.stop();
      setElapsed(clip.seconds);
      setLevel(0);
      if (clip.tooShort || clip.tooQuiet) {
        // Both checks mirror the server's. Failing here costs nothing; failing
        // there costs one of 20 enrollment attempts per hour.
        setPending(clip);
      } else if (typeof onRecorded === 'function') {
        onRecorded(clip);
      }
      setPhase('idle');
    } catch (error) {
      setPhase('idle');
      setLevel(0);
      setFailure(
        error instanceof RecordingError
          ? error
          : new RecordingError('That recording could not be saved.', 'recording_failed'),
      );
    } finally {
      recorderRef.current = null;
    }
  };

  const handleStart = async () => {
    if (locked || isRecording) return;
    setFailure(null);
    setPending(null);
    setElapsed(0);
    setLevel(0);
    setPhase('starting');

    // `onAutoStop` fires at MAX_CLIP_SECONDS. It converts through the same path as
    // a manual stop, so a clip that ran long is still usable rather than lost.
    const recorder = new VoiceRecorder({
      onAutoStop: () => {
        if (recorderRef.current === recorder && recorder.isRecording) finish(recorder);
      },
    });

    try {
      await recorder.start();
    } catch (error) {
      setPhase('idle');
      setFailure(
        error instanceof RecordingError
          ? error
          : new RecordingError('Could not start recording.', 'recording_failed'),
      );
      return;
    }

    recorderRef.current = recorder;
    setPhase('recording');
    meterTimerRef.current = setInterval(() => {
      setLevel(recorder.level());
      setElapsed(recorder.elapsed);
    }, METER_INTERVAL_MS);
  };

  const handleStop = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.isRecording) finish(recorder);
  };

  const handleRetry = () => {
    setFailure(null);
    setPending(null);
  };

  const acceptPending = () => {
    if (pending && typeof onRecorded === 'function') onRecorded(pending);
    setPending(null);
  };

  if (!supported) {
    // Chrome hides `navigator.mediaDevices` entirely on an insecure origin, so a
    // student on the dev server's LAN address lands here rather than on the
    // insecure_context error — and "your browser is too old" sends them chasing
    // the wrong thing.
    const originBlocked = !isSecureContextForMedia();
    return (
      <div className="capture">
        <EmptyState
          icon={NO_MIC_ICON}
          title={originBlocked ? FAILURE_TITLE.insecure_context : FAILURE_TITLE.unsupported}
          message={originBlocked ? FAILURE_HELP.insecure_context : FAILURE_HELP.unsupported}
        />
      </div>
    );
  }

  let guidance;
  if (atMax) {
    guidance = `That is the maximum of ${pluralize(ceiling, 'recording')}. Remove one if you want to redo it.`;
  } else if (isRecording) {
    guidance = `Recording — say the passphrase at a normal speaking volume, then press stop. Recording stops on its own after ${Math.round(AUDIO.MAX_CLIP_SECONDS)} seconds.`;
  } else {
    guidance = `Somewhere quiet, hold the device about a hand's width away and read the passphrase aloud at your normal speaking volume. At least ${AUDIO.MIN_VOICED_SECONDS} seconds of speech is needed.`;
  }

  return (
    <div className="capture">
      <div className="stack">
        {passphrase ? (
          <div className="stack stack-sm">
            <span className="small muted">Read this aloud</span>
            <p className="code-block">{passphrase}</p>
          </div>
        ) : null}

        {failure ? (
          <Alert
            tone="danger"
            title={FAILURE_TITLE[failure.code] || 'Recording could not start'}
            actions={
              <Button variant="secondary" size="sm" onClick={handleRetry}>
                Try again
              </Button>
            }
          >
            {describeFailure(failure)}
          </Alert>
        ) : null}

        {/* The one clip the student is asked to judge for themselves. Uploading it
            would very likely come back a 422, so the choice is offered before the
            round trip rather than after it. */}
        {pending ? (
          <Alert
            tone="warn"
            title={pending.tooShort ? 'That was too short' : 'That was very quiet'}
            actions={
              <>
                <Button variant="primary" size="sm" onClick={handleRetry}>
                  Record again
                </Button>
                <Button variant="ghost" size="sm" onClick={acceptPending}>
                  Use it anyway
                </Button>
              </>
            }
          >
            {pending.tooShort
              ? `Only ${pending.voicedSeconds.toFixed(1)}s of speech was detected and at least ${AUDIO.MIN_VOICED_SECONDS}s is needed. Read the whole passphrase, and start speaking just after you press record.`
              : 'The recording is barely above silence, so the voice check is unlikely to succeed. Move somewhere quieter, closer to the microphone, and speak up.'}
          </Alert>
        ) : null}

        <div className="capture-actions">
          {isRecording ? (
            <Button
              size="lg"
              variant="danger"
              icon={STOP_ICON}
              onClick={handleStop}
              aria-describedby={guidanceId}
            >
              Stop recording
            </Button>
          ) : (
            <Button
              size="lg"
              icon={MIC_ICON}
              onClick={handleStart}
              loading={phase === 'starting' || isConverting}
              disabled={locked}
              aria-describedby={guidanceId}
            >
              {buttonLabel || (recorded.length ? 'Record another' : 'Record')}
            </Button>
          )}
          {isRecording ? (
            <span className="qr-countdown" aria-hidden="true">
              {formatClock(elapsed)}
            </span>
          ) : null}
          {isConverting ? <Spinner size="sm" label="Processing the recording…" /> : null}
        </div>

        {/* Only while live. A frozen meter at zero looks like a broken microphone. */}
        {isRecording ? (
          <div className="stack stack-sm">
            <div className="level-meter" role="presentation">
              {/* Width is live amplitude — the one legitimate inline style here. */}
              <span className="level-fill" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <p className="capture-hint">
              {level < 0.04
                ? 'Not hearing much — speak up, or check the right microphone is selected.'
                : 'Good level.'}
            </p>
          </div>
        ) : null}

        {/* Announced, because otherwise the only feedback that a clip landed is a
            new row appearing, which a screen-reader user never sees. */}
        <div aria-live="polite">
          <p className="capture-hint" id={guidanceId}>
            {guidance}
          </p>
        </div>

        {recorded.length ? (
          <div className="stack stack-sm" role="group" aria-label="Recorded clips">
            {recorded.map((clip, index) => (
              // Position is the only identity these clips have, and the caller
              // removes by index for the same reason.
              <div className="row between" key={index}>
                <div className="row row-sm grow">
                  <span className="strong small">Recording {index + 1}</span>
                  <Pill tone={clip.tooShort ? 'warn' : 'success'}>
                    {clip.voicedSeconds.toFixed(1)}s of speech
                  </Pill>
                  {/* Native controls: playback is the only way a student can tell
                      whether the microphone picked up their voice or the room. */}
                  <audio className="grow" src={clip.dataUrl} controls preload="metadata" />
                </div>
                {typeof onRemove === 'function' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemove(index)}
                    disabled={busy}
                    aria-label={`Remove recording ${index + 1}`}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
