/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/CommandPalette.tsx
 *
 * Adaptations, all at the runtime boundary:
 *   - The historical route table is NOT ported. Route entries come from the current
 *     navigation authority (`lib/navigation`), so the palette stays role-filtered
 *     by the same table the sidebar uses and can never surface an unreachable route.
 *   - The App Router replaced by the compatibility router, which refuses non-local
 *     destinations — so a search result can never navigate off the SPA.
 *   - The raw debounced `fetch` replaced by the current read client driven by a
 *     debounced key, which gives cancellation on key change for free.
 *   - The overlay markup replaced by the shared `Dialog` primitive, so focus
 *     trapping and restoration match every other dialog in the console.
 *
 * The category tabs, grouped results, row geometry and badge vocabulary are the
 * reference's.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElementType, KeyboardEvent } from 'react';
import {
  Command,
  CornerDownLeft,
  CreditCard,
  Download,
  FileUp,
  Languages,
  Plus,
  Search,
  SunMoon,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useTheme } from '../../providers/ThemeProvider';
import { useAuth } from '../../providers/AuthProvider';
import { Dialog } from '../../components/ui/Dialog';
import { useRead } from '../../lib/api/use-read';
import { requestAnalyticsSync } from '../../features/system-health/system-health-api';
import { useAppRouter } from '../../lib/ui-compat/router';
import { filterNavigation, getVisibleNavigation } from '../../lib/navigation';

const RECENT_PAGES_STORAGE_KEY = 'XCLOUD_RECENT_PAGES';
const REMOTE_SEARCH_DELAY_MS = 250;

type PaletteItem = {
  id: string;
  label: string;
  desc: string;
  icon: ElementType;
  type: 'navigation' | 'action' | 'imsi' | 'profile';
  category: 'pages' | 'actions' | 'data';
  path?: string;
  actionKey?: string;
};

type ApiSearchItem = {
  id: string;
  label: string;
  desc: string;
  type: 'imsi' | 'profile';
  path: string;
};

type Category = 'all' | 'pages' | 'actions' | 'data';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onAction?: (actionKey: string) => void;
}

