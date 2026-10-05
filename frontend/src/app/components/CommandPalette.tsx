import { useEffect, useMemo, useRef, useState } from 'react';
import { Command, CornerDownLeft, Languages, Moon, Search, Sun } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getVisibleNavigation, filterNavigation } from '../../lib/navigation';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { useTheme } from '../../providers/ThemeProvider';

type PaletteEntry = {
  id: string;
  group: 'navigation' | 'action';
  label: string;
  description: string;
  icon: React.ReactNode;
  run: () => void;
};

/**
 * Restored command palette.
 *
 * Route entries are derived from the current navigation authority and are
 * therefore already role-filtered; the palette never hard-codes a route list and
 * never surfaces a route the current session cannot reach.
 */
export function CommandPalette({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const { resolvedTheme, setPreference } = useTheme();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const routes = useMemo(() => getVisibleNavigation(user?.role), [user?.role]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const navigationEntries: PaletteEntry[] = filterNavigation(routes, query, t).map((route) => ({
      id: `nav:${route.targetRoute}`,
      group: 'navigation',
      label: t(route.labelKey),
      description: route.targetRoute,
      icon: <route.icon size={16} />,
      run: () => navigate(route.targetRoute),
    }));
    const actionEntries: PaletteEntry[] = [
      {
        id: 'action:theme',
        group: 'action',
        label: t('theme'),
        description: resolvedTheme === 'dark' ? t('light') : t('dark'),
        icon: resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />,
        run: () => setPreference(resolvedTheme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'action:language',
        group: 'action',
        label: t('language'),
        description: locale === 'en' ? '中文' : 'English',
        icon: <Languages size={16} />,
        run: () => setLocale(locale === 'en' ? 'zh' : 'en'),
      },
    ];
    return [...navigationEntries, ...actionEntries];
  }, [routes, query, t, resolvedTheme, setPreference, locale, setLocale, navigate]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => `${entry.label} ${entry.description}`.toLowerCase().includes(needle));
  }, [entries, query]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0))); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        const entry = filtered[activeIndex];
        if (entry) { onClose(); entry.run(); }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, filtered, activeIndex, onClose]);

  if (!isOpen) return null;

  const navigationResults = filtered.filter((entry) => entry.group === 'navigation');
  const actionResults = filtered.filter((entry) => entry.group === 'action');

  const renderEntry = (entry: PaletteEntry) => {
    const index = filtered.indexOf(entry);
    return (
      <button
        type="button"
        key={entry.id}
        className={`cp-item-row ${index === activeIndex ? 'cp-item-row-selected' : ''}`}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => { onClose(); entry.run(); }}
      >
        <span className="cp-item-icon-box">{entry.icon}</span>
        <span className="cp-item-content">
          <span className="cp-item-label">{entry.label}</span>
          <span className="cp-item-desc">{entry.description}</span>
        </span>
        <span className="cp-badge-nav">{entry.group === 'action' ? t('cp_action') : t('cp_navigation')}</span>
      </button>
    );
  };

  return (
    <div className="cp-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="cp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('command_palette')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cp-search-header">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            className="cp-search-input"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            placeholder={t('search_navigation')}
            aria-label={t('search_navigation')}
          />
          <kbd className="cp-kbd-shortcut">Esc</kbd>
        </div>

        <div className="cp-results-container">
          {filtered.length === 0 ? (
            <div className="cp-no-results">{t('cp_no_results')}</div>
          ) : (
            <>
              {navigationResults.length > 0 ? <div className="cp-group-header">{t('cp_navigation')}</div> : null}
              {navigationResults.map(renderEntry)}
              {actionResults.length > 0 ? <div className="cp-group-header">{t('cp_action')}</div> : null}
              {actionResults.map(renderEntry)}
            </>
          )}
        </div>

        <div className="cp-footer">
          <span className="cp-footer-hint"><Command size={12} /><kbd className="cp-kbd-small">↑</kbd><kbd className="cp-kbd-small">↓</kbd>{t('cp_hint_navigate')}</span>
          <span className="cp-footer-hint"><CornerDownLeft size={12} /><kbd className="cp-kbd-small">Enter</kbd>{t('cp_hint_select')}</span>
          <span className="cp-footer-branding">xCloud</span>
        </div>
      </div>
    </div>
  );
}
