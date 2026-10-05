import { NavLink, useLocation } from 'react-router-dom';
import { getNavigationRoute, getVisibleNavigation, matchesRoute } from '../../lib/navigation';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';

/**
 * Restored navigation tab bar.
 *
 * Tabs are derived from the current navigation authority so the presentation can
 * never diverge from the role-filtered route set.
 */
export function NavigationTabBar() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const routes = getVisibleNavigation(user?.role);
  const current = getNavigationRoute(pathname);

  return (
    <nav className="nav-tab-bar" aria-label={t('navigation')}>
      <div className="nav-mobile-current">
        {current ? (
          <>
            <current.icon size={16} aria-hidden="true" />
            <strong>{t(current.labelKey)}</strong>
          </>
        ) : null}
      </div>
      <div className="nav-tab-track">
        {routes.map((route) => {
          const active = matchesRoute(route.targetRoute, pathname) || (route.targetRoute !== '/' && pathname.startsWith(`${route.targetRoute}/`));
          const Icon = route.icon;
          return (
            <NavLink
              key={route.targetRoute}
              to={route.targetRoute}
              className={active ? 'nav-tab-item active' : 'nav-tab-item'}
              aria-current={active ? 'page' : undefined}
            >
              <span className="nav-tab-link">
                <span className="nav-tab-icon" aria-hidden="true"><Icon size={15} /></span>
                <span className="nav-tab-label">{t(route.labelKey)}</span>
              </span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
