/** A fully rounded label. Same tones as `Badge`, softer shape. */
export default function Pill({ tone = 'muted', children }) {
  return <span className={`pill is-${tone}`}>{children}</span>;
}
