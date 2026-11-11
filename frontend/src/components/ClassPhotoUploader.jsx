import { useEffect, useRef, useState } from 'react';

import CameraCapture from './CameraCapture.jsx';
import { Alert, Button, StatGrid, StatTile, ErrorState, ProgressBar } from './ui/index.js';
import { SessionsAPI } from '../lib/api.js';
import {
  CLASS_PHOTO_MAX_DIM,
  CameraError,
  dataUrlToFile,
  isCameraSupported,
  prepareImageForUpload,
} from '../lib/camera.js';
import useAsync from '../hooks/useAsync.js';
import { formatBytes, formatConfidence, pluralize } from '../lib/format.js';

/** `MAX_PHOTO_BYTES` in `backend/app/routes/sessions.py`. */
const MAX_PHOTO_BYTES = 16 * 1024 * 1024;

const UPLOAD_ICON = (
  <svg
    width="34"
    height="34"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 15.5V4.5" />
    <path d="M7.75 8.75 12 4.5l4.25 4.25" />
    <path d="M4.5 15.5v2.25a1.75 1.75 0 0 0 1.75 1.75h11.5a1.75 1.75 0 0 0 1.75-1.75V15.5" />
  </svg>
);

/**
 * Warnings from `class_photo.process_class_photo`, matched by substring.
 *
 * The server's warnings are diagnostic ("0 of 24 students have a face
 * enrolled"); these add the action. Substring matching rather than codes because
 * the service emits prose, and a mismatch degrades to showing the server's own
 * text — which is still correct, just terser.
 */
const WARNING_ADVICE = [
  [
    'no faces',
    'Stand further back so more of the room is in frame, and make sure faces are lit from the front rather than backlit by a window.',
  ],
  [
    'enrolled',
    'Students with no face enrolled can never be matched from a photo. Send them to Enroll, or mark them through the roster.',
  ],
  [
    'small',
    'Faces came out below the minimum pixel width. Move closer, or take two photos covering half the room each.',
  ],
];

function adviceFor(warning) {
  const text = String(warning || '').toLowerCase();
  const hit = WARNING_ADVICE.find(([needle]) => text.includes(needle));
  return hit ? hit[1] : null;
}

/**
 * Drop, choose or shoot one class photo; upload it; show what it did.
 *
 * The photo never touches disk on either side — the server reads it into memory,
 * matches, and drops it, and the only pixels that outlive the request are the
 * review-queue crops. This component holds it exactly as long as the upload takes
 * and revokes the preview URL after.
 *
 * A photo is **not** uploaded the moment it is chosen. Upload is capped at 30/hour
 * and one round trip costs seconds of dlib time, so a wrong file picked by mistake
 * would spend a real quantum of the teacher's budget. Preview first, upload on
 * purpose.
 *
 * `onResult(result)` fires after a successful upload so the caller can refresh the
 * live roster and the review queue — this component deliberately knows nothing
 * about either.
 */
