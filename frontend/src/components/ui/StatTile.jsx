/**
 * One number on a dashboard: `label` above, `value` large, `meta` small below.
 *
 * The tone class sits on the root because the stylesheet scopes `.is-*` to
 * `.stat` and paints only `.stat-value` from it — the tile itself stays neutral
 * so a row of tiles does not turn into a traffic light.
 */
export default function StatTile({ label, value, meta, tone = 'muted', icon }) {
  const labelClass = ['stat-label', icon && 'row row-sm'].filter(Boolean).join(' ');

  return (
    <div className={`stat is-${tone}`}>
      <div className={labelClass}>
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        <span>{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      {meta ? <div className="stat-meta">{meta}</div> : null}
    </div>
  );
}
