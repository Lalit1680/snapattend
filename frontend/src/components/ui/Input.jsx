import { forwardRef, useId } from 'react';
import Field from './Field.jsx';

/**
 * Ref is forwarded because pages steal focus: Login focuses the email field on
 * mount, and the enrollment wizard focuses the first control of each new step.
 */
const Input = forwardRef(function Input(
  { label, hint, error, required, id, className = '', ...inputProps },
  ref,
) {
  const uid = useId();
  const controlId = id || uid;
  const classes = ['input', error ? 'has-error' : null, className].filter(Boolean).join(' ');

  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={controlId}>
      {({ describedBy, invalid }) => (
        <input
          ref={ref}
          id={controlId}
          className={classes}
          required={required}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          {...inputProps}
        />
      )}
    </Field>
  );
});

export default Input;
