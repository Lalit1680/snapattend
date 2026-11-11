import { formatPercent } from '../../lib/format.js';

/**
 * Horizontal meter for a single percentage — attendance rate, enrollment
 * coverage, upload progress.
 */
export default function ProgressBar({ value, max = 100, tone = 'primary', label, showValue = false }) {
  const ceiling = Number(max) > 0 ? Number(max) : 100;
  const raw = Number(value);
  const bounded = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), ceiling) : 0;
  // The backend happily reports 100.0, and float division of it can land on
  // 100.00000000000001; an unclamped width overflows the track's border-radius.
  const percent = Math.min(100, Math.max(0, (bounded / ceiling) * 100));
  const showHeader = Boolean(label) || showValue;

  return (
    <div className="stack stack-sm">
      {showHeader ? (
        <div className="progress-label">
          <span>{label}</span>
          {showValue ? <span>{formatPercent(percent)}</span> : null}
        </div>
      ) : null}
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={Math.round(bounded * 10) / 10}
        aria-valuemin={0}
        aria-valuemax={ceiling}
        // Only a plain-string label can name the bar; a node would stringify to
        // "[object Object]" and the caller's own markup already reads better.
        aria-label={typeof label === 'string' ? label : undefined}
      >
        <div className={`progress-bar is-${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
