import { useEffect, useState } from 'react';

/**
 * Trailing-edge debounce for search inputs.
 *
 * The input itself stays uncontrolled-feeling (it updates on every keystroke);
 * only the value that reaches a request lags behind, so typing "smith" fires one
 * query instead of five.
 */
export function useDebouncedValue(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);

  return debounced;
}

export default useDebouncedValue;
