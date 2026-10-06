/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/iam/RoleBadge.tsx
 * Adaptations: "use client" dropped; `@/` aliases and CSS-module imports repointed for the Vite runtime.
 */
import { useI18n } from '../../providers/I18nProvider';
import { ROLE_STYLE, type RoleKey } from '../../types/iam';
import { normalizeGovernanceRole } from '../../lib/permissions';
import styles from '../../styles/modules/iam.module.css';

interface RoleBadgeProps {
  role: RoleKey | string;
}

export function RoleBadge({ role: value }: RoleBadgeProps) {
  const { t } = useI18n();
  const role = normalizeGovernanceRole(value);
  if (!role) return <span className={styles.badge}>{t('users_unknown_role')}</span>;
  return (
    <span className={styles.badge} style={{ background: ROLE_STYLE[role].bg, color: ROLE_STYLE[role].color }}>
      {t(`users_${role}`)}
    </span>
  );
}
