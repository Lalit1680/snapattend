import { useId } from 'react';

import { MODE_OPTIONS } from '../lib/constants.js';

/**
 * How the class will be checked in, as radio cards.
 *
 * A dropdown would hide the hints, and the hints are the decision: a teacher is
 * not picking a label, they are picking how the next forty minutes run. Native
 * radios sharing one `name` give arrow-key navigation and the roving tab stop
 * for free, which a div-and-onClick imitation would have to reimplement.
 *
 * `onChange` receives the mode string.
 */
export default function ModePicker({ value, onChange, disabled }) {
  const uid = useId();
  const noteId = `${uid}-note`;

  const handleChange = (event) => {
    if (onChange) onChange(event.target.value);
  };

  // Semantics #11: `verification_mode` is immutable after creation and a PATCH
  // returns 409. Greyed-out controls with no explanation read as a bug, so the
  // locked state says why and what to do instead.
  const note = disabled
    ? 'Fixed for the life of this session. The verification mode is chosen when a session is created and cannot be changed afterwards — end this session and start a new one to switch.'
    : 'Choose before you start: this cannot be changed once the session exists.';

  return (
    <fieldset className="fieldset" disabled={disabled} aria-describedby={noteId}>
      <legend className="legend">Verification mode</legend>
      <p className="field-hint" id={noteId}>
        {note}
      </p>

      <div className="stack-sm">
        {MODE_OPTIONS.map((option) => {
          const selected = option.value === value;
          const inputId = `${uid}-${option.value}`;
          const labelId = `${inputId}-label`;
          const hintId = `${inputId}-hint`;

          return (
            // The label is the card, so the whole card is the hit target — on a
            // phone the hint text is most of the area worth tapping.
            <label
              key={option.value}
              className={selected ? 'mode-option is-selected' : 'mode-option'}
              htmlFor={inputId}
            >
              <input
                type="radio"
                className="check-input"
                id={inputId}
                name={uid}
                value={option.value}
                checked={selected}
                disabled={disabled}
                onChange={handleChange}
                // Named by the mode alone and described by the hint: folding the
                // hint into the name would announce a paragraph per arrow press.
                aria-labelledby={labelId}
                aria-describedby={hintId}
              />
              <span className="stack-sm">
                <span className="strong" id={labelId}>
                  {option.label}
                </span>
                <span className="field-hint" id={hintId}>
                  {option.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
