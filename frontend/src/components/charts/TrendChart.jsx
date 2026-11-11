import { formatPercent, formatDate, pluralize } from '../../lib/format.js';

/**
 * Internal coordinate width. The SVG has no `height` attribute and
 * `.chart-svg { width: 100% }`, so the browser derives its rendered height from
 * this viewBox ratio — the chart scales with the container instead of needing a
 * ResizeObserver. `height` therefore sets the *proportion*, not an exact pixel
 * height; a taller value gives a taller chart at any container width.
 */
const VIEW_W = 720;

const PAD = { top: 14, right: 14, bottom: 28, left: 38 };
const Y_TICKS = [0, 25, 50, 75, 100];

/**
 * Attendance rate per session, as a line.
 *
 * `points` is `analytics.subjectTrend().points` verbatim — oldest first, already
 * capped at 60 by the server, and with `percentage` already accounting for late
 * joiners. Nothing here recomputes a percentage: the CSV export and this chart
 * have to agree, and the only way to guarantee that is to plot what the server
 * sent.
 *
 * No chart library, by contract. The whole thing is one path, one dashed
 * threshold line and a circle per point.
 */
export default function TrendChart({ points, threshold, height = 220 }) {
  const data = (Array.isArray(points) ? points : []).filter(
    (point) => point && point.percentage !== null && point.percentage !== undefined,
  );

  if (!data.length) {
    return (
      <div className="chart">
        <div className="chart-empty">No sessions in this range yet.</div>
      </div>
    );
  }

  const VIEW_H = Math.max(120, Number(height) || 220);
  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = VIEW_H - PAD.top - PAD.bottom;

  // A single point has no span to divide, so it sits in the middle rather than at
  // x=0 where half the marker would be clipped.
  const xOf = (index) =>
    data.length === 1 ? PAD.left + plotW / 2 : PAD.left + (index / (data.length - 1)) * plotW;
  // Y is fixed 0..100 rather than fitted to the data: an axis that rescaled itself
  // would make a class that went 88 -> 84 look like a collapse.
  const yOf = (percentage) => PAD.top + (1 - Math.min(100, Math.max(0, percentage)) / 100) * plotH;

  const line = data
    .map((point, index) => `${index ? 'L' : 'M'}${xOf(index).toFixed(1)} ${yOf(point.percentage).toFixed(1)}`)
    .join(' ');

  // Closed back along the baseline so the area under the line can be filled.
  const area =
    `${line} L${xOf(data.length - 1).toFixed(1)} ${(PAD.top + plotH).toFixed(1)}` +
    ` L${xOf(0).toFixed(1)} ${(PAD.top + plotH).toFixed(1)} Z`;

  const limit = Number(threshold);
  const hasThreshold = Number.isFinite(limit) && limit > 0;
  const belowCount = hasThreshold
    ? data.filter((point) => Number(point.percentage) < limit).length
    : 0;

  // First, last, and the middle one. Every label overlaps its neighbours past
  // about eight points, and the tooltip carries the rest.
  const labelIndexes = new Set(
    data.length <= 2 ? data.map((_, i) => i) : [0, Math.floor((data.length - 1) / 2), data.length - 1],
  );

  const average = data.reduce((sum, point) => sum + Number(point.percentage), 0) / data.length;

  return (
    <div className="chart">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Attendance rate over ${pluralize(data.length, 'session')}, averaging ${formatPercent(average)}`}
      >
        {/* Gridlines and the y scale. Drawn first so the line sits on top. */}
        {Y_TICKS.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={yOf(tick)}
              y2={yOf(tick)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={yOf(tick) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--text-faint)"
            >
              {tick}
            </text>
          </g>
        ))}

        {hasThreshold ? (
          <g>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={yOf(limit)}
              y2={yOf(limit)}
              stroke="var(--warn)"
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
            <text
              x={VIEW_W - PAD.right}
              y={yOf(limit) - 5}
              textAnchor="end"
              fontSize="11"
              fill="var(--warn)"
            >
              {`${limit}% required`}
            </text>
          </g>
        ) : null}

        <path d={area} fill="var(--primary)" fillOpacity="0.1" stroke="none" />
        <path
          d={line}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {data.map((point, index) => {
          const below = hasThreshold && Number(point.percentage) < limit;
          return (
            // `<title>` gives a native tooltip with no event handlers and no
            // portal — and it is what a screen reader reads for the point.
            <g key={point.session_id || index}>
              <title>
                {`${point.label || formatDate(point.date)} — ${formatPercent(point.percentage)} (${point.present}/${point.eligible})`}
              </title>
              <circle
                cx={xOf(index)}
                cy={yOf(point.percentage)}
                r={data.length > 30 ? 2.5 : 4}
                fill={below ? 'var(--danger)' : 'var(--primary)'}
                stroke="var(--surface)"
                strokeWidth="1.5"
              />
            </g>
          );
        })}

        {data.map((point, index) =>
          labelIndexes.has(index) ? (
            <text
              key={`label-${point.session_id || index}`}
              x={xOf(index)}
              y={VIEW_H - 8}
              textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}
              fontSize="11"
              fill="var(--text-faint)"
            >
              {formatDate(point.date)}
            </text>
          ) : null,
        )}
      </svg>

      <div className="chart-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--primary)' }} />
          Attendance rate
        </span>
        {hasThreshold ? (
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--warn)' }} />
            {`${limit}% required`}
          </span>
        ) : null}
        {belowCount ? (
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--danger)' }} />
            {`${pluralize(belowCount, 'session')} below`}
          </span>
        ) : null}
        <span className="legend-item">{`Average ${formatPercent(average)}`}</span>
      </div>
    </div>
  );
}
