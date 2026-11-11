import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

import CameraCapture from '../../components/CameraCapture.jsx';
import VoiceRecorderPanel from '../../components/VoiceRecorderPanel.jsx';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  LoadingBlock,
  Pill,
  Tabs,
} from '../../components/ui/index.js';
import { EnrollAPI } from '../../lib/api.js';
import { AUDIO, ENROLLMENT_STATUS_LABELS, ErrorCode, SAMPLES } from '../../lib/constants.js';
import { pluralize } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import useAsync from '../../hooks/useAsync.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';

/**
 * Every `reason` `enroll_face_samples` can attach to a frame it threw away, turned
 * into the thing to change before retaking it.
 *
 * The pipeline's own messages are mostly instructions already ("Move closer to the
 * camera"), but three of them — `decode_failed`, `encode_failed`, `too_dark` —
 * describe what the server saw rather than what to do about it, and a student
 * holding a webcam needs the second thing.
 */
const FACE_REJECTIONS = {
  no_face:
    'No face was found in that frame. Look straight at the lens with your whole face inside the guide.',
  multiple_faces:
    'More than one face was in the frame. Only you can be in shot — a face on a poster, or on a screen behind you, counts as one.',
  face_too_small:
    'Your face was too small in the frame. Move closer, until it fills roughly a third of the preview.',
  too_dark:
    'Too dark to read. Turn to face a window or a lamp rather than having it behind you.',
  too_blurry:
    'That frame was blurry. Hold the device still, give the camera a second to focus, then capture.',
  decode_failed:
    'The server could not read that image at all. Retake it; if every frame fails this way, try a different browser.',
  encode_failed:
    'A face was found but its features could not be measured. Retake with more even light and nothing across your face.',
};

/**
 * The page's own frame.
 *
 * `/enroll` renders outside `AppShell` — it is a public invite target, and
 * `components/layout/Sidebar.jsx` says as much — so nothing above it supplies the
 * padding a `.page` expects; `.app-content` is where that padding lives. `.auth-card`
 * was the other candidate and is 420px wide, narrower than a usable camera preview.
 */
function EnrollShell({ children }) {
  return (
    <main className="app-content">
      <div className="page">{children}</div>
    </main>
  );
}

/**
 * Enrolling a face and a voice.
 *
 * This route is the first thing a new student ever opens: `services/invites.py:42`
 * points a student's invitation email at `/enroll?token=…`, before they have a
 * password. It does not accept the invite itself — `pages/auth/AcceptInvite.jsx`
 * already validates a token, sets the password and sends `next_step ===
 * 'biometrics'` back here — so an anonymous visitor holding a token is forwarded
 * there rather than shown a second copy of that form.
 */
export default function EnrollPage() {
  useDocumentTitle('Enrollment');
  const { user, initializing, isStudent, homePath } = useAuth();
  const [searchParams] = useSearchParams();
  const token = (searchParams.get('token') || '').trim();

  if (initializing) {
    return (
      <EnrollShell>
        <LoadingBlock label="Checking your session…" />
      </EnrollShell>
    );
  }

  if (!user) {
    return <Navigate replace to={signInPathFor(token)} />;
  }

  if (!isStudent) {
    // `GET /api/enroll/status` is `role_required(Role.STUDENT)`, so there is nothing
    // here to render for staff and no request worth making.
    return (
      <EnrollShell>
        <Card title="Enrollment is a student's own screen">
          <div className="stack-sm">
            <p className="small muted">
              Face and voice samples can only be recorded by the person they belong to, so this page
              has nothing to show a teacher or an administrator. To let a student record theirs
              again, open that student and press Reset on their Biometric enrollment card.
            </p>
            <div className="row row-sm">
              <Link className="btn btn-secondary" to={homePath()}>
                Back to your dashboard
              </Link>
            </div>
          </div>
        </Card>
      </EnrollShell>
    );
  }

  // A signed-in student who followed a stale invite link simply gets the wizard: the
  // token has done its job and re-validating it would only produce a "already used"
  // error on a page that is otherwise working.
  return (
    <EnrollShell>
      <EnrollWizard />
    </EnrollShell>
  );
}

