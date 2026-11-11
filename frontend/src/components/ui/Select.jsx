import { forwardRef, useId } from 'react';
import Field from './Field.jsx';

const Select = forwardRef(function Select(
  { label, hint, error, required, id, options = [], placeholder, className = '', ...selectProps },
  ref,
) {
  const uid = useId();
  const controlId = id || uid;
  const classes = ['select', error ? 'has-error' : null, className].filter(Boolean).join(' ');

  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={controlId}>
      {({ describedBy, invalid }) => (
        <select
          ref={ref}
          id={controlId}
          className={classes}
          required={required}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          {...selectProps}
        >
          {/* An empty-valued option so `value=""` shows the prompt instead of
              silently reading as the first real option; disabled so it cannot be
              chosen again, and so `required` still rejects an untouched select. */}
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={String(option.value)} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
});

export default Select;
