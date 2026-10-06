/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/users/components/UsersSummaryPanel.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { useI18n } from '../../../providers/I18nProvider';
import MetricStrip from '../../../components/ui/MetricStrip';

export function UsersSummaryPanel({ stats }: { stats?: { total: number; active: number; administrators: number; locked: number } }) {
  const { t } = useI18n();
  return <MetricStrip ariaLabel={t('users_summary')} items={[
    { key: 'total', label: t('users_count_total'), value: stats?.total ?? '—' },
    { key: 'active', label: t('users_enabled'), value: stats?.active ?? '—', tone: 'success' },
    { key: 'admins', label: t('users_administrators'), value: stats?.administrators ?? '—' },
    { key: 'locked', label: t('users_locked'), value: stats?.locked ?? '—', tone: 'muted' },
  ]} />;
}
