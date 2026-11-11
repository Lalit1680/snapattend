import { forwardRef, useId } from 'react';
import Field from './Field.jsx';

const Textarea = forwardRef(function Textarea(
  { label, hint, error, required, id, rows = 3, className = '', ...textareaProps },
  ref,
) {
  const uid = useId();
  const controlId = id || uid;
  const classes = ['textarea', error ? 'has-error' : null, className].filter(Boolean).join(' ');

  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={controlId}>
      {({ describedBy, invalid }) => (
        <textarea
          ref={ref}
          id={controlId}
          className={classes}
          rows={rows}
          required={required}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          {...textareaProps}
        />
      )}
    </Field>
  );
});

export default Textarea;
