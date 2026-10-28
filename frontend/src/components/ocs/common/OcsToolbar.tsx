/*
 * OCS list toolbar primitives.
 *
 * The three OCS list surfaces shared a copy-pasted controls bar whose search box
 * fired one request per keystroke and whose filters had no visible reset. These
 * components keep the historical `ocs-controls-bar` DOM vocabulary while making
 * the behaviour explicit:
 *
 *   - `OcsSearchField` debounces typing and reports the committed value, so the
 *     request count is bounded by deliberate pauses rather than key presses;
 *   - `OcsFilterSelect` always carries a real label association, so the control
 *     is announced by name instead of by value only;
 *   - `OcsToolbar` reserves a trailing action slot (reset, create, export) so
 *     every list puts its actions in the same place.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { FilterX, Search } from 'lucide-react';

interface OcsToolbarProps {
  children: React.ReactNode;
  actions?: React.ReactNode;
}

export function OcsToolbar({ children, actions }: OcsToolbarProps) {
  return (
    <div className="ocs-controls-bar">
      <div className="ocs-toolbar-fields">{children}</div>
      {actions ? <div className="ocs-toolbar-actions">{actions}</div> : null}
    </div>
  );
}

interface OcsSearchFieldProps {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder: string;
  /** Rewrites raw input before it reaches the caller (for example digits only). */
  normalize?: (value: string) => string;
  /** Milliseconds between the last keystroke and the committed value. */
  debounceMs?: number;
}

export function OcsSearchField({
  value,
  onCommit,
  label,
  placeholder,
  normalize,
  debounceMs = 300,
}: OcsSearchFieldProps) {
  const [draft, setDraft] = useState(value);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  /* An external reset (clear filters, back navigation) must win over the draft. */
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => commitRef.current(draft), debounceMs);
    return () => window.clearTimeout(timer);
  }, [draft, value, debounceMs]);

  return (
    <div className="ocs-search-group">
      <Search size={16} className="ocs-search-icon" aria-hidden="true" />
      <input
        type="search"
        inputMode={normalize ? 'numeric' : undefined}
        className="ocs-search-input"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(normalize ? normalize(event.target.value) : event.target.value)}
      />
    </div>
  );
}

interface OcsFilterSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}

export function OcsFilterSelect({ label, value, onChange, options }: OcsFilterSelectProps) {
  /* A generated id keeps the label association unique. Deriving it from the
   * translated label produced duplicate ids for every non-latin locale, where
   * transliteration stripped the whole string. */
  const id = useId();
  return (
    <div className="ocs-filter-field">
      <label className="ocs-filter-label" htmlFor={id}>{label}</label>
      <select
        id={id}
        className="ocs-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

interface OcsResetFiltersProps {
  active: boolean;
  onReset: () => void;
  label: string;
}

export function OcsResetFilters({ active, onReset, label }: OcsResetFiltersProps) {
  return (
    <button
      type="button"
      className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto"
      onClick={onReset}
      disabled={!active}
      aria-label={label}
      title={label}
    >
      <FilterX size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
