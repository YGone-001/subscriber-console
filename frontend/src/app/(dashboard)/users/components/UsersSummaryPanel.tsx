import { useI18n } from '@/components/I18nProvider';
import MetricStrip from '@/components/ui/MetricStrip';

export function UsersSummaryPanel({ stats }: { stats?: { total: number; active: number; administrators: number; locked: number } }) {
  const { t } = useI18n();
  return <MetricStrip ariaLabel={t('users_summary')} items={[
    { key: 'total', label: t('users_count_total'), value: stats?.total ?? '—' },
    { key: 'active', label: t('users_enabled'), value: stats?.active ?? '—', tone: 'success' },
    { key: 'admins', label: t('users_administrators'), value: stats?.administrators ?? '—' },
    { key: 'locked', label: t('users_locked'), value: stats?.locked ?? '—', tone: 'muted' },
  ]} />;
}