/**
 * Where an anonymous visitor goes.
 *
 * With a token, to the page that turns it into an account. Without one, to sign-in
 * with `?next=` so they land back here — `Login` reads that param and
 * `safeNext` keeps it to a local path.
 */
function signInPathFor(token) {
  if (token) return `/accept-invite?token=${encodeURIComponent(token)}`;
  return `/login?next=${encodeURIComponent('/enroll')}`;
}

/**
 * The wizard proper, mounted only once a student is known.
 *
 * Every data hook lives here rather than in `EnrollPage` so those gates can return
 * early without moving the order of anything React is counting.
 */
function EnrollWizard() {
  const { refreshUser } = useAuth();
  const status = useResource(() => EnrollAPI.status(), []);
  const roster = useResource(() => EnrollAPI.subjects(), []);
  const [chosen, setChosen] = useState('');

  const data = status.data;
  const steps = (data && data.steps) || [];
  const face = steps.find((step) => step.key === 'face') || null;
  const voice = steps.find((step) => step.key === 'voice') || null;

  // Re-read the steps, and the session with them: `user.student` was serialised at
  // sign-in, so the dashboard's "your face is not enrolled yet" banner would go on
  // saying that to a student who has just this second enrolled.
  const onEnrolled = () => {
    status.reload();
    refreshUser();
  };

  // The unfinished step, until the student picks one for themselves. Derived rather
  // than parked in an effect: an effect would have to run when `status` resolves,
  // and would then move the tab out from under a click that came first.
  const active = chosen || (face && !face.done ? 'face' : 'voice');

  if (status.error && !data) {
    return (
      <ErrorState
        error={status.error}
        onRetry={status.reload}
        title="Could not read your enrollment"
      />
    );
  }

  if (!data) return <LoadingBlock label="Checking what you have already recorded…" />;

  return (
    <>
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Enroll your face and voice</h1>
          <p className="page-sub">
            Once, and the register looks after itself afterwards: a class photo finds your face, or
            you read a phrase aloud to check in.
          </p>
        </div>
        <div className="page-actions">
          <Badge tone={data.complete ? 'success' : 'warn'}>
            {ENROLLMENT_STATUS_LABELS[data.enrollment_status] || 'Not enrolled'}
          </Badge>
          <Link className="btn btn-secondary" to="/student">
            {data.complete ? 'Back to your dashboard' : 'Finish this later'}
          </Link>
        </div>
      </div>

      {data.complete ? <AllDone /> : null}

      <Card
        title="Two recordings, one of each"
        subtitle="A session verifies by photo, by voice or by a code. The first two need something of yours on file."
      >
        <div className="stack">
          <Tabs
            tabs={[
              { key: 'face', label: 'Your face', badge: face && face.done ? 'on file' : 'needed' },
              {
                key: 'voice',
                label: 'Your voice',
                badge: voice && voice.done ? 'on file' : 'needed',
              },
            ]}
            active={active}
            onChange={setChosen}
          />
          {/* Mounted one at a time on purpose. Both children hold a live device —
              the camera and the microphone — and a hidden panel keeping the
              browser's recording indicator lit reads as the page watching you. */}
          {active === 'voice' ? (
            <VoiceStep
              step={voice}
              range={data.voice_sample_range}
              audio={data.audio_requirements}
              passphrase={data.passphrase}
              onEnrolled={onEnrolled}
            />
          ) : (
            <FaceStep step={face} range={data.face_sample_range} onEnrolled={onEnrolled} />
          )}
        </div>
      </Card>

      <WhatItIsFor roster={roster} />
      <StartOver steps={steps} onReset={onEnrolled} />
    </>
  );
}

/** Both vectors are in the index. The only thing left to do is turn up. */
function AllDone() {
  return (
    <Alert tone="success" title="You are enrolled">
      <p>
        Your face and your voice are both on file. Nothing else is needed from you — attend, and a
        class photo or a check-in does the rest.
      </p>
      <div className="row row-sm row-wrap">
        <Link className="btn btn-sm btn-primary" to="/student/check-in">
          See what is open now
        </Link>
        <Link className="btn btn-sm btn-secondary" to="/student/attendance">
          Your record
        </Link>
      </div>
    </Alert>
  );
}

/**
 * What the samples are for, in the student's own terms.
 *
 * `GET /api/enroll/subjects` exists for this one paragraph. Enrolling does not
 * depend on a roster, so an empty list is a note and not a warning.
 */
