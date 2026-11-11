import Button from './Button.jsx';

/** Glyphs rather than an icon dependency; `.alert-icon` sizes and colours them. */
const TONE_ICON = {
  primary: 'i',
  info: 'i',
  success: '✓',
  warn: '!',
  danger: '✕',
  muted: 'i',
};

/**
 * Inline message attached to the content it concerns.
 */
export default function Alert({ tone = 'info', title, actions, onClose, children }) {
  // danger/warn interrupt whatever a screen reader is saying because the user is
  // about to act on stale or wrong information; info/success wait their turn.
  const role = tone === 'danger' || tone === 'warn' ? 'alert' : 'status';

  return (
    <div className={`alert is-${tone}`} role={role}>
      <span className="alert-icon" aria-hidden="true">
        {TONE_ICON[tone] || TONE_ICON.info}
      </span>
      <div className="alert-content">
        {title ? <p className="alert-title">{title}</p> : null}
        {children}
        {actions || onClose ? (
          <div className="alert-actions">
            {actions}
            {onClose ? (
              <Button variant="ghost" size="sm" onClick={onClose}>
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
