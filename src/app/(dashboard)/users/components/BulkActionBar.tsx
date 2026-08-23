import { Download, Shield, Trash2, UserCheck, UserX, X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { VALID_ROLES, type RoleKey } from "../types";
import type { UsersTableProps } from "./types";
import styles from "./UsersTable.module.css";

type BulkActionBarProps = Pick<
  UsersTableProps,
  "selectedUsernames" | "mutableSelectedCount" | "requestBulkAction" | "bulkRole" | "setBulkRole" | "exportSelectedUsers" | "clearSelection"
>;

export function BulkActionBar(props: BulkActionBarProps) {
  const { t } = useI18n();
  if (props.selectedUsernames.length === 0) return null;
  const disabled = props.mutableSelectedCount === 0;
  return (
    <div className={styles.bulkBar} role="region" aria-label={t("users_bulk_actions")}>
      <div>
        <strong>{t("users_selected_count", { count: props.selectedUsernames.length })}</strong>
        <span>{t("users_bulk_eligible", { count: props.mutableSelectedCount })}</span>
      </div>
      <div className={styles.bulkActions}>
        <button type="button" className="btn btn-outline" onClick={() => props.requestBulkAction("enable")} disabled={disabled}><UserCheck size={15} />{t("users_bulk_enable")}</button>
        <button type="button" className="btn btn-outline" onClick={() => props.requestBulkAction("disable")} disabled={disabled}><UserX size={15} />{t("users_bulk_disable")}</button>
        <label>
          <span>{t("users_bulk_role")}</span>
          <select className="form-input" value={props.bulkRole} onChange={(event) => props.setBulkRole(event.target.value as RoleKey)} disabled={disabled}>
            {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-outline" onClick={() => props.requestBulkAction("assignRole")} disabled={disabled}><Shield size={15} />{t("users_bulk_assign_role")}</button>
        <button type="button" className="btn btn-outline" onClick={props.exportSelectedUsers}><Download size={15} />{t("users_bulk_export")}</button>
        <button type="button" className={`btn btn-outline ${styles.dangerAction}`} onClick={() => props.requestBulkAction("delete")} disabled={disabled}><Trash2 size={15} />{t("users_bulk_delete")}</button>
        <button type="button" className="btn btn-outline" onClick={props.clearSelection}><X size={15} />{t("users_clear_selection")}</button>
      </div>
    </div>
  );
}
