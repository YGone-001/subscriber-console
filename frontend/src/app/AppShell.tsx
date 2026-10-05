import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';
import { useI18n } from '../providers/I18nProvider';
import { ToastRegion } from '../providers/ToastProvider';
import { AppHeader } from './components/AppHeader';
import { AppSidebar } from './components/AppSidebar';
import { NavigationBreadcrumbs } from './components/NavigationBreadcrumbs';
import { NavigationTabBar } from './components/NavigationTabBar';

const DESKTOP_SHELL_QUERY = '(min-width: 981px)';

function canUseShortcut(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !(element?.tagName === 'INPUT' || element?.tagName === 'TEXTAREA' || element?.isContentEditable);
}

/**
 * Application shell.
 *
 * Orchestration only: header, sidebar, navigation bars, content outlet and global
 * overlays. Detailed controls live in dedicated shell components.
 */
export function AppShell() {
  const { refresh } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_SHELL_QUERY).matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia(DESKTOP_SHELL_QUERY).matches);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_SHELL_QUERY);
    const update = () => { setDesktop(media.matches); setSidebarOpen(media.matches); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'b' && canUseShortcut(event.target)) {
        event.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        if (!desktop) setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [desktop]);

  useEffect(() => {
    if (!desktop && sidebarOpen) {
      const previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = previous; };
    }
    return undefined;
  }, [desktop, sidebarOpen]);

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      await refresh();
      navigate('/login', { replace: true });
    }
  }

  return (
    <div className="layout-root">
      <a className="skip-link" href="#main-content">{t('skip_to_content')}</a>
      <AppHeader
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        paletteOpen={paletteOpen}
        onOpenPalette={() => setPaletteOpen(true)}
        onClosePalette={() => setPaletteOpen(false)}
        onLogout={() => void logout()}
      />
      <div className="layout-body">
        {!desktop && sidebarOpen ? (
          <button
            type="button"
            className="sidebar-mobile-backdrop"
            aria-label={t('close')}
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}
        <AppSidebar sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} isMobileShell={!desktop} />
        <div className="layout-content-area">
          <NavigationTabBar />
          <NavigationBreadcrumbs />
          <main id="main-content" tabIndex={-1} className="layout-main">
            <Outlet />
          </main>
        </div>
      </div>
      <ToastRegion />
    </div>
  );
}
