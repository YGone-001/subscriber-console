/*
 * Shared in-page view switch.
 *
 * One page renders one single-level view at a time; the active value is held by
 * the caller (the operations pages persist it in the URL through
 * `useOperationsUrlState`). The switch never owns state, never renders a panel,
 * and never invents a second navigation level.
 */
import type { ReactNode } from 'react';
import styles from '../../styles/modules/ConsolePrimitives.module.css';

export type ViewSwitchOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  /** Optional per-surface data-* hooks for tests and automation, never styling. */
  data?: Record<string, string>;
};

type ViewSwitchProps<T extends string> = {
  options: readonly ViewSwitchOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
};

export function ViewSwitch<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: ViewSwitchProps<T>) {
  return (
    <div
      className={[styles.viewSwitch, className || ''].filter(Boolean).join(' ')}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          {...option.data}
          className={option.value === value ? styles.viewSwitchActive : undefined}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default ViewSwitch;
