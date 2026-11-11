import { Select } from './ui/index.js';

/** "CS101 — Data Structures", degrading to whichever half the subject has. */
function optionLabel(subject) {
  const code = subject.code ? String(subject.code).trim() : '';
  const name = subject.name ? String(subject.name).trim() : '';
  if (code && name) return `${code} — ${name}`;
  return code || name || 'Untitled subject';
}

/**
 * Subject filter / selector.
 *
 * Presentational on purpose: the subject list belongs to whichever page is
 * already loading it, and a picker that fetched its own would re-request the
 * same list on every page that shows one.
 *
 * `onChange` receives the subject id as a string, not the DOM event — the same
 * convention as the other domain components, which hand over the decision
 * rather than the plumbing.
 */
export default function SubjectPicker({
  value,
  onChange,
  subjects,
  includeAll = false,
  label = 'Subject',
}) {
  // Tolerates the null hole a partially-loaded list can leave: one bad entry
  // should not take the whole filter bar down with it.
  const list = Array.isArray(subjects) ? subjects.filter(Boolean) : [];

  // Always passed, even when disabled or when the caller forgot `onChange`:
  // a `value` with no handler makes React warn about an uncontrolled field.
  const handleChange = (event) => {
    if (onChange) onChange(event.target.value);
  };

  if (list.length === 0) {
    return (
      <Select
        label={label}
        options={[]}
        value=""
        onChange={handleChange}
        disabled
        placeholder="No subjects yet"
        hint="Sessions, rosters and reports are all scoped to a subject, so one has to exist first."
      />
    );
  }

  const options = list.map((subject) => ({
    // `subject_id` is what the session and live payloads call the same value, so
    // a page filtering by the subjects it found on its sessions still works.
    value: String(subject.id ?? subject.subject_id ?? ''),
    label: optionLabel(subject),
  }));

  if (includeAll) {
    // The empty string is dropped by `serializeParams` in lib/api.js, so "all"
    // composes with the other query filters instead of needing its own flag.
    options.unshift({ value: '', label: 'All subjects' });
  }

  return (
    <Select
      label={label}
      options={options}
      value={value ?? ''}
      onChange={handleChange}
      // A placeholder is also empty-valued and disabled, which would shadow
      // "All subjects" and show an unselectable prompt as the current choice.
      placeholder={includeAll ? undefined : 'Select a subject…'}
    />
  );
}
