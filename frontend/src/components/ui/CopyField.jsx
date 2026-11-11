import { useEffect, useId, useRef, useState } from 'react';
import Button from './Button.jsx';
import Field from './Field.jsx';

const COPIED_MS = 2000;

/**
 * `navigator.clipboard` is only defined on secure origins. SnapAttend is served
 * over plain http on a LAN in exactly the situation this component exists for --
 * SMTP is unconfigured, so the admin has to hand-carry an invite link -- which
 * makes the deprecated execCommand path load-bearing, not legacy cruft.
 */
function copyViaSelection(input) {
  if (!input) return false;
  const wasReadOnly = input.readOnly;
  input.readOnly = false; // iOS Safari will not select inside a read-only field
  input.focus();
  input.setSelectionRange(0, input.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  input.readOnly = wasReadOnly;
  return ok;
}

function CopyField({ value, label, hint }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);
  const timerRef = useRef(null);
  const uid = useId();
  const text = value === null || value === undefined ? '' : String(value);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flagCopied = () => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  const handleCopy = async () => {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        flagCopied();
        return;
      } catch {
        /* permission denied or no user gesture credit -- fall through */
      }
    }
    if (copyViaSelection(inputRef.current)) flagCopied();
  };

  // Select the whole link on focus so Ctrl+C works without reaching for the button.
  const selectAll = (event) => event.target.select();

  return (
    <Field label={label} hint={hint} htmlFor={uid}>
      {({ describedBy }) => (
        <div className="copy-field">
          <input
            ref={inputRef}
            id={uid}
            className="input mono"
            type="text"
            readOnly
            value={text}
            aria-describedby={describedBy}
            spellCheck="false"
            onFocus={selectAll}
          />
          <Button variant="secondary" onClick={handleCopy} aria-live="polite">
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </Field>
  );
}

export default CopyField;
