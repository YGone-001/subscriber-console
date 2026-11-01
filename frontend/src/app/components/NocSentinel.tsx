/*
 * Header NOC posture indicator.
 *
 * NF alerts are the only alert authority. The header renders the full-collection
 * summary from GET /api/operations/summary?sections=alerts and links to the NF
 * alert workbench; it never reads the legacy /api/alerts collection, which has
 * no producer in this repository.
 *
 * A failed summary read is an explicit unavailable state, not "all clear".
 */
import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { BellRing, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { fetchOperationsSummary, type AlertsSummarySection } from '../../features/operations/operations-summary';

type SummaryResponse = { alerts?: AlertsSummarySection };

export function NocSentinel() {
  const { t } = useI18n();
  const { data, error } = useSWR<SummaryResponse>(
    '/api/operations/summary?sections=alerts',
    async () => fetchOperationsSummary(['alerts']).then((response) => ({ alerts: response.alerts })),
    { refreshInterval: 15000, revalidateOnFocus: true, errorRetryInterval: 30000 },
  );

  const section = data?.alerts;
  const unavailable = Boolean(error) && !data;
  const alerts = section?.alerts;
  const complete = section?.completeness === 'complete' && Boolean(alerts);
  const critical = complete ? (alerts?.openBySeverity?.critical ?? 0) : 0;
  const warning = complete ? (alerts?.openBySeverity?.warning ?? 0) : 0;

  const status = unavailable
    ? 'muted'
    : critical > 0
      ? 'critical'
      : warning > 0
        ? 'warning'
        : complete
          ? 'healthy'
          : 'muted';

  const label = unavailable
    ? t('noc_unavailable')
    : critical > 0
      ? t('noc_status_critical')
      : warning > 0
        ? t('noc_status_warning')
        : complete
          ? t('noc_open_none')
          : t('noc_unavailable');

  const title = complete && (critical > 0 || warning > 0)
    ? t('noc_open_counts', { critical, warning })
    : label;

  return (
    <div className="noc-sentinel" data-noc-posture={status}>
      <Link to="/nf-alerts" className={`noc-header-button ${status}`} title={title} aria-label={title}>
        <span className="noc-button-icon" aria-hidden="true">
          {critical > 0 ? <ShieldAlert size={16} /> : <BellRing size={16} />}
        </span>
        <span>{label}</span>
        {complete && critical + warning > 0 ? <span className="noc-count">{critical + warning}</span> : null}
      </Link>
    </div>
  );
}

export default NocSentinel;
