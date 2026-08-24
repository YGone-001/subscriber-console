import { Search } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { VALID_ROLES, VALID_STATUS, type RoleFilter, type StatusFilter } from "../types";
import type { UsersToolbarProps } from "./types";
import styles from "./UsersToolbar.module.css";

export function UsersToolbar(props: UsersToolbarProps) {
  const { t } = useI18n();
  return (
    <div className={styles.toolbar}>
        <div className={styles.search}>
          <Search size={16} />
          <input
            value={props.searchInput}
            onChange={(event) => props.updateSearchQuery(event.target.value)}
            placeholder={t("users_search_ph")}
            aria-label={t("users_search_ph")}
          />
        </div>
        <div className={styles.filterGroup} aria-label={t("users_filters")}>
          <select className="form-input" value={props.roleFilter} onChange={(event) => props.updateRoleFilter(event.target.value as RoleFilter)}>
            <option value="all">{t("users_filter_all_roles")}</option>
            {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
          </select>
          <select className="form-input" value={props.statusFilter} onChange={(event) => props.updateStatusFilter(event.target.value as StatusFilter)}>
            <option value="all">{t("users_filter_all_statuses")}</option>
            {VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
          </select>
        </div>
      </div>
  );
}
