/**
 * Microphone capture and WAV conversion.
 *
 * This is the file `backend/app/routes/enroll.py` points at. The server decodes
 * audio with `soundfile`, which reads WAV/FLAC/OGG but **not** WebM/Opus -- and
 * MediaRecorder produces WebM/Opus almost everywhere. Rather than make the
 * deployment depend on ffmpeg, the conversion happens here:
 *
 *   MediaRecorder (WebM/Opus)
 *     -> decodeAudioData        (browser's own codec)
 *     -> OfflineAudioContext    (downmix to mono, resample to 16 kHz)
 *     -> 16-bit PCM WAV         (44-byte header + samples)
 *     -> data URL               (what the API accepts)
 *
 * 16 kHz mono is not arbitrary: it is what Resemblyzer expects, so converting to
 * it here means the server never resamples and the two sides cannot disagree
 * about what was recorded.
 */
import { AUDIO } from './constants.js';

const TARGET_RATE = AUDIO.SAMPLE_RATE;

export class RecordingError extends Error {
  constructor(message, code = 'recording_failed') {
    super(message);
    this.name = 'RecordingError';
    this.code = code;
  }
}

// --------------------------------------------------------------------------- //
// Capability detection
// --------------------------------------------------------------------------- //
export function isRecordingSupported() {
  return Boolean(
    typeof window !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window.MediaRecorder === 'function' &&
      (window.AudioContext || window.webkitAudioContext),
  );
}

/**
 * getUserMedia only works on a secure origin. localhost counts as secure, which
 * is why the dev server on 5173 works without TLS -- but a phone hitting the dev
 * server by LAN IP does not, and that failure is otherwise baffling.
 */
export function isSecureContextForMedia() {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4', // Safari
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function describeMediaError(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecordingError(
      'Microphone access was blocked. Allow it in your browser’s address bar and try again.',
      'permission_denied',
    );
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new RecordingError('No microphone was found on this device.', 'no_device');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return new RecordingError(
      'The microphone is in use by another application. Close it and try again.',
      'device_busy',
    );
  }
  return new RecordingError(
    (error && error.message) || 'Could not start recording.',
    'recording_failed',
  );
}

// --------------------------------------------------------------------------- //
// Recorder
// --------------------------------------------------------------------------- //
/**
 * A single-use microphone recorder.
 *
 * ```js
 * const recorder = new VoiceRecorder({ maxSeconds: 12, onAutoStop: handleStop });
 * await recorder.start();
 * // ... later
 * const clip = await recorder.stop();   // { dataUrl, seconds, voicedSeconds }
 * ```
 *
 * Always call {@link VoiceRecorder#cancel} on unmount: an abandoned MediaStream
 * keeps the browser's recording indicator lit, which users reasonably read as the
 * page still listening to them.
 */
export class VoiceRecorder {
  constructor({ maxSeconds = AUDIO.MAX_CLIP_SECONDS, onAutoStop = null } = {}) {
    this.maxSeconds = Math.min(Number(maxSeconds) || AUDIO.MAX_CLIP_SECONDS, AUDIO.MAX_CLIP_SECONDS);
    this.onAutoStop = onAutoStop;
    this.chunks = [];
    this.stream = null;
    this.recorder = null;
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.audioContext = null;
    this.analyser = null;
    this.levelBuffer = null;
    this.autoStopTimer = null;
    this.state = 'idle'; // idle | recording | stopping | stopped | cancelled
  }

  get isRecording() {
    return this.state === 'recording';
  }

  /** Seconds elapsed, for a live counter. */
  get elapsed() {
    if (!this.startedAt) return 0;
    const end = this.stoppedAt || Date.now();
    return (end - this.startedAt) / 1000;
  }

  /** Current input level, 0..1, for a level meter. Cheap enough to poll on a frame. */
  level() {
    if (!this.analyser || !this.levelBuffer) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (let i = 0; i < this.levelBuffer.length; i += 1) {
      const deviation = (this.levelBuffer[i] - 128) / 128;
      sum += deviation * deviation;
    }
    const rms = Math.sqrt(sum / this.levelBuffer.length);
    // Light compression: raw RMS from a quiet room barely moves a meter.
    return Math.min(1, rms * 3.2);
  }

