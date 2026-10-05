import { Link } from 'react-router-dom';
import { useI18n } from '../providers/I18nProvider';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <main className="state-page">
      <section className="state-card">
        <p className="eyebrow">404</p>
        <h1>{t('not_found_title')}</h1>
        <p>{t('not_found_body')}</p>
        <Link to="/" className="btn btn-primary">{t('breadcrumbs_home')}</Link>
      </section>
    </main>
  );
}
