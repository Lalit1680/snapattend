import { EmptyState } from '../ui/index.js';
import { formatNumber } from '../../lib/format.js';

/** The six tones, as the CSS custom properties a bar fill can take. */
const TONE_VARS = {
  primary: 'var(--primary)',
  success: 'var(--success)',
  info: 'var(--info)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  muted: 'var(--text-faint)',
};

/**
 * Horizontal bars — attendance by method, by subject, by anything countable.
 *
 * `items` are `{label, value, display?, tone?}`. `display` wins over
 * `valueFormat`, which wins over a plain formatted number, so a caller can pass
 * "18 of 24 (75%)" for one row without giving up the default for the rest.
 *
 * Bars scale to the **largest value in the list**, not to 100. These are counts
 * more often than percentages, and a list of counts scaled to 100 would render as
 * six barely-visible stubs. Pass percentages with an item at 100 if you want a
 * fixed scale.
 */
export default function BarList({ items, tone = 'primary', valueFormat }) {
  const rows = (Array.isArray(items) ? items : []).filter(
    (item) => item && item.value !== null && item.value !== undefined,
  );

  if (!rows.length) {
    return <EmptyState title="Nothing to chart" message="No data in this range yet." />;
  }

  // Guard the divide: a list where everything is zero is legitimate (a session
  // nobody attended) and must render empty bars rather than NaN widths.
  const peak = Math.max(1, ...rows.map((item) => Math.abs(Number(item.value)) || 0));

  const render = (item) => {
    if (item.display !== undefined && item.display !== null) return item.display;
    if (typeof valueFormat === 'function') return valueFormat(item.value, item);
    return formatNumber(item.value);
  };

  return (
    <div className={tone && tone !== 'primary' ? `bar-list is-${tone}` : 'bar-list'}>
      {rows.map((item, index) => {
        const value = Number(item.value) || 0;
        const width = `${Math.min(100, (Math.abs(value) / peak) * 100).toFixed(1)}%`;
        return (
          <div className="bar-row" key={item.key || item.label || index}>
            <span className="bar-label" title={item.label}>
              {item.label}
            </span>
            <span className="bar-track">
              {/* Width is data. A per-item tone also has to be inline: the class
                  inventory scopes tone to the list, not the row, and inventing
                  `.bar-row.is-danger` here would put a seventh place in the
                  codebase that decides what a colour means. */}
              <span
                className="bar-fill"
                style={{
                  width,
                  ...(item.tone && TONE_VARS[item.tone]
                    ? { background: TONE_VARS[item.tone] }
                    : null),
                }}
              />
            </span>
            <span className="bar-value">{render(item)}</span>
          </div>
        );
      })}
    </div>
  );
}
