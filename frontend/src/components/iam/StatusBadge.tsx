import { useI18n } from "@/components/I18nProvider";
import { getUserAccessStatusMeta } from "@/lib/userAccessManagement";
import styles from "./iam.module.css";

interface StatusBadgeProps {
  status?: string;
  locked?: boolean;
}

export function StatusBadge({ status, locked = false }: StatusBadgeProps) {
  const { t } = useI18n();
  const meta = getUserAccessStatusMeta(status, locked);
  return <span className={`${styles.badge} ${styles[meta.tone]}`}>{t(meta.labelKey)}</span>;
}