  async start() {
    if (!isRecordingSupported()) {
      throw new RecordingError(
        'This browser cannot record audio. Try a recent Chrome, Edge or Firefox.',
        'unsupported',
      );
    }
    if (!isSecureContextForMedia()) {
      throw new RecordingError(
        'Microphone access needs a secure connection (HTTPS or localhost).',
        'insecure_context',
      );
    }
    if (this.state !== 'idle') {
      throw new RecordingError('This recorder has already been used.', 'already_used');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw describeMediaError(error);
    }

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctx();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 1024;
      this.levelBuffer = new Uint8Array(this.analyser.fftSize);
      source.connect(this.analyser);
      // Not connected to destination on purpose — that would echo the mic to the
      // speakers and feed back.
    } catch {
      this.analyser = null; // a missing level meter is not worth failing over
    }

    const mimeType = pickMimeType();
    try {
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      this.#releaseStream();
      throw describeMediaError(error);
    }

    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) this.chunks.push(event.data);
    };
    this.recorder.start();
    this.startedAt = Date.now();
    this.state = 'recording';

    // Hard stop at the server's ceiling. Uploading a longer clip would just be
    // truncated server-side, so there is nothing to gain by letting it run.
    this.autoStopTimer = setTimeout(() => {
      if (this.state === 'recording' && typeof this.onAutoStop === 'function') {
        this.onAutoStop();
      } else if (this.state === 'recording' && this.recorder) {
        try {
          this.recorder.stop();
        } catch {
          /* already stopping */
        }
      }
    }, this.maxSeconds * 1000);

    return this;
  }

  /** Stop recording and return the converted clip. */
  async stop() {
    if (this.state !== 'recording') {
      throw new RecordingError('Not currently recording.', 'not_recording');
    }
    this.state = 'stopping';
    clearTimeout(this.autoStopTimer);

    const blob = await new Promise((resolve, reject) => {
      this.recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' }));
      };
      this.recorder.onerror = (event) =>
        reject(new RecordingError((event.error && event.error.message) || 'Recording failed.'));
      try {
        if (this.recorder.state !== 'inactive') this.recorder.stop();
        else
          resolve(new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' }));
      } catch (error) {
        reject(describeMediaError(error));
      }
    });

    this.stoppedAt = Date.now();
    this.#releaseStream();
    this.state = 'stopped';

    if (!blob.size) {
      throw new RecordingError('The recording came out empty. Try again.', 'empty_recording');
    }
    return blobToWavClip(blob);
  }

  /** Abandon the recording and release the microphone. Safe to call any time. */
  cancel() {
    clearTimeout(this.autoStopTimer);
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    this.chunks = [];
    this.#releaseStream();
    this.state = 'cancelled';
  }

  #releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.analyser = null;
    this.levelBuffer = null;
  }
}

// --------------------------------------------------------------------------- //
// Conversion
// --------------------------------------------------------------------------- //
/**
 * Convert a recorded blob into the clip shape the API accepts.
 *
 * @returns {Promise<{dataUrl: string, seconds: number, voicedSeconds: number,
 *   sampleRate: number, bytes: number, tooShort: boolean, tooQuiet: boolean}>}
 */
export async function blobToWavClip(blob) {
  const samples = await decodeToMono16k(blob);
  const seconds = samples.length / TARGET_RATE;
  const voicedSeconds = estimateVoicedSeconds(samples);
  const wav = encodeWav(samples, TARGET_RATE);
  const dataUrl = `data:audio/wav;base64,${bytesToBase64(new Uint8Array(wav))}`;

  return {
    dataUrl,
    seconds: Number(seconds.toFixed(2)),
    voicedSeconds: Number(voicedSeconds.toFixed(2)),
    sampleRate: TARGET_RATE,
    bytes: wav.byteLength,
    // Pre-flight checks that mirror the server's, so a hopeless clip is caught
    // before it is uploaded and rejected.
    tooShort: voicedSeconds < AUDIO.MIN_VOICED_SECONDS,
    tooQuiet: peakOf(samples) < 0.02,
  };
}

