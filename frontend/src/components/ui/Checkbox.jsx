import { useId } from 'react';

function Checkbox({ label, hint, checked, onChange, disabled, id }) {
  const uid = useId();
  const controlId = id || uid;
  const hintId = hint ? `${uid}-hint` : undefined;
  // Without onChange the box is display-only; readOnly is what stops React
  // warning about a controlled value it has no way to update.
  const readOnly = !onChange;

  return (
    <div className="check">
      <input
        type="checkbox"
        className="check-input"
        id={controlId}
        checked={Boolean(checked)}
        onChange={onChange}
        disabled={disabled}
        readOnly={readOnly}
        aria-describedby={hintId}
      />
      <label className="check-label" htmlFor={controlId}>
        {label}
        {/* Inside the label so clicking the explanation still toggles the box. */}
        {hint ? (
          <span className="field-hint" id={hintId}>
            {hint}
          </span>
        ) : null}
      </label>
    </div>
  );
}

export default Checkbox;
