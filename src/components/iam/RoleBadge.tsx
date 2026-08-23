import { useI18n } from "@/components/I18nProvider";
import { ROLE_STYLE, VALID_ROLES, type RoleKey } from "@/types/iam";
import styles from "./iam.module.css";

interface RoleBadgeProps {
  role: RoleKey | string;
}

function normalizeRole(role: RoleKey | string): RoleKey {
  return VALID_ROLES.includes(role as RoleKey) ? role as RoleKey : "viewer";
}

export function RoleBadge({ role: value }: RoleBadgeProps) {
  const { t } = useI18n();
  const role = normalizeRole(value);
  return (
    <span className={styles.badge} style={{ background: ROLE_STYLE[role].bg, color: ROLE_STYLE[role].color }}>
      {t(`users_${role}`)}
    </span>
  );
}
