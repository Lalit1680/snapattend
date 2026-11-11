import { useEffect, useId, useRef, useState } from 'react';

import { Alert, Button, EmptyState, ProgressBar, Select, Spinner } from './ui/index.js';
import {
  CLASS_PHOTO_MAX_DIM,
  CameraError,
  ENROLLMENT_MAX_DIM,
  captureFrame,
  isCameraSupported,
  isSecureContextForMedia,
  listCameras,
  openCamera,
  stopStream,
} from '../lib/camera.js';
import { SAMPLES } from '../lib/constants.js';
import { pluralize } from '../lib/format.js';

/**
 * Every `CameraError.code` `lib/camera.js` can raise, turned into an instruction.
 *
 * The library's own messages are correct but terse, and two of these failures are
 * unrecoverable without knowing where to click: a blocked permission never
 * re-prompts on its own, and an insecure origin fails identically to "no camera"
 * while being entirely a URL problem.
 */
const FAILURE_HELP = {
  unsupported:
    'This browser cannot open a camera. Use a recent Chrome, Edge, Firefox or Safari, or capture on a phone instead.',
  insecure_context:
    'Browsers only hand over the camera on a secure origin. http://localhost:5173 counts as secure; the same dev server reached by its network address — http://192.168.x.x:5173 — does not, which is why it works on this machine and not on your phone. Use localhost here, or serve the site over HTTPS.',
  permission_denied:
    'Camera access is blocked for this site. Click the camera or lock icon at the left of the address bar and set Camera to Allow, then press Try again. On iPhone or iPad: Settings → Safari → Camera. On Android Chrome: the lock icon → Permissions.',
  no_device:
    'No camera was found. Connect one, or open this page on a phone, then press Try again.',
  device_busy:
    'Another program is holding the camera. Close Zoom, Teams, Meet or any other tab using it, then press Try again.',
  overconstrained:
    'This camera could not produce a usable preview. Pick a different camera if one is listed.',
  not_ready:
    'The preview has not delivered a frame yet. Wait for the picture to appear, then capture again.',
  no_canvas: 'This browser could not turn the preview into an image. Try a different browser.',
  bad_data_url: 'That frame could not be read. Capture it again.',
};

const FAILURE_TITLE = {
  unsupported: 'This browser cannot use a camera',
  insecure_context: 'The camera needs HTTPS or localhost',
  permission_denied: 'Camera permission is blocked',
  no_device: 'No camera found',
  device_busy: 'The camera is in use elsewhere',
  overconstrained: 'That camera could not start',
  not_ready: 'The camera is still warming up',
};

function describeFailure(error) {
  const code = error && error.code;
  return (
    (code && FAILURE_HELP[code]) || (error && error.message) || 'Could not start the camera.'
  );
}

/** Inline rather than an icon package; the contract forbids adding dependencies. */
const CAMERA_ICON = (
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
    <path d="M3.75 8.75A2.5 2.5 0 0 1 6.25 6.25h1.1a1.5 1.5 0 0 0 1.28-.72l.63-1.03a1.5 1.5 0 0 1 1.28-.72h2.92a1.5 1.5 0 0 1 1.28.72l.63 1.03a1.5 1.5 0 0 0 1.28.72h1.1a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 17.75 19.25H6.25a2.5 2.5 0 0 1-2.5-2.5Z" />
    <circle cx="12" cy="12.75" r="3.25" />
  </svg>
);

const NO_CAMERA_ICON = (
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
    <path d="M3.75 8.75A2.5 2.5 0 0 1 6.25 6.25h1.1a1.5 1.5 0 0 0 1.28-.72l.63-1.03a1.5 1.5 0 0 1 1.28-.72h2.92a1.5 1.5 0 0 1 1.28.72l.63 1.03a1.5 1.5 0 0 0 1.28.72h1.1a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 17.75 19.25H6.25a2.5 2.5 0 0 1-2.5-2.5Z" />
    <line x1="3" y1="3" x2="21" y2="21" />
  </svg>
);

/**
 * Live preview, capture button and thumbnail strip for face samples.
 *
 * Owns the `MediaStream` and nothing else: `samples` is an array of JPEG data URL
 * strings held by the caller, `onCapture(dataUrl)` appends one and
 * `onRemove(index)` drops one. The index is the identity because the payload is a
 * 200 KB string with no id of its own, and the enrollment API's 422 rejections are
 * reported by index too (`details.rejections[].index`), so the caller can line the
 * two up without a second convention.
 *
 * The default guidance assumes a face at arm's length. Pass `hint` for anything
 * else — a room shot from the back wall wants different advice.
 */
