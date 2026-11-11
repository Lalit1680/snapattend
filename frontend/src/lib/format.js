/** Display formatting. Everything user-visible that is not a raw string. */

const LOCALE = undefined; // use the browser's locale

/** The API sends ISO-8601 UTC strings; anything falsy renders as an em dash. */
export function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value, { seconds = false } = {}) {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleString(LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
}

export function formatDate(value) {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(value, { seconds = false } = {}) {
  const date = toDate(value);
  if (!date) return '—';
  return date.toLocaleTimeString(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
}

/** "in 42 minutes" / "3 hours ago" — for session windows and audit entries. */
export function formatRelative(value) {
  const date = toDate(value);
  if (!date) return '—';
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const magnitude = Math.abs(deltaSeconds);

  const units = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.348],
    ['month', 12],
    ['year', Infinity],
  ];
  let value_ = deltaSeconds;
  let unit = 'second';
  let divisor = 1;
  for (let i = 0; i < units.length; i += 1) {
    const [name, span] = units[i];
    if (magnitude < divisor * span || span === Infinity) {
      unit = name;
      value_ = deltaSeconds / divisor;
      break;
    }
    divisor *= span;
  }
  if (typeof Intl.RelativeTimeFormat === 'function') {
    return new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' }).format(
      Math.round(value_),
      unit,
    );
  }
  return formatDateTime(date);
}

/** mm:ss — the QR rotation countdown and session duration. */
export function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatPercent(value, { digits = 1 } = {}) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return '—';
  return `${number.toFixed(digits)}%`;
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return '—';
  return number.toLocaleString(LOCALE);
}

/**
 * Recognition distance turned into a percentage a human can read.
 *
 * The backend already computes `confidence_score` this way for attendance
 * records; this exists for the places that only carry a raw distance.
 */
export function formatConfidence(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return '—';
  // Values above 1 are already percentages; below 1 they are 0..1 confidences.
  return number > 1 ? `${number.toFixed(0)}%` : `${(number * 100).toFixed(0)}%`;
}

/** Colour band for an attendance percentage against a threshold. */
export function attendanceTone(percentage, threshold = 75) {
  const number = Number(percentage);
  if (Number.isNaN(number)) return 'muted';
  if (number >= threshold + 10) return 'success';
  if (number >= threshold) return 'info';
  if (number >= threshold - 10) return 'warn';
  return 'danger';
}

export function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Turn a dotted audit action ("attendance.override") into "Attendance override". */
export function humanizeAction(action) {
  const text = String(action || '').replace(/[._]/g, ' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '—';
}

export function pluralize(count, singular, plural) {
  const number = Number(count) || 0;
  return `${number.toLocaleString(LOCALE)} ${number === 1 ? singular : plural || `${singular}s`}`;
}

export function truncate(text, max = 80) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** `datetime-local` inputs need a local-time string with no timezone suffix. */
export function toLocalInputValue(value) {
  const date = toDate(value) || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Convert a `datetime-local` value back to the ISO string the API expects. */
export function fromLocalInputValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A `<input type="date">` value as the first instant of that day, **locally**.
 *
 * Handing the API the raw `2026-08-01` would work — `parse_iso` accepts it — but
 * Python reads it as midnight *UTC*, so a teacher in UTC+5:30 filtering "from the
 * 1st" would silently include five and a half hours of the previous evening's
 * sessions. Anchoring to the local day is what the person picking the date meant.
 */
export function dayStartIso(value) {
  if (!value) return undefined;
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

/** The same, for the last instant of the day — so `until` includes that day. */
export function dayEndIso(value) {
  if (!value) return undefined;
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

export function formatBytes(bytes) {
  const number = Number(bytes) || 0;
  if (number < 1024) return `${number} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(0)} KB`;
  return `${(number / 1024 / 1024).toFixed(1)} MB`;
}
