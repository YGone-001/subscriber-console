import { useI18n } from "@/components/I18nProvider";
import { ROLE_STYLE, type RoleKey } from "@/types/iam";
import { normalizeGovernanceRole } from '@/lib/permissions';
import styles from "./iam.module.css";

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
