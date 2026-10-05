import { useEffect, useRef, useState } from 'react';
import { ChevronRight, HelpCircle, LogOut, Settings, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { getVisibleNavigation } from '../../lib/navigation';

/**
 * Restored header user menu.
 *
 * Exposes current session facts only (username, role) plus the current logout
 * transport and links to routes the current navigation authority already grants.
 */
export function UserMenu({ onLogout }: { onLogout: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const displayName = user?.username ?? 'xCloud';
  const roleKey = user?.role ? `role_${user.role}` : 'role_unknown';
  const roleLabel = t(roleKey);
  const visible = getVisibleNavigation(user?.role);
  const settingsRoute = visible.find((route) => route.targetRoute === '/users' || route.targetRoute === '/profile');
  const helpRoute = visible.find((route) => route.targetRoute === '/system-health');

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div className="user-menu" ref={containerRef}>
      <button
        type="button"
        className="avatar-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="avatar-circle" aria-hidden="true"><User size={20} /></span>
        <span className="avatar-meta">
          <strong>{displayName}</strong>
          <span>{roleLabel}</span>
        </span>
        <ChevronRight size={16} className={open ? 'avatar-chevron open' : 'avatar-chevron'} aria-hidden="true" />
      </button>

      {open ? (
        <>
          <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="user-dropdown" role="menu">
            <div className="dropdown-profile">
              <span className="avatar-circle large" aria-hidden="true"><User size={22} /></span>
              <div>
                <strong>{displayName}</strong>
                <span>{roleLabel}</span>
              </div>
            </div>
            <div className="dropdown-actions">
              {settingsRoute ? (
                <button type="button" className="dropdown-item" role="menuitem" onClick={() => go(settingsRoute.targetRoute)}>
                  <Settings size={16} />
                  {t('account_settings')}
                </button>
              ) : null}
              {helpRoute ? (
                <button type="button" className="dropdown-item" role="menuitem" onClick={() => go(helpRoute.targetRoute)}>
                  <HelpCircle size={16} />
                  {t('nav_system_health')}
                </button>
              ) : null}
              <div className="dropdown-separator" />
              <button
                type="button"
                className="dropdown-item text-danger"
                role="menuitem"
                onClick={() => { setOpen(false); onLogout(); }}
              >
                <LogOut size={16} />
                {t('logout')}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
