import { Rows2, Rows3 } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useDensity } from '../../providers/DensityProvider';

/*
 * Comfortable / compact density toggle.
 *
 * Density only tightens the repeating vertical rhythm; type sizes and touch-target rules
 * are untouched, so this is a scanning-density control rather than a "make everything
 * smaller" switch.
 */
export function DensitySwitcher() {
  const { t } = useI18n();
  const { density, toggleDensity } = useDensity();
  const compact = density === 'compact';
  const label = compact ? t('density_compact') : t('density_comfortable');

  return (
    <button
      type="button"
      className="density-switcher-btn"
      onClick={toggleDensity}
      title={label}
      aria-label={label}
      aria-pressed={compact}
      data-active={compact || undefined}
    >
      {compact ? <Rows2 size={18} /> : <Rows3 size={18} />}
    </button>
  );
}
