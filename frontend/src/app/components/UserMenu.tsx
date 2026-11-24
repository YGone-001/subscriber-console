import { useEffect, useRef, useState } from 'react';
import { ChevronRight, HelpCircle, LogOut, Settings, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { getVisibleNavigation } from '../../lib/navigation';
import { isSuperAdmin } from '../../lib/permissions';

const PANEL_ID = 'xcloud-user-menu-panel';

/**
 * Restored header user menu.
 *
 * This is a disclosure of a small set of navigation and action buttons, not an
 * application menu: there is no roving focus, no menu command model and every
 * item is a native button that is reachable with ordinary Tab. It therefore uses
 * the disclosure/popover ARIA pattern (`aria-expanded` + `aria-controls`) rather
 * than the application-menu roles, which would promise keyboard interaction
 * (arrow keys, Home/End, type-ahead) the surface does not implement.
 */
export function UserMenu({ onLogout }: { onLogout: () => void }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        /* Return focus to the control that owns the panel. */
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const displayName = user?.username ?? 'xCloud';
  const roleKey = user?.role ? `role_${user.role}` : 'role_unknown';
  const roleLabel = t(roleKey);
  const visible = getVisibleNavigation(user?.role);
  /*
   * The reference sends an administrator to user management and everyone else to the profile
   * page:
   *
   *   handleProfileSettings = () => router.push(isRoot ? "/users" : "/profile")
   *
   * Picking the first matching route instead silently ignored the role and always landed on
   * /profile - which is the configuration page, not user management.
   *
   * Both entries are still resolved through the navigation authority, so a role that cannot
   * read /users never receives the link.
   */
  const settingsTarget = isSuperAdmin(user?.role) ? '/users' : '/profile';
  const settingsRoute = visible.find((route) => route.targetRoute === settingsTarget);
  const helpRoute = visible.find((route) => route.targetRoute === '/system-health');

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div className="user-menu" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="avatar-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={PANEL_ID}
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
          <div className="user-dropdown" id={PANEL_ID} role="group" aria-label={displayName}>
            <div className="dropdown-profile">
              <span className="avatar-circle large" aria-hidden="true"><User size={22} /></span>
              <div>
                <strong>{displayName}</strong>
                <span>{roleLabel}</span>
              </div>
            </div>
            <div className="dropdown-actions">
              {settingsRoute ? (
                <button type="button" className="dropdown-item" onClick={() => go(settingsRoute.targetRoute)}>
                  <Settings size={16} aria-hidden="true" />
                  {t('profile_settings')}
                </button>
              ) : null}
              {helpRoute ? (
                <button type="button" className="dropdown-item" onClick={() => go(helpRoute.targetRoute)}>
                  <HelpCircle size={16} aria-hidden="true" />
                  {t('help_support')}
                </button>
              ) : null}
              <div className="dropdown-separator" />
              <button
                type="button"
                className="dropdown-item text-danger"
                onClick={() => { setOpen(false); onLogout(); }}
              >
                <LogOut size={16} aria-hidden="true" />
                {t('logout')}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