function WhatItIsFor({ roster }) {
  const subjects = (roster.data && roster.data.subjects) || [];

  return (
    <Card title="Where this gets used">
      <div className="stack-sm">
        {subjects.length ? (
          <>
            <span className="small muted">
              {pluralize(subjects.length, 'subject')} of yours can recognise you once these are on
              file:
            </span>
            <div className="row row-sm row-wrap">
              {subjects.map((subject) => (
                <Pill key={subject.id}>
                  {subject.name || 'Unknown subject'}
                  {subject.code ? ` · ${subject.code}` : ''}
                </Pill>
              ))}
            </div>
          </>
        ) : (
          <span className="small muted">
            You are not on any subject&apos;s roster yet. Recording now still works, and means there
            is nothing to do on the day a teacher adds you.
          </span>
        )}
        <div className="divider" />
        <p className="small faint">
          What is kept is a list of numbers derived from these recordings, not the recordings
          themselves: the frames and the audio are decoded, measured, and gone when the request that
          carried them ends. Nobody, your teachers included, can play them back.
        </p>
      </div>
    </Card>
  );
}

/** `samples_accepted`, which both enrollment responses carry. */
function accepted(result) {
  return (result && result.samples_accepted) || 0;
}

/**
 * Two to five frames, averaged into one vector.
 *
 * The camera stays off for a student who has already enrolled: arriving on a
 * finished step lights no webcam indicator until they ask to retake, because
 * somebody who came only to check is not asking to be filmed.
 */
function FaceStep({ step, range, onEnrolled }) {
  const toast = useToast();
  const [frames, setFrames] = useState([]);
  const [replacing, setReplacing] = useState(false);

  const min = (range && range.min) || SAMPLES.FACE_MIN;
  const max = (range && range.max) || SAMPLES.FACE_MAX;

  const submit = useAsync((samples) => EnrollAPI.submitFace(samples), {
    onSuccess: (result) => {
      setFrames([]);
      setReplacing(false);
      toast.success(`Face enrolled from ${pluralize(accepted(result), 'frame')}.`);
      onEnrolled();
    },
  });

  // A 422 reports `details.rejections[].index` against the array that was sent, so
  // dropping a frame renumbers them all. Clearing the error is honest and cheaper
  // than trying to keep the two in step.
  const removeFrame = (index) => {
    submit.reset();
    setFrames((current) => current.filter((_, position) => position !== index));
  };

  if (step && step.done && !replacing) {
    return (
      <OnFile
        detail={step.detail}
        note="Retaking replaces the measurement on file, so there is nothing to delete first."
        buttonLabel="Retake my face samples"
        onReplace={() => setReplacing(true)}
      />
    );
  }

  return (
    <div className="stack">
      {step && step.drift ? <DriftAlert modality="face" /> : null}
      {submit.error ? <SubmitFailure error={submit.error} modality="face" /> : null}

      {/* No `busy` prop to pass: capturing during an upload is harmless, because
          the frames that were sent are the array `submit.run` already closed over. */}
      <CameraCapture
        samples={frames}
        onCapture={(dataUrl) => setFrames((current) => current.concat(dataUrl))}
        onRemove={removeFrame}
        minSamples={min}
        maxSamples={max}
      />

      <div className="row between row-wrap">
        <span className="small muted">
          All of them are measured together and averaged into one number, so a frame you are not
          happy with is worth removing rather than sending.
        </span>
        <Button
          onClick={() => submit.run(frames)}
          loading={submit.loading}
          disabled={frames.length < min}
        >
          Enroll my face
        </Button>
      </div>
    </div>
  );
}

/**
 * One to three passphrase recordings.
 *
 * `VoiceRecorderPanel` owns the microphone, the WAV conversion and the two
 * pre-flight checks that mirror the server's, so this only decides when there is
 * enough to send. A second clip is a real improvement rather than a spare: two are
 * cross-checked against each other server side and the pair is refused if they do
 * not sound like one speaker.
 */