export default function ClassPhotoUploader({ sessionId, onResult, disabled = false }) {
  const inputRef = useRef(null);
  const previewRef = useRef('');

  const [source, setSource] = useState('file'); // file | camera
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const [prepError, setPrepError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const upload = useAsync(
    (chosen) => SessionsAPI.uploadPhoto(sessionId, chosen, setProgress),
    {
      onSuccess: (data) => {
        setResult(data);
        clearChoice();
        if (typeof onResult === 'function') onResult(data);
      },
    },
  );

  // An object URL is a document-lifetime reference to the blob. Not revoking it
  // keeps the full-resolution photo alive in memory for as long as the tab is
  // open, which for biometric pixels is exactly the wrong default.
  const setPreviewUrl = (url) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreview(url);
  };

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = '';
    },
    [],
  );

  function clearChoice() {
    setFile(null);
    setPreviewUrl('');
    setProgress(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  const accept = async (chosen) => {
    setPrepError(null);
    setResult(null);
    upload.reset();
    if (!chosen) return;
    try {
      // Downscales anything above ~900 KB to CLASS_PHOTO_MAX_DIM with the EXIF
      // orientation baked in. Skipping it would upload a 6 MB portrait-rotated
      // JPEG that the server then has to rotate itself.
      const prepared = await prepareImageForUpload(chosen, { maxDim: CLASS_PHOTO_MAX_DIM });
      if (prepared.size > MAX_PHOTO_BYTES) {
        throw new CameraError(
          `That photo is ${formatBytes(prepared.size)} even after downscaling, and the limit is ${formatBytes(MAX_PHOTO_BYTES)}. Save it as a JPEG rather than a PNG or HEIC original.`,
          'too_large',
        );
      }
      setFile(prepared);
      setPreviewUrl(URL.createObjectURL(prepared));
    } catch (error) {
      clearChoice();
      setPrepError(
        error instanceof CameraError
          ? error
          : new CameraError('That file could not be read as an image.', 'not_an_image'),
      );
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (dropped) accept(dropped);
  };

  const handleCapture = (dataUrl) => {
    try {
      // Already downscaled by `captureFrame`; `accept` will skip re-encoding it
      // because it lands under the threshold.
      accept(dataUrlToFile(dataUrl, 'class-photo.jpg'));
    } catch (error) {
      setPrepError(
        error instanceof CameraError
          ? error
          : new CameraError('That frame could not be used.', 'bad_data_url'),
      );
    }
  };

  const busy = upload.loading;
  const cameraAvailable = isCameraSupported();

  return (
    <div className="stack">
      {/* Two ways in, because the realistic ones differ by device: a teacher at a
          laptop has the photo on their phone's camera roll, a teacher holding the
          phone has the room in front of them. */}
      <div className="btn-group">
        <Button
          variant={source === 'file' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => {
            setSource('file');
            clearChoice();
          }}
          disabled={busy}
        >
          Choose a photo
        </Button>
        <Button
          variant={source === 'camera' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => {
            setSource('camera');
            clearChoice();
          }}
          disabled={busy || !cameraAvailable}
          title={cameraAvailable ? undefined : 'No camera is available in this browser'}
        >
          Use the camera
        </Button>
      </div>

      {prepError ? (
        <Alert tone="warn" title="That photo could not be used" onClose={() => setPrepError(null)}>
          {prepError.message}
        </Alert>
      ) : null}

      {upload.error ? <ErrorState error={upload.error} title="The photo was not processed" /> : null}

      {/* The preview replaces the picker entirely: once a photo is chosen the only
          two things worth offering are "match it" and "pick another". */}
      {file ? (
        <div className="stack">
          <div className="capture-stage">
            <img className="capture-video" src={preview} alt="The class photo about to be uploaded" />
          </div>
          <div className="row row-wrap between">
            <span className="small muted">
              {formatBytes(file.size)} · downscaled to at most {CLASS_PHOTO_MAX_DIM}px
            </span>
            <div className="row row-sm">
              <Button variant="ghost" size="sm" onClick={clearChoice} disabled={busy}>
                Pick another
              </Button>
              <Button onClick={() => upload.run(file)} loading={busy} disabled={disabled}>
                Match faces
              </Button>
            </div>
          </div>
          {busy ? (
            <ProgressBar
              // Null total means the browser would not report progress; the bar
              // sits at full and the label carries the honest state instead of
              // animating a number nobody measured.
              value={progress === null ? 100 : progress}
              tone="primary"
              label={
                progress === null || progress >= 100
                  ? 'Uploaded — detecting and matching faces. This takes a few seconds.'
                  : `Uploading… ${progress}%`
              }
            />
          ) : null}
        </div>
      ) : source === 'camera' ? (
        <CameraCapture
          samples={[]}
          onCapture={handleCapture}
          maxSamples={1}
          minSamples={1}
          maxDim={CLASS_PHOTO_MAX_DIM}
          // The room, not a face: no mirroring, and different advice.
          mirror={false}
          hint="Frame the whole room from the front, with faces lit from the front rather than backlit by a window. One clear shot beats several rushed ones."
        />
      ) : (
        <>
          <button
            type="button"
            className={dragging ? 'dropzone is-active' : 'dropzone'}
            onClick={() => inputRef.current && inputRef.current.click()}
            onDragOver={(event) => {
              event.preventDefault();
              if (!disabled) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            disabled={disabled || busy}
          >
            <span className="faint">{UPLOAD_ICON}</span>
            <span className="strong">Drop the class photo here, or click to choose</span>
            <span className="small muted">
              JPEG or PNG, up to {formatBytes(MAX_PHOTO_BYTES)}. Large photos are downscaled in the
              browser before upload.
            </span>
          </button>
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept="image/*"
            onChange={(event) => accept(event.target.files && event.target.files[0])}
            disabled={disabled || busy}
          />
        </>
      )}

      {result ? <PhotoResult result={result} onDismiss={() => setResult(null)} /> : null}
    </div>
  );
}

/**
 * What the upload actually did.
 *
 * `newly_marked` is the headline because it is the only number that changed the
 * register. `auto_matched` can exceed it and that is not an error — a student the
 * photo matched who was already checked in by QR is matched but not newly marked.
 */
function PhotoResult({ result, onDismiss }) {
  const faces = Number(result.faces_detected) || 0;
  const marked = Number(result.newly_marked) || 0;
  const review = Number(result.needs_review) || 0;
  const already = Number(result.already_present) || 0;
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const matches = Array.isArray(result.matches) ? result.matches : [];
  const rejected = Array.isArray(result.rejected) ? result.rejected : [];

  return (
    <div className="photo-result">
      <div className="row between">
        <span className="section-title">Result</span>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>

      <StatGrid>
        <StatTile
          label="Faces detected"
          value={faces}
          tone={faces ? 'info' : 'warn'}
          meta={
            result.duration_ms ? `in ${(Number(result.duration_ms) / 1000).toFixed(1)}s` : undefined
          }
        />
        <StatTile
          label="Newly marked"
          value={marked}
          tone={marked ? 'success' : 'muted'}
          meta={already ? `${already} already present` : undefined}
        />
        <StatTile
          label="Needs review"
          value={review}
          tone={review ? 'warn' : 'muted'}
          meta={review ? 'faces to confirm below' : 'nothing to confirm'}
        />
        <StatTile
          label="Face enrolled"
          value={`${result.face_enrolled_count ?? 0} / ${result.roster_size ?? 0}`}
          tone="muted"
          meta="of the roster"
        />
      </StatGrid>

      {/* A photo that detected nothing is the single most common failure, and the
          server's own warnings are the only diagnosis available — the pixels are
          already gone. */}
      {warnings.map((warning) => {
        const advice = adviceFor(warning);
        return (
          <Alert key={warning} tone="warn" title={warning}>
            {advice || 'Adjust and take another photo — this one changed nothing it could not verify.'}
          </Alert>
        );
      })}

      {rejected.length ? (
        <Alert tone="info" title={`${pluralize(rejected.length, 'match')} not applied`}>
          A manual override already decided these students, and a manual decision always wins over a
          photo.
        </Alert>
      ) : null}

      {matches.length ? (
        <div className="stack stack-sm">
          <span className="small muted">
            Matched from this photo, closest first
          </span>
          <div className="match-list">
            {matches.map((match) => (
              <div className="match-row" key={match.student_id}>
                <span className="grow truncate">{match.name}</span>
                <span className="mono small muted">{formatConfidence(match.confidence)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
