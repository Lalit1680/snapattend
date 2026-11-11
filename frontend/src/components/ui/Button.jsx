import Spinner from './Spinner.jsx';

/**
 * Every clickable action in the app.
 *
 * `...rest` is spread so pages can pass `aria-label`, `title`, `form`,
 * `autoFocus` and `onClick` without this component growing a prop for each.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  icon = null,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'btn',
    `btn-${variant}`,
    size !== 'md' && `btn-${size}`,
    block && 'btn-block',
    loading && 'is-loading',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    // `rest` comes first so the explicit attributes below always win: a caller
    // passing `disabled={false}` must not be able to re-enable a loading button.
    <button
      {...rest}
      type={type}
      className={classes}
      aria-busy={loading ? 'true' : undefined}
      // `loading` implies `disabled`. A double-submitted class-photo upload runs
      // the dlib pipeline a second time on the server and bills a second
      // rate-limit slot against a 30/hr budget.
      disabled={loading || Boolean(rest.disabled)}
    >
      {loading ? <Spinner size="sm" /> : icon}
      {children}
    </button>
  );
}
