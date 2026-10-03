import { useAuth } from '../providers/AuthProvider';
import { useI18n } from '../providers/I18nProvider';

export function AuthUnavailablePage() {
  const { refresh } = useAuth();
  const { t } = useI18n();
  return (
    <main className="state-page" aria-live="assertive">
      <section className="state-card">
        <p className="eyebrow">xCloud</p>
        <h1>{t('unavailable_title')}</h1>
        <p>{t('unavailable_body')}</p>
        <button type="button" onClick={() => void refresh()}>{t('retry')}</button>
      </section>
    </main>
  );
}
