/**
 * Webcam capture and client-side image preparation.
 *
 * Two consumers, with different needs:
 *
 * - **Enrollment** captures 2-5 frames of one face and sends them as data URLs to
 *   `POST /api/enroll/face`. Small frames are fine; the server downscales to
 *   `ENROLLMENT_PHOTO_MAX_DIM` (1200) anyway.
 * - **Class photo** sends one wide shot as multipart to
 *   `POST /api/sessions/<id>/photo`, where every face has to survive detection.
 *   Resolution matters here, so the ceiling matches the server's
 *   `CLASS_PHOTO_MAX_DIM` (2400) rather than being smaller.
 *
 * Nothing is written to disk on either side. The frames live in memory until they
 * are embedded, which is the whole retention story.
 */

/** Server-side ceilings from `backend/app/config.py`. */
export const ENROLLMENT_MAX_DIM = 1200;
export const CLASS_PHOTO_MAX_DIM = 2400;

export class CameraError extends Error {
  constructor(message, code = 'camera_failed') {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

export function isCameraSupported() {
  return Boolean(
    typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function',
  );
}

/** getUserMedia needs a secure origin; localhost counts. */
export function isSecureContextForMedia() {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

function describeCameraError(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CameraError(
      'Camera access was blocked. Allow it in your browser’s address bar, then try again.',
      'permission_denied',
    );
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new CameraError('No camera was found on this device.', 'no_device');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return new CameraError(
      'The camera is in use by another application. Close it and try again.',
      'device_busy',
    );
  }
  if (name === 'OverconstrainedError') {
    return new CameraError('That camera cannot provide the requested resolution.', 'overconstrained');
  }
  return new CameraError((error && error.message) || 'Could not start the camera.', 'camera_failed');
}

/**
 * Open a camera stream.
 *
 * `facingMode: 'user'` for enrollment selfies, `'environment'` for a teacher
 * photographing the room from a phone. Both are hints -- a desktop with one
 * webcam ignores them.
 */
export async function openCamera({
  facingMode = 'user',
  deviceId = null,
  width = 1280,
  height = 720,
} = {}) {
  if (!isCameraSupported()) {
    throw new CameraError(
      'This browser cannot access a camera. Try a recent Chrome, Edge or Firefox.',
      'unsupported',
    );
  }
  if (!isSecureContextForMedia()) {
    throw new CameraError(
      'Camera access needs a secure connection (HTTPS or localhost).',
      'insecure_context',
    );
  }

  const video = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode, width: { ideal: width }, height: { ideal: height } };

  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    // Retry unconstrained: a laptop webcam that cannot do 1280x720 should still
    // be usable rather than reporting "no camera".
    if (error && error.name === 'OverconstrainedError' && !deviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (retryError) {
        throw describeCameraError(retryError);
      }
    }
    throw describeCameraError(error);
  }
}

export function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  });
}

/** Cameras the user could pick from. Labels are empty until permission is granted. */
export async function listCameras() {
  if (!isCameraSupported() || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Grab the current video frame as a JPEG data URL.
 *
 * `mirror` un-flips a selfie preview: the video element is usually CSS-mirrored so
 * moving left feels like moving left, but the *captured* pixels must match reality
 * or the face embedding is of a mirrored face.
 */
export function captureFrame(
  video,
  { maxDim = ENROLLMENT_MAX_DIM, quality = 0.92, mirror = false } = {},
) {
  if (!video || !video.videoWidth || !video.videoHeight) {
    throw new CameraError('The camera is not ready yet. Wait a moment and try again.', 'not_ready');
  }

  const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new CameraError('This browser could not render the frame.', 'no_canvas');

  if (mirror) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Multipart endpoints need a File; data URLs are what the canvas gives us. */
export function dataUrlToFile(dataUrl, filename = 'capture.jpg') {
  const [header, payload] = String(dataUrl).split(',');
  if (!payload) throw new CameraError('That image could not be read.', 'bad_data_url');
  const mimeMatch = /data:([^;]+);/.exec(header);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new CameraError('Could not read that file.', 'read_failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Shrink an oversized photo before uploading it.
 *
 * A phone photo is routinely 6-10 MB, which is slow on classroom wifi and gets
 * downscaled server-side regardless. Resizing to the server's own ceiling first
 * loses nothing and can turn a 30-second upload into two seconds.
 *
 * Returns the original file untouched when it is already small enough, or when
 * anything about the resize fails -- an upload that is merely slow beats an
 * upload that never happens.
 */
export async function prepareImageForUpload(
  file,
  { maxDim = CLASS_PHOTO_MAX_DIM, quality = 0.9, skipBelowBytes = 900 * 1024 } = {},
) {
  if (!file || !String(file.type).startsWith('image/')) {
    throw new CameraError('Choose an image file (JPEG or PNG).', 'not_an_image');
  }
  if (file.size <= skipBelowBytes) return file;

  try {
    const bitmap = await loadBitmap(file);
    const largest = Math.max(bitmap.width, bitmap.height);
    if (largest <= maxDim) {
      if (bitmap.close) bitmap.close();
      return file;
    }

    const scale = maxDim / largest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, '') || 'class-photo';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/** `createImageBitmap` honours EXIF orientation; the `<img>` path is the fallback. */
async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall through */
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new CameraError('Could not decode that image.', 'decode_failed'));
      image.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Rough megapixel count, for the "this photo may be too small" hint. */
export function megapixelsOf(width, height) {
  return Number(((Number(width) * Number(height)) / 1_000_000).toFixed(1));
}
