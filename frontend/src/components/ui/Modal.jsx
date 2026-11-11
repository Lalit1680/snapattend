import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** display:none elements have no client rects, so they are skipped in the trap. */
function focusableWithin(node) {
  return Array.from(node.querySelectorAll(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

function Modal({
  open,
  title,
  onClose,
  footer,
  wide = false,
  closeOnBackdrop = true,
  children,
}) {
  const dialogRef = useRef(null);
  const backdropRef = useRef(null);
  const pressStartedOnBackdrop = useRef(false);
  const titleId = useId();

  // The Escape/trap effect must not re-run every render just because the parent
  // passed a fresh onClose closure -- that would re-steal focus mid-typing.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    // Restore the exact prior value: the mobile sidebar drawer also locks scroll,
    // and clearing to '' would unlock the page behind it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    if (dialogRef.current) dialogRef.current.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        // Escape during an IME composition cancels the composition, not the dialog.
        if (event.isComposing) return;
        if (onCloseRef.current) {
          event.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;

      const node = dialogRef.current;
      if (!node) return;
      const focusable = focusableWithin(node);
      if (focusable.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !node.contains(active);
      if (event.shiftKey && (outside || active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (outside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture phase so a keystroke is trapped before any page-level handler
    // (the live console's shortcuts) sees it.
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const handleBackdropMouseDown = (event) => {
    pressStartedOnBackdrop.current = event.target === backdropRef.current;
  };

  const handleBackdropClick = (event) => {
    if (!closeOnBackdrop || !onClose) return;
    // Both ends of the press must be the backdrop: a text selection that starts
    // in the dialog and drags outside would otherwise discard a half-typed
    // override reason.
    if (event.target !== backdropRef.current || !pressStartedOnBackdrop.current) return;
    pressStartedOnBackdrop.current = false;
    onClose();
  };

  // Portalled to <body>: a modal opened from a row inside .table-wrap would
  // otherwise be clipped by that element's overflow.
  return createPortal(
    <div
      className="modal-backdrop"
      ref={backdropRef}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className={['modal', wide ? 'is-wide' : null].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : 'Dialog'}
        ref={dialogRef}
        tabIndex={-1}
      >
        {title || onClose ? (
          <div className="modal-header">
            {title ? (
              <h2 className="modal-title" id={titleId}>
                {title}
              </h2>
            ) : null}
            {onClose ? (
              <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export default Modal;
