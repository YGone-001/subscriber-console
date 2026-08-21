import { useI18n } from "@/components/I18nProvider";
import { Search } from "lucide-react";
import { VALID_ROLES, VALID_STATUS, RoleFilter, StatusFilter } from "../types";

export function UsersToolbar(props: any) {
  const { t } = useI18n();
  const {
    searchInput, updateSearchQuery, roleFilter, updateRoleFilter,
    statusFilter, updateStatusFilter,
  } = props;

  return (
    <div className="users-toolbar">
      <div className="users-search">
        <Search size={16} />
        <input
          value={searchInput}
          onChange={(event) => updateSearchQuery(event.target.value)}
          placeholder={t("users_search_ph")}
          aria-label={t("users_search_ph")}
        />
      </div>
      <div className="users-filter-group" aria-label={t("users_filters")}>
        <select className="form-input" value={roleFilter} onChange={(event) => updateRoleFilter(event.target.value as RoleFilter)}>
          <option value="all">{t("users_filter_all_roles")}</option>
          {VALID_ROLES.map(role => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
        </select>
        <select className="form-input" value={statusFilter} onChange={(event) => updateStatusFilter(event.target.value as StatusFilter)}>
          <option value="all">{t("users_filter_all_statuses")}</option>
          {VALID_STATUS.map(status => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
        </select>
      </div>
    </div>
  );
}
