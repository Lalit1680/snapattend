/**
 * The indeterminate busy indicator. Purely CSS: `.spinner` owns the animation.
 */

const SIZE_CLASS = { sm: 'spinner-sm', lg: 'spinner-lg' };

export default function Spinner({ size = 'md', label }) {
  const className = ['spinner', SIZE_CLASS[size]].filter(Boolean).join(' ');

  // Without a label the spinner is decoration next to text that already says
  // what is happening (a Button's own words, a LoadingBlock's caption), so it is
  // hidden from the accessibility tree instead of announcing "image".
  if (!label) return <span className={className} aria-hidden="true" />;

  // `.sr-only` is clipped out of flow, so it cannot disturb the spinner's box
  // while still giving the status region an accessible name.
  return (
    <span className={className} role="status">
      <span className="sr-only">{label}</span>
    </span>
  );
}
