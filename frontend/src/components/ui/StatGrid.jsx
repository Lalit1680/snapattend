/**
 * Responsive wrapper for a row of `StatTile`s. Collapses to two columns below
 * the 900px breakpoint, which the stylesheet handles.
 */
export default function StatGrid({ children }) {
  return <div className="stat-grid">{children}</div>;
}
