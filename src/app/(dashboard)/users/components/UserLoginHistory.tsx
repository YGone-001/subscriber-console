import { Clock } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState } from "@/components/OperationFeedback";
import type { SysUser } from "../types";
import { displayValue, formatDateTime } from "../utils";
import styles from "./UserDrawer.module.css";

export function UserLoginHistory({ user }: { user: SysUser }) {
  const { t } = useI18n();
  if (!user.lastLoginAt) return <EmptyState icon={<Clock size={42} />} title={t("users_no_data_title")} description={t("users_no_login_data_desc")} />;
  return (
    <section className={styles.detailSection}>
      <h3>{t("users_detail_tab_login")}</h3>
      <div className={styles.recordList}><div><span>{formatDateTime(user.lastLoginAt)}</span><small>{displayValue(user.lastLoginIp)} · {displayValue(user.userAgent)}</small><strong>{t("users_login_success")}</strong></div></div>
    </section>
  );
}
