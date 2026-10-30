/*
 * Operations overview page shell.
 *
 * The page keeps one stable title and URL-addressable content views. The
 * business cockpit is mounted only while its view is active, so the default
 * operations surface does not keep the cockpit's polling loops alive.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, RadioTower } from 'lucide-react';
import AnalyticsCockpit from '../../components/AnalyticsCockpit';
import PageHeader from '../../components/ui/PageHeader';
import { ViewSwitch, type ViewSwitchOption } from '../../components/ui/ViewSwitch';
import { useI18n } from '../../providers/I18nProvider';
import OperationsOverview from './OperationsOverview';
import styles from '../../styles/modules/operations.module.css';

type OverviewView = 'operations' | 'business';

export function OperationsOverviewPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const business = searchParams.get('view') === 'business';

  const setView = useCallback((next: OverviewView) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'business') params.set('view', 'business');
    else params.delete('view');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const viewOptions: ViewSwitchOption<OverviewView>[] = [
    { value: 'operations', label: t('ops_view_operations') },
    { value: 'business', label: t('ops_view_business') },
  ];

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('dash_live')}
        icon={<RadioTower size={24} />}
        title={t('dashboard_title')}
        description={t('ops_overview_page_subtitle')}
        actions={(
          <ViewSwitch
            options={viewOptions}
            value={business ? 'business' : 'operations'}
            onChange={setView}
            ariaLabel={t('ops_view_label')}
          />
        )}
      />
      {business ? (
        <>
          <section className={styles.businessIntro} aria-labelledby="business-analysis-title">
            <h2 id="business-analysis-title" className={styles.sectionTitle}>
              <Activity size={18} aria-hidden="true" />
              {t('ops_business_view_title')}
            </h2>
            <p className={styles.sectionNote}>{t('ops_business_page_subtitle')}</p>
          </section>
          <AnalyticsCockpit />
        </>
      ) : (
        <OperationsOverview />
      )}
    </div>
  );
}
