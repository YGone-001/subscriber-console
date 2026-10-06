/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/iam/StatusBadge.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { useI18n } from '../../providers/I18nProvider';
import { getUserAccessStatusMeta } from '../../lib/userAccessManagement';
import styles from '../../styles/modules/iam.module.css';

interface StatusBadgeProps {
  status?: string;
  locked?: boolean;
}

export function StatusBadge({ status, locked = false }: StatusBadgeProps) {
  const { t } = useI18n();
  const meta = getUserAccessStatusMeta(status, locked);
  return <span className={`${styles.badge} ${styles[meta.tone]}`}>{t(meta.labelKey)}</span>;
}