async function decodeToMono16k(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new RecordingError('This browser cannot decode audio.', 'unsupported');

  const arrayBuffer = await blob.arrayBuffer();
  const decodeContext = new Ctx();
  let decoded;
  try {
    decoded = await new Promise((resolve, reject) => {
      // The promise form is not available on older Safari; the callback form is
      // supported everywhere and this wrapper covers both.
      const maybePromise = decodeContext.decodeAudioData(arrayBuffer, resolve, reject);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    });
  } catch (error) {
    throw new RecordingError(
      'Could not read the recording. Try recording again.',
      'decode_failed',
    );
  } finally {
    if (decodeContext.state !== 'closed') decodeContext.close().catch(() => {});
  }

  // Clip to the server's ceiling before resampling — no point rendering audio
  // that will be truncated anyway.
  const maxFrames = Math.floor(AUDIO.MAX_CLIP_SECONDS * decoded.sampleRate);
  const frameCount = Math.min(decoded.length, maxFrames);
  if (!frameCount) throw new RecordingError('The recording is empty.', 'empty_recording');

  const targetLength = Math.max(1, Math.round((frameCount / decoded.sampleRate) * TARGET_RATE));

  // OfflineAudioContext does the downmix and the resample with a proper filter.
  if (typeof window.OfflineAudioContext === 'function') {
    try {
      const offline = new window.OfflineAudioContext(1, targetLength, TARGET_RATE);
      const source = offline.createBufferSource();
      source.buffer = trimBuffer(decoded, frameCount, Ctx);
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      return Float32Array.from(rendered.getChannelData(0));
    } catch {
      // Some Safari versions refuse a sample rate that differs from the hardware.
      // Fall through to manual resampling rather than failing enrollment.
    }
  }
  return manualResample(downmix(decoded, frameCount), decoded.sampleRate, TARGET_RATE);
}

/** Copy the first `frameCount` frames into a fresh buffer. */
function trimBuffer(buffer, frameCount, Ctx) {
  if (frameCount >= buffer.length) return buffer;
  const context = new Ctx();
  const trimmed = context.createBuffer(buffer.numberOfChannels, frameCount, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    trimmed.copyToChannel(buffer.getChannelData(channel).subarray(0, frameCount), channel);
  }
  if (context.state !== 'closed') context.close().catch(() => {});
  return trimmed;
}

/** Average all channels. Mirrors the server's `waveform.mean(axis=1)`. */
function downmix(buffer, frameCount) {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(frameCount);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

function manualResample(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, samples.length - 1);
    const weight = position - index;
    out[i] = samples[index] * (1 - weight) + samples[next] * weight;
  }
  return out;
}

/**
 * Rough voiced-duration estimate over 20 ms frames.
 *
 * The server runs real VAD; this only exists so the UI can say "hold the button a
 * little longer" instead of spending a round trip to be told the same thing.
 */
export function estimateVoicedSeconds(samples, { frameMs = 20 } = {}) {
  const frameSize = Math.max(1, Math.round((TARGET_RATE * frameMs) / 1000));
  const peak = peakOf(samples);
  if (peak < 0.01) return 0;
  // Relative to the loudest part of the clip, with an absolute floor so a room
  // of pure hiss does not read as speech.
  const threshold = Math.max(0.015, peak * 0.14);

  let voicedFrames = 0;
  for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
    let sum = 0;
    for (let i = start; i < start + frameSize; i += 1) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / frameSize) >= threshold) voicedFrames += 1;
  }
  return (voicedFrames * frameSize) / TARGET_RATE;
}

function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** 16-bit PCM WAV: 44-byte canonical header followed by little-endian samples. */
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric scaling: int16 holds -32768..32767, so the two directions differ.
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** Chunked, because `String.fromCharCode(...bytes)` blows the stack past ~100 KB. */
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
