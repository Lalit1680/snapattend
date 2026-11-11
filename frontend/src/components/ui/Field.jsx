import { Children, cloneElement, isValidElement, useId } from 'react';

/**
 * Label / hint / error chrome for a single control.
 *
 * `children` may be either a render function -- which receives the wiring the
 * control needs -- or a single element, which is cloned with that wiring
 * applied. The second form is what keeps a hand-rolled control (a date range, a
 * radio group) labelled without every page remembering to invent matching ids.
 */
function Field({ label, hint, error, required = false, htmlFor, children }) {
  const uid = useId();
  const controlId = htmlFor || `${uid}-control`;
  const hintId = hint ? `${uid}-hint` : null;
  const errorId = error ? `${uid}-error` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const invalid = error ? 'true' : undefined;

  let content;
  if (typeof children === 'function') {
    content = children({ id: controlId, describedBy, invalid });
  } else if (Children.count(children) === 1 && isValidElement(children)) {
    const own = children.props || {};
    content = cloneElement(children, {
      id: own.id || controlId,
      'aria-describedby': own['aria-describedby'] || describedBy,
      'aria-invalid': own['aria-invalid'] || invalid,
    });
  } else {
    content = children;
  }

  return (
    <div className="field">
      {label ? (
        <label className="field-label" htmlFor={controlId}>
          {label}
          {/* Decorative: assistive tech learns "required" from the control itself. */}
          {required ? (
            <span className="field-required" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {content}
      {hint ? (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default Field;
