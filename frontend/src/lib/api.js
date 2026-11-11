/**
 * The single HTTP client.
 *
 * Three things live here and nowhere else:
 *
 * 1. **The error envelope.** Every backend failure is
 *    `{"error": {"code", "message", "details"}}` (see
 *    `backend/app/utils/errors.py`). The response interceptor unwraps it into an
 *    {@link ApiError}, so no component ever touches `err.response.data.error`.
 *
 * 2. **Token refresh.** Access tokens last 30 minutes. A 401 triggers exactly one
 *    refresh -- concurrent requests share the in-flight promise rather than
 *    stampeding `/api/auth/refresh` -- and the original request is replayed. If
 *    the refresh itself fails the tokens are cleared and subscribers are told, so
 *    the app can redirect to the sign-in page from one place.
 *
 * 3. **Query serialization.** Flask reads repeatable params with
 *    `request.args.getlist("subject_id")`, which needs `?subject_id=a&subject_id=b`.
 *    Axios' default array format (`subject_id[]=a`) would silently return
 *    unfiltered data, so the serializer is explicit.
 */
import axios from 'axios';

const BASE_URL = String(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

const ACCESS_KEY = 'snapattend.access_token';
const REFRESH_KEY = 'snapattend.refresh_token';

/** Endpoints that must never trigger a refresh-and-retry cycle. */
const NO_RETRY_PATHS = ['/api/auth/login', '/api/auth/refresh', '/api/auth/accept-invite'];

// --------------------------------------------------------------------------- //
// Errors
// --------------------------------------------------------------------------- //
export class ApiError extends Error {
  constructor({ message, code, details, status, retryAfter }) {
    super(message || 'Something went wrong.');
    this.name = 'ApiError';
    this.code = code || 'error';
    this.details = details || {};
    this.status = status || 0;
    this.retryAfter = retryAfter || null;
  }

  /** True when the browser never reached the server (offline, dev server down). */
  get isNetwork() {
    return this.status === 0;
  }

  get isAuth() {
    return this.status === 401;
  }

  /**
   * Field-level messages as a `{fieldName: message}` map, so a form can mark the
   * control that is wrong.
   *
   * The backend reports a bad value three different ways and none of them is
   * already a map:
   *
   * - `details.fields` as an object — used if a future endpoint sends one.
   * - `details.fields` as an **array** of names, which is what
   *   `validators.require()` sends for `"Missing required fields"`.
   * - `details.field` as a single name, which is what `clean_name`,
   *   `clean_threshold`, `clean_verification_mode` and friends send alongside a
   *   message that already explains the problem.
   *
   * Normalising here rather than in each form is the whole point: otherwise every
   * page reimplements the same three-way check.
   */
  get fieldErrors() {
    const { details } = this;
    if (!details || typeof details !== 'object') return {};
    if (Array.isArray(details.fields)) {
      return details.fields.reduce(
        (map, name) => Object.assign(map, { [String(name)]: 'This is required.' }),
        {},
      );
    }
    if (details.fields && typeof details.fields === 'object') return details.fields;
    if (typeof details.field === 'string' && details.field) {
      return { [details.field]: this.message };
    }
    return {};
  }
}

/** Normalise anything thrown by axios into an ApiError. */
async function toApiError(error) {
  if (error instanceof ApiError) return error;

  if (!error.response) {
    const aborted = error.code === 'ERR_CANCELED' || error.name === 'CanceledError';
    return new ApiError({
      message: aborted
        ? 'Request cancelled.'
        : 'Could not reach the SnapAttend server. Check that the backend is running.',
      code: aborted ? 'cancelled' : 'network_error',
      status: 0,
    });
  }

  const { status, data, headers } = error.response;
  let payload = data;

  // A failed CSV download arrives as a Blob even though its body is JSON.
  if (payload instanceof Blob) {
    try {
      payload = JSON.parse(await payload.text());
    } catch {
      payload = null;
    }
  }

  const envelope = payload && typeof payload === 'object' ? payload.error : null;
  return new ApiError({
    status,
    message:
      (envelope && envelope.message) ||
      (payload && typeof payload === 'object' && payload.message) ||
      defaultMessageFor(status),
    code: (envelope && envelope.code) || defaultCodeFor(status),
    details: (envelope && envelope.details) || {},
    retryAfter: headers && headers['retry-after'] ? Number(headers['retry-after']) : null,
  });
}

function defaultCodeFor(status) {
  return (
    {
      400: 'bad_request',
      401: 'unauthorized',
      403: 'forbidden',
      404: 'not_found',
      409: 'conflict',
      413: 'payload_too_large',
      422: 'unprocessable',
      429: 'rate_limited',
      500: 'server_error',
      503: 'service_unavailable',
    }[status] || 'error'
  );
}

function defaultMessageFor(status) {
  return (
    {
      401: 'Please sign in to continue.',
      403: 'You do not have access to that.',
      404: 'That was not found.',
      413: 'That file is too large.',
      429: 'Too many attempts. Wait a moment and try again.',
      500: 'The server hit an unexpected error.',
      503: 'A required service is unavailable.',
    }[status] || 'Something went wrong.'
  );
}

// --------------------------------------------------------------------------- //
// Token storage
// --------------------------------------------------------------------------- //
/**
 * localStorage rather than a cookie, because the backend is configured with
 * `JWT_TOKEN_LOCATION=["headers"]` and `supports_credentials=False`. There is no
 * cookie for CSRF to attack, at the cost of being readable by any script that
 * gets injected -- which is the trade the backend already committed to.
 */
export const tokenStore = {
  access() {
    try {
      return localStorage.getItem(ACCESS_KEY);
    } catch {
      return null;
    }
  },
  refresh() {
    try {
      return localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  /** Merge, don't overwrite: `/refresh` returns an access token and nothing else. */
  save(payload = {}) {
    try {
      if (payload.access_token) localStorage.setItem(ACCESS_KEY, payload.access_token);
      if (payload.refresh_token) localStorage.setItem(REFRESH_KEY, payload.refresh_token);
    } catch {
      /* private browsing with storage disabled — the session just won't persist */
    }
  },
  clear() {
    try {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* nothing to clear */
    }
  },
  has() {
    return Boolean(this.access());
  },
};

// --------------------------------------------------------------------------- //
// "Session ended" notification
// --------------------------------------------------------------------------- //
const expiryListeners = new Set();

/** Subscribe to irrecoverable auth failure. Returns an unsubscribe function. */
export function onSessionExpired(listener) {
  expiryListeners.add(listener);
  return () => expiryListeners.delete(listener);
}

function announceExpiry(reason) {
  expiryListeners.forEach((listener) => {
    try {
      listener(reason);
    } catch {
      /* a broken listener must not break the others */
    }
  });
}

// --------------------------------------------------------------------------- //
// Axios instance
// --------------------------------------------------------------------------- //
function serializeParams(params) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null && item !== '') search.append(key, String(item));
      });
      return;
    }
    search.append(key, String(value));
  });
  return search.toString();
}