function VoiceStep({ step, range, audio, passphrase, onEnrolled }) {
  const toast = useToast();
  const [clips, setClips] = useState([]);
  const [replacing, setReplacing] = useState(false);

  const min = (range && range.min) || SAMPLES.VOICE_MIN;
  const max = (range && range.max) || SAMPLES.VOICE_MAX;
  const minSpeech = (audio && audio.min_voiced_seconds) || AUDIO.MIN_VOICED_SECONDS;

  const submit = useAsync((samples) => EnrollAPI.submitVoice(samples), {
    onSuccess: (result) => {
      setClips([]);
      setReplacing(false);
      toast.success(`Voice enrolled from ${pluralize(accepted(result), 'recording')}.`);
      onEnrolled();
    },
  });

  const removeClip = (index) => {
    submit.reset();
    setClips((current) => current.filter((_, position) => position !== index));
  };

  if (step && step.done && !replacing) {
    return (
      <OnFile
        detail={step.detail}
        note="Recording again replaces what is on file. Worth doing if a cold, or a new microphone, has been making voice check-in fail."
        buttonLabel="Record my passphrase again"
        onReplace={() => setReplacing(true)}
      />
    );
  }

  return (
    <div className="stack">
      {step && step.drift ? <DriftAlert modality="voice" /> : null}
      {submit.error ? <SubmitFailure error={submit.error} modality="voice" /> : null}

      <VoiceRecorderPanel
        passphrase={passphrase || ''}
        clips={clips}
        onRecorded={(clip) => setClips((current) => current.concat(clip))}
        onRemove={removeClip}
        maxClips={max}
        busy={submit.loading}
      />

      <div className="row between row-wrap">
        <span className="small muted">
          At least {minSpeech} seconds of speech in each, and one careful recording beats three
          rushed ones — a pair that does not sound like the same person is refused outright.
        </span>
        <Button
          onClick={() => submit.run(clips.map((clip) => clip.dataUrl))}
          loading={submit.loading}
          disabled={clips.length < min}
        >
          Enroll my voice
        </Button>
      </div>
    </div>
  );
}

/**
 * A step that is already done.
 *
 * `detail` is the server's own count of what is stored, shown as it wrote it: it is
 * the only report of that number anywhere, and recomposing it here would let this
 * page disagree with the record.
 */
