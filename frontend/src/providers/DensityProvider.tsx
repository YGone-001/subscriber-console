import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { DENSITY_PREFERENCE_KEY, isDensityPreference, type DensityPreference } from '../lib/preferences';

/*
 * Interface density preference.
 *
 * Density is expressed as `data-density` on <html> so the whole stylesheet can respond to
 * it through custom properties, exactly like the theme contract. It is deliberately a
 * separate axis from the theme: an operator may want a dark, compact console or a light,
 * comfortable one.
 *
 * Only the repeating vertical rhythm changes (control height, table rows, section spacing,
 * metric strip height). Type sizes are unchanged, and touch targets in coarse-pointer
 * environments are governed by their own rules and are never reduced by this preference.
 */
type DensityContextValue = {
  density: DensityPreference;
  setDensity: (density: DensityPreference) => void;
  toggleDensity: () => void;
};

const DensityContext = createContext<DensityContextValue | null>(null);

function initialDensity(): DensityPreference {
  try {
    const value = localStorage.getItem(DENSITY_PREFERENCE_KEY);
    return isDensityPreference(value) ? value : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

function persist(density: DensityPreference) {
  try {
    localStorage.setItem(DENSITY_PREFERENCE_KEY, density);
  } catch {
    /* Preference persistence is optional. */
  }
}

export function DensityProvider({ children }: { children: React.ReactNode }) {
  const [density, setDensity] = useState<DensityPreference>(initialDensity);

  useEffect(() => { document.documentElement.dataset.density = density; }, [density]);

  const value = useMemo<DensityContextValue>(() => ({
    density,
    setDensity(next) { persist(next); setDensity(next); },
    toggleDensity() {
      setDensity((current) => {
        const next: DensityPreference = current === 'compact' ? 'comfortable' : 'compact';
        persist(next);
        return next;
      });
    },
  }), [density]);

  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
}

export function useDensity() {
  const value = useContext(DensityContext);
  if (!value) throw new Error('useDensity must be used within DensityProvider');
  return value;
}