export function CommandPalette({ isOpen, onClose, onAction }: CommandPaletteProps) {
  const { t, locale, setLocale } = useI18n();
  const { resolvedTheme, setPreference } = useTheme();
  const { user } = useAuth();
  const router = useAppRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<Category>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setDebouncedQuery('');
    setSelectedIndex(0);
    setActiveCategory('all');
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  /* Remote search is debounced into the read-client key, so a superseded query cancels. */
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), REMOTE_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const searchKey = isOpen && debouncedQuery.length >= 2
    ? `/api/search?q=${encodeURIComponent(debouncedQuery)}&limit=8`
    : null;
  const { data: searchData, isLoading: isSearching } = useRead<{ results?: ApiSearchItem[] }>(searchKey);

  const navItems = useMemo<PaletteItem[]>(() => (
    filterNavigation(getVisibleNavigation(user?.role), '', t).map((route) => ({
      id: `nav-${route.route === '/' ? 'dashboard' : route.route.slice(1).replaceAll('/', '-')}`,
      label: t(route.labelKey),
      desc: route.targetRoute,
      icon: route.icon,
      path: route.targetRoute,
      type: 'navigation' as const,
      category: 'pages' as const,
    }))
  ), [t, user?.role]);

  const actionItems = useMemo<PaletteItem[]>(() => [
    { id: 'act-new-sub', label: t('cp_act_new_sub'), desc: t('cp_act_new_sub_desc'), icon: Plus, type: 'action', category: 'actions', actionKey: 'new-subscriber' },
    { id: 'act-import', label: t('cp_act_import'), desc: t('cp_act_import_desc'), icon: FileUp, type: 'action', category: 'actions', actionKey: 'import-csv' },
    { id: 'act-export', label: t('cp_act_export'), desc: t('cp_act_export_desc'), icon: Download, type: 'action', category: 'actions', actionKey: 'export-csv' },
    { id: 'act-sync', label: t('cp_act_sync'), desc: t('cp_act_sync_desc'), icon: Zap, type: 'action', category: 'actions', actionKey: 'sync-telemetry' },
    {
      id: 'act-toggle-theme',
      label: resolvedTheme === 'dark' ? t('theme_switch_light') : t('theme_switch_dark'),
      desc: t('cp_act_theme_desc'),
      icon: SunMoon,
      type: 'action',
      category: 'actions',
      actionKey: 'toggle-theme',
    },
    {
      id: 'act-switch-lang',
      label: locale === 'en' ? t('cp_lang_zh') : t('cp_lang_en'),
      desc: locale === 'en' ? t('cp_lang_zh_desc') : t('cp_lang_en_desc'),
      icon: Languages,
      type: 'action',
      category: 'actions',
      actionKey: 'toggle-language',
    },
    { id: 'act-clear-history', label: t('nav_crumb_clear_recent'), desc: t('cp_act_clear_history_desc'), icon: Trash2, type: 'action', category: 'actions', actionKey: 'clear-recent-history' },
  ], [t, resolvedTheme, locale]);

  const remoteItems = useMemo<PaletteItem[]>(() => (
    (searchData?.results || []).map((item) => ({
      id: item.id,
      label: item.label,
      desc: item.type === 'imsi' ? t('cp_search_open_sub') : t('cp_search_open_prof'),
      icon: item.type === 'imsi' ? Users : CreditCard,
      type: item.type,
      category: 'data' as const,
      path: item.path,
    }))
  ), [searchData, t]);

  const filteredItems = useMemo<PaletteItem[]>(() => {
    const needle = query.trim().toLowerCase();
    const candidates: PaletteItem[] = [];

    if (activeCategory === 'all' || activeCategory === 'actions') {
      actionItems.forEach((item) => {
        if (!needle || `${item.label} ${item.desc}`.toLowerCase().includes(needle)) candidates.push(item);
      });
    }

    if (activeCategory === 'all' || activeCategory === 'pages') {
      navItems.forEach((item) => {
        if (!needle || `${item.label} ${item.desc}`.toLowerCase().includes(needle)) candidates.push(item);
      });
    }

    if ((activeCategory === 'all' || activeCategory === 'data') && needle.length >= 2) {
      candidates.push(...remoteItems);
    }

    return candidates;
  }, [activeCategory, actionItems, navItems, query, remoteItems]);

  const activeSelectedIndex = Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));

  const handleSelect = useCallback((item: PaletteItem) => {
    onClose();
    if (item.type === 'navigation' || item.type === 'imsi' || item.type === 'profile') {
      /* The compatibility router refuses non-local destinations by construction. */
      router.push(item.path || '/');
      return;
    }
    if (item.type !== 'action' || !item.actionKey) return;

    if (item.actionKey === 'toggle-language') {
      setLocale(locale === 'en' ? 'zh' : 'en');
    } else if (item.actionKey === 'toggle-theme') {
      setPreference(resolvedTheme === 'dark' ? 'light' : 'dark');
    } else if (item.actionKey === 'clear-recent-history') {
      try { localStorage.removeItem(RECENT_PAGES_STORAGE_KEY); } catch { /* preference persistence is optional */ }
    } else if (item.actionKey === 'sync-telemetry') {
      void requestAnalyticsSync().catch(() => undefined);
    } else if (onAction) {
      onAction(item.actionKey);
    } else if (item.actionKey === 'new-subscriber' || item.actionKey === 'import-csv' || item.actionKey === 'export-csv') {
      router.push('/subscribers');
    }
  }, [locale, onAction, onClose, resolvedTheme, router, setLocale, setPreference]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((previous) => Math.min(previous + 1, Math.max(0, filteredItems.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((previous) => Math.max(previous - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = filteredItems[activeSelectedIndex];
      if (item) handleSelect(item);
    }
  };

  if (!isOpen) return null;

  const actionResults = filteredItems.filter((item) => item.type === 'action');
  const navResults = filteredItems.filter((item) => item.type === 'navigation');
  const searchResults = filteredItems.filter((item) => item.type === 'imsi' || item.type === 'profile');

  let globalIndex = 0;
  const nextIndex = () => globalIndex++;

  const renderRow = (item: PaletteItem, index: number, badge?: string) => {
    const Icon = item.icon;
    const selected = activeSelectedIndex === index;
    return (
      <button
        type="button"
        key={item.id}
        onClick={() => handleSelect(item)}
        onMouseEnter={() => setSelectedIndex(index)}
        className={`cp-item-row ${selected ? 'cp-item-row-selected' : ''}`}
      >
        <span className="cp-item-icon-box">
          <Icon size={16} aria-hidden="true" />
        </span>
        <span className="cp-item-content">
          <span className={`cp-item-label ${item.type === 'imsi' ? 'cp-item-label-mono' : ''}`}>{item.label}</span>
          <span className="cp-item-desc">{item.desc}</span>
        </span>
        {badge && (
          <span className={`cp-item-badge cp-badge-${item.type === 'navigation' ? 'nav' : item.type}`}>
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      ariaLabel={t('cp_title')}
      initialFocusRef={inputRef}
      overlayClassName="cp-overlay"
      className="cp-modal"
      onKeyDown={handleKeyDown}
    >
      <div className="cp-search-header">
        <Search size={20} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          placeholder={t('cp_placeholder')}
          aria-label={t('cp_placeholder')}
          className="cp-search-input"
        />
        <kbd className="cp-kbd-shortcut">ESC</kbd>
      </div>

      <div className="cp-category-tabs">
        {(['all', 'pages', 'actions', 'data'] as const).map((category) => (
          <button
            key={category}
            type="button"
            className={`cp-category-tab ${activeCategory === category ? 'active' : ''}`}
            onClick={() => { setActiveCategory(category); setSelectedIndex(0); }}
          >
            {t(`cp_cat_${category}`)}
          </button>
        ))}
      </div>

      <div className="cp-results-container">
        {actionResults.length > 0 && (
          <div>
            <div className="cp-group-header">{t('cp_group_actions')}</div>
            {actionResults.map((item) => renderRow(item, nextIndex()))}
          </div>
        )}

        {navResults.length > 0 && (
          <div>
            <div className="cp-group-header-mt">{t('cp_group_nav')}</div>
            {navResults.map((item) => renderRow(item, nextIndex(), t('cp_badge_navigate')))}
          </div>
        )}

        {searchResults.length > 0 && (
          <div>
            <div className="cp-group-header-mt">{t('cp_group_search')}</div>
            {searchResults.map((item) => renderRow(item, nextIndex(), item.type === 'imsi' ? 'IMSI' : 'Profile'))}
          </div>
        )}

        {isSearching && searchResults.length === 0 && (
          <div className="cp-status-msg">{t('cp_searching')}</div>
        )}

        {!isSearching && filteredItems.length === 0 && (
          <div className="cp-no-results">{t('cp_no_results').replace('{query}', query)}</div>
        )}
      </div>

      <div className="cp-footer">
        <span className="cp-footer-hint">
          <kbd className="cp-kbd-small">↑</kbd>
          <kbd className="cp-kbd-small">↓</kbd>
          {t('cp_hint_navigate')}
        </span>
        <span className="cp-footer-hint">
          <kbd className="cp-kbd-small"><CornerDownLeft size={12} strokeWidth={2.25} aria-hidden="true" /></kbd>
          {t('cp_hint_select')}
        </span>
        <span className="cp-footer-branding">
          <Command size={11} /> xCloud
        </span>
      </div>
    </Dialog>
  );
}
