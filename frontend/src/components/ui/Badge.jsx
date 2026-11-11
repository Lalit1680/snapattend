/**
 * Status label — attendance method, enrollment state, session status.
 *
 * The six tone names are fixed by the design contract; the stylesheet defines
 * `.is-*` scoped to `.badge`, so an unknown tone renders unstyled rather than
 * inheriting something misleading.
 */
export default function Badge({ tone = 'muted', dot = false, children }) {
  return (
    <span className={`badge is-${tone}`}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
