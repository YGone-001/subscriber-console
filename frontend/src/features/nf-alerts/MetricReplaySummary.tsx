import { useI18n } from '../../providers/I18nProvider';
import type { MetricReplayStatus, MetricWorkerStatus } from './nf-alerts-types';

function timestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function MetricWorkerSummary({ status }: { status?: MetricWorkerStatus }) {
  const { t } = useI18n();
  if (!status) return null;
  return <section aria-label={t('nf_metric_replay_worker')}>
    <p>{t('nf_metric_replay_worker')}: {t(`nf_metric_replay_${status.state}`)}</p>
    <p>{t('nf_metric_replay_worker_counts', { failures: status.failures, hooks: status.hookFailures })}</p>
    <p>{t('nf_metric_replay_attempt')}: {timestamp(status.lastAttemptAt)}</p>
  </section>;
}

export function MetricReplaySummary({ status }: { status?: MetricReplayStatus }) {
  const { t } = useI18n();
  if (!status) return <p>{t('nf_metric_replay_not_observed')}</p>;
  return <div aria-label={t('nf_metric_replay_title')}>
    <p>{t('nf_metric_replay_title')}: {t(`nf_metric_replay_${status.state}`)}{status.reason ? ` (${t(`nf_metric_replay_reason_${status.reason}`)})` : ''}</p>
    <p>{t('nf_metric_replay_counts', { processed: status.processed, historical: status.historical, gaps: status.gaps, failures: status.failures })}</p>
    <p>{t('nf_metric_replay_watermark')}: {timestamp(status.processedThrough)}</p>
    <p>{t('nf_metric_replay_attempt')}: {timestamp(status.lastAttemptAt)}</p>
    {status.more ? <p>{t('nf_metric_replay_more')}</p> : null}
  </div>;
}
