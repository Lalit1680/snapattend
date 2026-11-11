/**
 * The "nothing here yet" panel. `action` is a node — usually a `Button` that
 * starts the thing that would fill the list, because a dead end with no next
 * step is the most common way an admin gets stuck.
 */
export default function EmptyState({ title, message, icon, action }) {
  return (
    <div className="empty">
      {icon ? (
        <div className="empty-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      {title ? <p className="empty-title">{title}</p> : null}
      {message ? <p className="empty-text">{message}</p> : null}
      {action ? <div className="center">{action}</div> : null}
    </div>
  );
}