function OnFile({ detail, note, buttonLabel, onReplace }) {
  return (
    <div className="stack-sm">
      <div className="row row-sm row-wrap">
        <Badge tone="success" dot>
          On file
        </Badge>
        {detail ? <span className="small muted">{detail}</span> : null}
      </div>
      <p className="small muted">{note}</p>
      <div className="row row-sm">
        <Button variant="secondary" onClick={onReplace}>
          {buttonLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * The one case `enrollment_progress` goes to Chroma to catch.
 *
 * A step is done only when the flag *and* the vector agree, read back rather than
 * trusted, so a vector deleted out of band surfaces here as "record it again"
 * instead of as recognition that quietly stops working. Same wording as the account
 * page, because it is the same condition.
 */
function DriftAlert({ modality }) {
  return (
    <Alert tone="warn" title={`Your ${modality} record is out of step with the index`}>
      Your record says you enrolled, but the matching vector is missing from the index, so there is
      nothing left to compare against. Recording again puts it back and takes a minute.
    </Alert>
  );
}

/**
 * A refused submission, answered with the thing to do about it.
 *
 * The four outcomes are four different actions — retake, wait, tell a teacher, drop
 * one sample — and `error.message` alone would make all four look like the same red
 * box. A 422 in particular is not a failure of the request: it means the content was
 * read and could not be used, so it says what was wrong with which sample.
 */
function SubmitFailure({ error, modality }) {
  const details = error.details || {};
  const rejections = Array.isArray(details.rejections) ? details.rejections : [];
  const measured = typeof details.accepted_samples === 'number' ? details.accepted_samples : null;
  const needed = typeof details.required_samples === 'number' ? details.required_samples : null;

  if (error.code === ErrorCode.UNPROCESSABLE) {
    return (
      <Alert
        tone="warn"
        title={modality === 'face' ? 'Those frames could not be used' : 'That recording could not be used'}
      >
        <p>{error.message}</p>
        <p className="small muted">
          {measured === 0
            ? 'Nothing was stored and your record is unchanged.'
            : measured !== null && needed !== null && measured < needed
              ? `Only ${measured} of them could be measured and ${needed} are needed. Your record is unchanged.`
              : 'Nothing was stored, so your record is unchanged.'}
        </p>
        <RejectionList rejections={rejections} />
      </Alert>
    );
  }

  if (
    error.code === ErrorCode.FACE_PIPELINE_UNAVAILABLE ||
    error.code === ErrorCode.VOICE_PIPELINE_UNAVAILABLE
  ) {
    return (
      <Alert tone="danger" title={`${modality === 'face' ? 'Face' : 'Voice'} enrollment is unavailable`}>
        <p>
          The server could not load the model that turns a recording into a measurement. There is
          nothing wrong with what you sent, and nothing you can do about it from here.
        </p>
        <p className="small muted">
          Tell your teacher — they can mark you present by hand in the meantime — and try again later.
        </p>
      </Alert>
    );
  }

  if (error.code === ErrorCode.RATE_LIMITED) {
    return (
      <Alert tone="warn" title="Too many attempts">
        <p>
          Enrollment allows twenty submissions an hour. Each one runs the recognition models over
          every sample, which is why there is a ceiling at all — it is far more than enrolling needs.
        </p>
        <p className="small muted">
          {error.retryAfter
            ? `Try again in ${pluralize(error.retryAfter, 'second')}. What you recorded is still here.`
            : 'Wait a few minutes and send the same samples again — they are still here.'}
        </p>
      </Alert>
    );
  }

  // `_decode_samples` reports the sample it choked on as a zero-based `index`, which
  // is worth translating: the strip below numbers from one.
  const index = typeof details.index === 'number' ? details.index : null;

  return (
    <Alert tone="danger" title="That could not be sent">
      <p>{error.message}</p>
      {index !== null ? (
        <p className="small muted">
          It was number {index + 1} below. Remove that one and send the rest.
        </p>
      ) : null}
    </Alert>
  );
}

/**
 * Which sample was thrown out and why, numbered to match the strip below it.
 *
 * The face pipeline's `reason` is a stable code and its own message is a single
 * clause, so `FACE_REJECTIONS` answers it with something to change. Voice has one
 * reason — `unusable_audio` — and puts the specifics in the message, so that one is
 * shown as the server wrote it.
 */
function RejectionList({ rejections }) {
  if (!rejections.length) return null;

  return (
    <div className="stack-sm">
      {rejections.map((rejection) => (
        <div className="row row-sm row-wrap" key={`${rejection.index}-${rejection.reason}`}>
          <Pill tone="warn">Number {Number(rejection.index) + 1}</Pill>
          <span className="small muted">
            {FACE_REJECTIONS[rejection.reason] || rejection.message || 'That one could not be used.'}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Deleting what is on file.
 *
 * `POST /api/enroll/reset` needs no reason — it is a student acting on their own
 * data, though it is still audited — and this is the only screen that offers it.
 * Retaking does not need it, because both writes are upserts, so this is here for
 * the student who wants the measurements gone rather than replaced.
 */
function StartOver({ steps, onReset }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);

  const reset = useAsync(() => EnrollAPI.reset({ face: true, voice: true }), {
    onSuccess: () => {
      setAsking(false);
      toast.success('Your face and voice measurements have been deleted.');
      onReset();
    },
    onError: (error) => {
      setAsking(false);
      toast.notifyError(error);
    },
  });

  // Nothing to delete, nothing to offer. `drift` counts: the flag is still set, so
  // the reset is what clears it.
  if (!steps.some((step) => step.done || step.drift)) return null;

  return (
    <Card title="Delete what is on file">
      <div className="row between row-wrap">
        <span className="small muted">
          The measurements are removed from the index and your enrollment goes back to pending.
          Attendance already recorded against you is untouched — this is about being recognised from
          here on, not about the register.
        </span>
        <Button variant="secondary" onClick={() => setAsking(true)}>
          Delete my face and voice data
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        tone="danger"
        title="Delete your face and voice measurements?"
        confirmLabel="Delete them"
        busy={reset.loading}
        onConfirm={() => reset.run()}
        onCancel={() => setAsking(false)}
      >
        <p>
          Until you record again a class photo cannot find you and a voice session will turn you
          away, so a teacher would have to mark you by hand. You can record again immediately
          afterwards.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

