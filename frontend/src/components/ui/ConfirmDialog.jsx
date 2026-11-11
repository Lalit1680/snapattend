import Button from './Button.jsx';
import Modal from './Modal.jsx';

/**
 * The tone vocabulary is wider than the button variants (there is no
 * `btn-success`), so anything that is not destructive confirms as primary.
 */
function confirmVariant(tone) {
  return tone === 'danger' ? 'danger' : 'primary';
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
  children,
}) {
  const footer = (
    <>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        {cancelLabel}
      </Button>
      <Button variant={confirmVariant(tone)} onClick={onConfirm} loading={busy}>
        {confirmLabel}
      </Button>
    </>
  );

  // While the request is in flight there is no safe way out: dismissing would hide
  // the outcome of an action that is already happening on the server.
  const dismiss = busy ? undefined : onCancel;

  return (
    <Modal
      open={open}
      title={title}
      onClose={dismiss}
      closeOnBackdrop={!busy}
      footer={footer}
    >
      <div className="stack-sm">
        {message ? <p>{message}</p> : null}
        {/* Callers add what the API demands here -- an override's reason field. */}
        {children}
      </div>
    </Modal>
  );
}

export default ConfirmDialog;
