import { useLocation } from 'react-router-dom';
import { getNavigationRoute } from '../lib/navigation';
import { useI18n } from '../providers/I18nProvider';

export function MigrationPendingPage() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const route = getNavigationRoute(pathname);
  return <section className="migration-pending" aria-labelledby="migration-pending-title"><p className="eyebrow">{route ? t(route.labelKey) : ''}</p><h1 id="migration-pending-title">{t('pending_title')}</h1><p>{t('pending_body')}</p></section>;
}