export default function CameraCapture({
  samples,
  onCapture,
  onRemove,
  maxSamples,
  minSamples,
  maxDim,
  mirror = true,
  hint,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const uid = useId();
  const guidanceId = `${uid}-guidance`;

  const [phase, setPhase] = useState('starting');
  const [failure, setFailure] = useState(null);
  const [captureFailure, setCaptureFailure] = useState(null);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState('');
  const [activeDeviceId, setActiveDeviceId] = useState('');
  const [attempt, setAttempt] = useState(0);

  const supported = isCameraSupported();

  useEffect(() => {
    if (!supported) return undefined;

    let cancelled = false;
    let opened = null;

    setPhase('starting');
    setFailure(null);

    (async () => {
      try {
        const stream = await openCamera({ facingMode: 'user', deviceId: deviceId || null });
        opened = stream;
        if (cancelled) {
          // The cleanup below already ran while getUserMedia was still resolving,
          // so nothing holds this stream and nothing will ever stop it but this.
          stopStream(stream);
          return;
        }
        streamRef.current = stream;

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // iOS will not autoplay a stream it considers unmuted and paints a black
          // box instead. The JSX attribute sets this at mount; re-asserting it here
          // covers the re-attach after a device change.
          video.muted = true;
          const playing = video.play();
          if (playing && typeof playing.catch === 'function') {
            playing.catch(() => {
              /* autoplay policy rejected it; the muted/playsInline attributes are our fix */
            });
          }
        }

        const track = stream.getVideoTracks()[0];
        const settings =
          track && typeof track.getSettings === 'function' ? track.getSettings() : {};
        setActiveDeviceId(settings.deviceId || '');
        setPhase('live');

        // enumerateDevices returns empty labels until permission has been granted,
        // so the picker is built from the list taken *after* the stream opened —
        // a dropdown of "Camera 1 / Camera 2" helps nobody choose.
        const found = await listCameras();
        if (!cancelled) setDevices(found);
      } catch (error) {
        // Covers a throw after the stream opened as well — an exotic browser
        // refusing `srcObject` must not leave the camera running.
        stopStream(opened);
        if (cancelled) return;
        streamRef.current = null;
        setPhase('error');
        setFailure(
          error instanceof CameraError
            ? error
            : new CameraError('Could not start the camera.', 'camera_failed'),
        );
      }
    })();

    return () => {
      cancelled = true;
      // The most important cleanup in this component. A MediaStream that outlives
      // the component leaves the browser's camera indicator lit, which a student
      // reasonably reads as the page still watching them. This runs on unmount, on
      // a device change and before every retry.
      stopStream(streamRef.current || opened);
      streamRef.current = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [supported, deviceId, attempt]);

  const shots = Array.isArray(samples) ? samples : [];
  const ceiling = Number(maxSamples) > 0 ? Math.floor(Number(maxSamples)) : SAMPLES.FACE_MAX;
  const floor = Number(minSamples) > 0 ? Math.floor(Number(minSamples)) : SAMPLES.FACE_MIN;
  // A caller that asks for more samples than it allows would otherwise render a
  // progress bar that can never fill.
  const target = Math.min(floor, ceiling);
  // The server downscales to CLASS_PHOTO_MAX_DIM regardless, so a larger ceiling
  // only inflates the base64 string we hold in memory and post.
  const dimension = Math.min(
    Number(maxDim) > 0 ? Number(maxDim) : ENROLLMENT_MAX_DIM,
    CLASS_PHOTO_MAX_DIM,
  );

  const atMax = shots.length >= ceiling;
  const remaining = Math.max(0, target - shots.length);
  const canCapture = phase === 'live' && !atMax;

  const selected = deviceId || activeDeviceId;
  const knownDevice = devices.some((device) => device.deviceId === selected);

  const handleCapture = () => {
    try {
      // The preview is CSS-mirrored so that moving left looks like moving left,
      // but `mirror` is handed to captureFrame so the *stored* pixels come back
      // un-mirrored. This is the least obvious line in the file: an embedding
      // built from a mirrored face does not match the same person in an
      // un-mirrored class photo, so a student who enrolled from a mirrored frame
      // reads as absent in a room they were sitting in.
      const dataUrl = captureFrame(videoRef.current, { maxDim: dimension, mirror });
      setCaptureFailure(null);
      if (typeof onCapture === 'function') onCapture(dataUrl);
    } catch (error) {
      setCaptureFailure(
        error instanceof CameraError
          ? error
          : new CameraError('That frame could not be captured.', 'camera_failed'),
      );
    }
  };

  const handleRetry = () => {
    // A camera that has been unplugged cannot be retried into working, so a retry
    // also drops an explicit device choice and falls back to whatever the browser
    // offers. `attempt` still changes, so retrying the default camera re-runs too.
    setDeviceId('');
    setCaptureFailure(null);
    setAttempt((count) => count + 1);
  };

  const handleDeviceChange = (event) => {
    setCaptureFailure(null);
    setDeviceId(event.target.value);
  };

  if (!supported) {
    // Chrome hides `navigator.mediaDevices` entirely on an insecure origin, so a
    // teacher opening the dev server at http://192.168.1.20:5173 lands here rather
    // than on the insecure_context error — and "your browser is too old" would send
    // them chasing the wrong thing.
    const originBlocked = !isSecureContextForMedia();
    return (
      <div className="capture">
        <EmptyState
          icon={NO_CAMERA_ICON}
          title={originBlocked ? FAILURE_TITLE.insecure_context : FAILURE_TITLE.unsupported}
          message={originBlocked ? FAILURE_HELP.insecure_context : FAILURE_HELP.unsupported}
        />
      </div>
    );
  }

  const countLabel = `${shots.length} of ${target} captured`;

  let guidance;
  if (remaining > 0) {
    const needed = shots.length
      ? `${pluralize(remaining, 'more shot')} to go`
      : `${pluralize(target, 'shot')} needed`;
    guidance =
      hint ||
      `Face the camera straight on in even light — ${needed}. A slightly different angle each time makes recognition more reliable.`;
  } else if (atMax) {
    guidance = `That is the maximum of ${pluralize(ceiling, 'sample')}. Remove one if you want to retake it.`;
  } else {
    guidance = `Enough captured. You can add ${ceiling - shots.length} more, and extra angles make recognition more reliable.`;
  }

  return (
    <div className="capture">
      <div className="stack">
        <div className="capture-stage">
          <video
            ref={videoRef}
            className="capture-video"
            // All three are load-bearing: without them iOS shows a black box
            // instead of a preview.
            autoPlay
            muted
            playsInline
            aria-label="Live camera preview"
            // Dynamic and prop-driven, and the stylesheet has no mirrored-video
            // class: flipped so that moving left looks like moving left.
            style={mirror ? { transform: 'scaleX(-1)' } : undefined}
          />
          {phase === 'live' ? (
            <div className="capture-overlay" aria-hidden="true">
              <div className="capture-guide" />
            </div>
          ) : (
            <div className="capture-overlay">
              {phase === 'starting' ? (
                <Spinner size="lg" label="Starting the camera…" />
              ) : (
                <span className="small muted">Camera stopped</span>
              )}
            </div>
          )}
        </div>

        {failure ? (
          <Alert
            tone="danger"
            title={FAILURE_TITLE[failure.code] || 'The camera could not start'}
            actions={
              <Button variant="secondary" size="sm" onClick={handleRetry}>
                Try again
              </Button>
            }
          >
            {describeFailure(failure)}
          </Alert>
        ) : null}

        {captureFailure ? (
          <Alert
            tone="warn"
            title={FAILURE_TITLE[captureFailure.code] || 'That shot was not saved'}
            onClose={() => setCaptureFailure(null)}
          >
            {describeFailure(captureFailure)}
          </Alert>
        ) : null}

        {/* One entry is noise: a picker only earns its space when there is a choice. */}
        {devices.length > 1 ? (
          <Select
            label="Camera"
            value={knownDevice ? selected : ''}
            onChange={handleDeviceChange}
            options={devices.map((device) => ({
              value: device.deviceId,
              label: device.label,
            }))}
            placeholder={knownDevice ? undefined : 'Default camera'}
            disabled={phase === 'starting'}
            hint="Switching stops the current camera before opening the new one."
          />
        ) : null}

        <div className="capture-actions">
          <Button
            size="lg"
            icon={CAMERA_ICON}
            onClick={handleCapture}
            disabled={!canCapture}
            aria-describedby={guidanceId}
          >
            {shots.length ? 'Capture another' : 'Capture'}
          </Button>
        </div>

        {/* Announced, because the only other feedback that a capture landed is a new
            thumbnail appearing — which a screen-reader user never sees. */}
        <div className="stack stack-sm" aria-live="polite">
          <ProgressBar
            value={shots.length}
            max={target}
            tone={remaining === 0 ? 'success' : 'primary'}
            label={countLabel}
          />
          <p className="capture-hint" id={guidanceId}>
            {guidance}
          </p>
        </div>

        {shots.length ? (
          <div className="thumb-strip" role="group" aria-label="Captured samples">
            {shots.map((sample, index) => (
              // Position is the only identity these strings have, and the caller
              // removes by index for the same reason. A content-derived key would
              // collide the moment two frames of a still room came out identical.
              <div className="thumb" key={index}>
                <img src={sample} alt={`Captured sample ${index + 1}`} />
                {typeof onRemove === 'function' ? (
                  <button
                    type="button"
                    className="thumb-remove"
                    aria-label={`Remove sample ${index + 1}`}
                    onClick={() => onRemove(index)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
