import { useI18n } from "@/components/I18nProvider";
import { RoleBadge } from "@/components/iam/RoleBadge";
import { StatusBadge } from "@/components/iam/StatusBadge";
import type { SysUser } from "../types";
import { displayValue, formatDateTime } from "../utils";
import styles from "./UserDrawer.module.css";

export function UserBasicInfo({ user }: { user: SysUser }) {
  const { t } = useI18n();
  const rows = [
    [t("users_username"), user.username],
    [t("users_display_name"), displayValue(user.displayName)],
    [t("users_email"), displayValue(user.email)],
    [t("users_role"), <RoleBadge key="role" role={user.role} />],
    [t("users_status"), <StatusBadge key="status" status={user.status} locked={user.locked} />],
    [t("users_detail_created_at"), formatDateTime(user.createdAt)],
    [t('users_updated_at'), formatDateTime(user.updatedAt)],
    [t("users_detail_created_by"), displayValue(user.createdBy)],
    [t("users_account_note"), displayValue(user.description)],
  ] as const;
  return (
    <section className={styles.detailSection}>
      <h3>{t("users_detail_tab_basic")}</h3>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </section>
  );
}
