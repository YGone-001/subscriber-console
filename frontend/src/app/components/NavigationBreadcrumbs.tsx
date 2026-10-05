import { ChevronRight, Home } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { getBreadcrumbs } from '../../lib/navigation';
import { useI18n } from '../../providers/I18nProvider';

/**
 * Restored breadcrumb bar.
 *
 * Crumbs are derived from the current route authority, including dynamic
 * segments, and rendered with React Router links and ARIA navigation semantics.
 */
export function NavigationBreadcrumbs() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const crumbs = getBreadcrumbs(pathname);

  return (
    <nav className="nav-breadcrumbs-bar" aria-label={t('breadcrumbs_label')}>
      <div className="nav-breadcrumbs-left">
        <Link to="/" className="nav-breadcrumb-home" aria-label={t('breadcrumbs_home')}>
          <Home size={14} aria-hidden="true" />
        </Link>
        {crumbs.filter((crumb) => crumb.labelKey !== 'breadcrumbs_home').map((crumb, index) => (
          <span className="nav-breadcrumb-segment" key={`${crumb.path ?? 'current'}-${index}`}>
            <ChevronRight size={14} className="nav-breadcrumb-separator" aria-hidden="true" />
            {crumb.current || !crumb.path ? (
              <span className="nav-breadcrumb-current" aria-current="page">{t(crumb.labelKey)}</span>
            ) : (
              <Link to={crumb.path} className="nav-breadcrumb-link">{t(crumb.labelKey)}</Link>
            )}
          </span>
        ))}
      </div>
    </nav>
  );
}
