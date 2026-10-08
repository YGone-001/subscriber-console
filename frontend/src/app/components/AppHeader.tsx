import { Command, Menu } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { CommandPalette } from './CommandPalette';
import { LanguageSwitcher } from './LanguageSwitcher';
import { NocSentinel } from './NocSentinel';
import { NotificationCenter } from './NotificationCenter';
import { ThemeSwitcher } from './ThemeSwitcher';
import { UserMenu } from './UserMenu';

/**
 * Restored application header.
 *
 * Composition: brand lockup (repository-owned xCloud mark + wordmark), divider,
 * sidebar toggle, command palette trigger with Ctrl+K hint, then the operational
 * cluster (NOC sentinel, notification centre, language, theme) and the user menu.
 */
export function AppHeader({
  sidebarOpen,
  onToggleSidebar,
  paletteOpen,
  onOpenPalette,
  onClosePalette,
  onLogout,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  paletteOpen: boolean;
  onOpenPalette: () => void;
  onClosePalette: () => void;
  onLogout: () => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <CommandPalette isOpen={paletteOpen} onClose={onClosePalette} />
      <header className="app-header">
        <div className="header-left">
          <div className="brand-lockup">
            <span className="brand-mark">
              <img src="/images/xCloud_picture.png" alt={t('brand_alt')} width={1254} height={1254} />
            </span>
            <span className="brand-name">xCloud</span>
          </div>

          <div className="header-divider" aria-hidden="true" />

          <button
            type="button"
            className="icon-button"
            onClick={onToggleSidebar}
            title={sidebarOpen ? t('sidebar_collapse_hint') : t('sidebar_expand_hint')}
            aria-label={sidebarOpen ? t('collapse_sidebar') : t('expand_sidebar')}
            aria-controls="xcloud-primary-sidebar"
            aria-expanded={sidebarOpen}
          >
            <Menu size={22} />
          </button>

          <button
            type="button"
            className="command-button"
            onClick={onOpenPalette}
            title={t('command_palette')}
            aria-keyshortcuts="Control+K"
          >
            <Command size={14} aria-hidden="true" />
            <span>{t('search_navigation')}</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>

        <div className="header-right">
          <NocSentinel />
          <NotificationCenter />
          <LanguageSwitcher />
          <ThemeSwitcher />
          <div className="header-divider" aria-hidden="true" />
          <UserMenu onLogout={onLogout} />
        </div>
      </header>
    </>
  );
}
