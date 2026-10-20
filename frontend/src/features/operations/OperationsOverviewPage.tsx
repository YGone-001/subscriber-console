/*
 * Operations overview page shell.
 *
 * Owns the operations/business view switch. The business cockpit is mounted only
 * while its view is active, so the default operations surface does not keep the
 * cockpit's polling loops alive in the background.
 */
import { useState } from 'react';
import { Activity, RadioTower } from 'lucide-react';
import AnalyticsCockpit from '../../components/AnalyticsCockpit';
import PageHeader from '../../components/ui/PageHeader';
import { useI18n } from '../../providers/I18nProvider';
import OperationsOverview from './OperationsOverview';
import styles from '../../styles/modules/operations.module.css';

type OverviewView = 'operations' | 'business';

export function OperationsOverviewPage() {
  const { t } = useI18n();
  const [view, setView] = useState<OverviewView>('operations');
  const business = view === 'business';

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('dash_live')}
        icon={business ? <Activity size={24} /> : <RadioTower size={24} />}
        title={business ? t('ops_business_view_title') : t('dashboard_title')}
        description={business ? t('ops_business_page_subtitle') : t('ops_overview_page_subtitle')}
        actions={(
          <div className={styles.viewToggle} role="group" aria-label={t('ops_view_label')}>
            {(['operations', 'business'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={view === option ? styles.viewToggleActive : undefined}
                aria-pressed={view === option}
                onClick={() => setView(option)}
              >
                {t(option === 'operations' ? 'ops_view_operations' : 'ops_view_business')}
              </button>
            ))}
          </div>
        )}
      />
      {business ? <AnalyticsCockpit /> : <OperationsOverview />}
    </div>
  );
}
