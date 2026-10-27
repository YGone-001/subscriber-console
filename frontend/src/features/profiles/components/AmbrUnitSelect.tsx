/*
 * The unit half of an AMBR-style input pair. One authority for resolving the
 * stored unit, so an absent unit reads as unset instead of silently becoming
 * Kbps, and bps (index 0) survives selection and save.
 */
import { AMBR_UNITS } from '../../subscribers/components/subscriber/utils';
import { ambrSelectUnit } from '../profile-format';

export interface AmbrUnitSelectProps {
  unit: unknown;
  unsetLabel: string;
  onChange: (unit: number) => void;
}

export function AmbrUnitSelect({ unit, unsetLabel, onChange }: AmbrUnitSelectProps) {
  const selected = ambrSelectUnit(unit);
  return (
    <select value={selected} onChange={(event) => onChange(Number(event.target.value))}>
      {selected === '' && <option value="" disabled>{unsetLabel}</option>}
      {AMBR_UNITS.map((entry) => (
        <option key={entry.val} value={entry.val}>{entry.label}</option>
      ))}
    </select>
  );
}