export const http = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  // No default Content-Type: axios infers JSON for plain objects and sets the
  // multipart boundary itself for FormData. Forcing it here breaks photo upload.
  paramsSerializer: { serialize: serializeParams },
});

http.interceptors.request.use((config) => {
  if (!config.skipAuth) {
    const token = tokenStore.access();
    if (token) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

let refreshInFlight = null;

/** Exchange the refresh token for a new access token. Single-flight. */
function refreshAccessToken() {
  if (!refreshInFlight) {
    const refreshToken = tokenStore.refresh();
    if (!refreshToken) return Promise.reject(new ApiError({ status: 401, code: 'unauthorized' }));

    refreshInFlight = axios
      .post(`${BASE_URL}/api/auth/refresh`, null, {
        headers: { Authorization: `Bearer ${refreshToken}` },
        timeout: 15000,
      })
      .then((response) => {
        tokenStore.save(response.data);
        return response.data;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config || {};
    const status = error.response ? error.response.status : 0;
    const path = String(config.url || '');
    const refreshable =
      status === 401 &&
      !config._retried &&
      !config.skipAuth &&
      tokenStore.refresh() &&
      !NO_RETRY_PATHS.some((candidate) => path.includes(candidate));

    if (refreshable) {
      try {
        await refreshAccessToken();
        config._retried = true;
        return await http.request(config);
      } catch {
        tokenStore.clear();
        announceExpiry('refresh_failed');
        throw new ApiError({
          status: 401,
          code: 'token_expired',
          message: 'Your session expired. Please sign in again.',
        });
      }
    }

    const apiError = await toApiError(error);
    // A 401 we could not refresh past means the credentials are gone for good.
    if (apiError.isAuth && !path.includes('/api/auth/login')) {
      tokenStore.clear();
      announceExpiry(apiError.code);
    }
    throw apiError;
  },
);

// --------------------------------------------------------------------------- //
// Verb helpers
// --------------------------------------------------------------------------- //
const unwrap = (promise) => promise.then((response) => response.data);

export const get = (url, params, config = {}) => unwrap(http.get(url, { params, ...config }));
export const post = (url, data, config = {}) => unwrap(http.post(url, data, config));
export const patch = (url, data, config = {}) => unwrap(http.patch(url, data, config));
export const del = (url, config = {}) => unwrap(http.delete(url, config));

/**
 * Fetch a CSV export and hand it to the browser as a download.
 *
 * The filename comes from `Content-Disposition`, which the backend exposes to
 * JavaScript via CORS (`expose_headers=["Content-Disposition"]`) -- without that
 * the browser can see the header but the fetch cannot.
 */
export async function download(url, params, fallbackName = 'snapattend-export.csv') {
  const response = await http.get(url, { params, responseType: 'blob' });
  const disposition = String(response.headers['content-disposition'] || '');
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : fallbackName;

  const objectUrl = URL.createObjectURL(response.data);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick; Safari cancels the download if it happens sooner.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  return filename;
}

// --------------------------------------------------------------------------- //
// Endpoints, grouped the way the blueprints are
// --------------------------------------------------------------------------- //
export const AuthAPI = {
  registerInstitution: (payload) =>
    post('/api/auth/register-institution', payload, { skipAuth: true }),
  login: (email, password) => post('/api/auth/login', { email, password }, { skipAuth: true }),
  me: () => get('/api/auth/me'),
  logout: () => post('/api/auth/logout'),
  changePassword: (current_password, new_password) =>
    post('/api/auth/change-password', { current_password, new_password }),
  forgotPassword: (email) => post('/api/auth/forgot-password', { email }, { skipAuth: true }),
  resetPassword: (token, password) =>
    post('/api/auth/reset-password', { token, password }, { skipAuth: true }),
  readInvite: (token) => get('/api/auth/invite', { token }, { skipAuth: true }),
  acceptInvite: (token, password) =>
    post('/api/auth/accept-invite', { token, password }, { skipAuth: true }),
  institution: () => get('/api/auth/institution'),
};

export const SubjectsAPI = {
  list: (params) => get('/api/subjects', params),
  create: (payload) => post('/api/subjects', payload),
  get: (id) => get(`/api/subjects/${id}`),
  update: (id, payload) => patch(`/api/subjects/${id}`, payload),
  remove: (id) => del(`/api/subjects/${id}`),
  roster: (id) => get(`/api/subjects/${id}/roster`),
  addToRoster: (id, studentIds) => post(`/api/subjects/${id}/roster`, { student_ids: studentIds }),
  removeFromRoster: (id, studentId) => del(`/api/subjects/${id}/roster/${studentId}`),
  availableStudents: (id) => get(`/api/subjects/${id}/available-students`),
};

export const StudentsAPI = {
  list: (params) => get('/api/students', params),
  get: (id) => get(`/api/students/${id}`),
  invite: (payload) => post('/api/students', payload),
  importCsv: (payload) => post('/api/students/import', payload),
  importFile: (file, { subject_id, dry_run } = {}) => {
    const form = new FormData();
    form.append('file', file);
    if (subject_id) form.append('subject_id', subject_id);
    if (dry_run) form.append('dry_run', 'true');
    return post('/api/students/import', form);
  },
  downloadTemplate: () => download('/api/students/import/template', null, 'snapattend-students-template.csv'),
  update: (id, payload) => patch(`/api/students/${id}`, payload),
  resetBiometrics: (id, payload) => post(`/api/students/${id}/reset-biometrics`, payload),
  attendance: (id, params) => get(`/api/students/${id}/attendance`, params),
  resendInvite: (id) => post(`/api/students/${id}/resend-invite`),
};

export const SessionsAPI = {
  list: (params) => get('/api/sessions', params),
  create: (payload) => post('/api/sessions', payload),
  get: (id) => get(`/api/sessions/${id}`),
  update: (id, payload) => patch(`/api/sessions/${id}`, payload),
  end: (id) => post(`/api/sessions/${id}/end`),
  /** The 3-second poll. Deliberately un-throttled on the backend. */
  live: (id, config) => get(`/api/sessions/${id}/live`, null, config),
  qr: (id, force) => get(`/api/sessions/${id}/qr`, force ? { force: 'true' } : null),
  coverage: (id) => get(`/api/sessions/${id}/coverage`),
  /** Class-photo upload. Generous timeout: dlib detection takes seconds. */
  uploadPhoto: (id, file, onProgress) => {
    const form = new FormData();
    form.append('photo', file);
    return post(`/api/sessions/${id}/photo`, form, {
      timeout: 180000,
      onUploadProgress: onProgress
        ? (event) =>
            onProgress(event.total ? Math.round((event.loaded / event.total) * 100) : null)
        : undefined,
    });
  },
  review: (id, includeResolved) =>
    get(`/api/sessions/${id}/review`, includeResolved ? { include_resolved: 'true' } : null),
  resolveReview: (id, pendingId, payload) =>
    post(`/api/sessions/${id}/review/${pendingId}`, payload),
  discardReview: (id) => del(`/api/sessions/${id}/review`),
  export: (id) => download(`/api/sessions/${id}/export`, null, 'attendance-session.csv'),
};

export const AttendanceAPI = {
  checkInWithQr: (token) => post('/api/attendance/qr', { token }),
  checkInWithVoice: (session_id, audio) => post('/api/attendance/voice', { session_id, audio }),
  override: (payload) => post('/api/attendance/override', payload),
  overrideBulk: (payload) => post('/api/attendance/override/bulk', payload),
  mine: (params) => get('/api/attendance/me', params),
  myOpenSessions: () => get('/api/attendance/me/open-sessions'),
  exportMine: () => download('/api/attendance/me/export', null, 'my-attendance.csv'),
  forSession: (id) => get(`/api/attendance/session/${id}`),
};

export const AnalyticsAPI = {
  overview: () => get('/api/analytics/overview'),
  subject: (id, params) => get(`/api/analytics/subjects/${id}`, params),
  subjectTrend: (id, params) => get(`/api/analytics/subjects/${id}/trend`, params),
  exportSubject: (id, params) =>
    download(`/api/analytics/subjects/${id}/export`, params, 'attendance-subject.csv'),
  student: (id, params) => get(`/api/analytics/students/${id}`, params),
  exportStudent: (id, params) =>
    download(`/api/analytics/students/${id}/export`, params, 'attendance-student.csv'),
  defaulters: (params) => get('/api/analytics/defaulters', params),
  exportDefaulters: (params) =>
    download('/api/analytics/defaulters/export', params, 'defaulters.csv'),
  methods: (params) => get('/api/analytics/methods', params),
  enrollmentCoverage: (params) => get('/api/analytics/enrollment-coverage', params),
};

export const EnrollAPI = {
  status: () => get('/api/enroll/status'),
  submitFace: (samples) => post('/api/enroll/face', { samples }, { timeout: 120000 }),
  submitVoice: (samples) => post('/api/enroll/voice', { samples }, { timeout: 120000 }),
  reset: (payload) => post('/api/enroll/reset', payload),
  passphrase: () => get('/api/enroll/passphrase'),
  subjects: () => get('/api/enroll/subjects'),
};

export const AdminAPI = {
  institution: () => get('/api/admin/institution'),
  updateInstitution: (payload) => patch('/api/admin/institution', payload),
  users: (params) => get('/api/admin/users', params),
  inviteTeacher: (payload) => post('/api/admin/teachers', payload),
  resendInvite: (userId) => post(`/api/admin/users/${userId}/resend-invite`),
  revokeInvite: (userId) => del(`/api/admin/users/${userId}/invite`),
  disableUser: (userId, reason) => post(`/api/admin/users/${userId}/disable`, { reason }),
  enableUser: (userId) => post(`/api/admin/users/${userId}/enable`),
  changeRole: (userId, role) => post(`/api/admin/users/${userId}/role`, { role }),
  invites: (params) => get('/api/admin/invites', params),
  audit: (params) => get('/api/admin/audit', params),
  privacy: () => get('/api/admin/privacy'),
  sweepCrops: () => post('/api/admin/privacy/sweep'),
  runAlerts: (payload) => post('/api/admin/alerts/run', payload),
  alerts: (params) => get('/api/admin/alerts', params),
};

export const PublicAPI = {
  /** Resolve a scanned QR token. Sends the JWT when there is one, works without. */
  scan: (token) => get('/api/public/scan', { t: token }),
};

export const HealthAPI = {
  /**
   * `/healthz` answers **503 with a complete body** when a dependency is down, and
   * that body is a plain payload rather than the `{"error": {...}}` envelope. Left
   * to the interceptor, a 503 would become a thrown ApiError and `toApiError` would
   * discard the `checks` object -- which is the only thing the health badge is for.
   * So 503 counts as a valid response here and the caller reads `status` instead.
   */
  check: () =>
    get('/healthz', null, {
      skipAuth: true,
      timeout: 8000,
      validateStatus: (status) => status === 200 || status === 503,
    }),
};
