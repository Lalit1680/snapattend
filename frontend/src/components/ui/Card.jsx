/**
 * Panel with an optional header, body and footer.
 */
export default function Card({
  title,
  subtitle,
  actions,
  footer,
  flush = false,
  className = '',
  children,
}) {
  // An empty `.card-header` still draws its padding and bottom hairline, which
  // reads as a stray gap above the content. `subtitle` counts too: a header
  // holding only a subtitle is not empty, and dropping it would lose content
  // silently.
  const hasHeader = Boolean(title || subtitle || actions);
  const classes = ['card', flush && 'is-flush', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {hasHeader ? (
        <div className="card-header">
          {title || subtitle ? (
            <div className="card-heading">
              {title ? <h3 className="card-title">{title}</h3> : null}
              {subtitle ? <p className="card-sub">{subtitle}</p> : null}
            </div>
          ) : null}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="card-body">{children}</div>
      {footer ? <div className="card-footer">{footer}</div> : null}
    </div>
  );
}
