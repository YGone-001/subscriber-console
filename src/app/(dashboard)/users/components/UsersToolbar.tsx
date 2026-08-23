import { Download, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { VALID_ROLES, VALID_STATUS, type RoleFilter, type StatusFilter } from "../types";
import { AdvancedFilters } from "./AdvancedFilters";
import { FilterTagBar } from "./FilterTagBar";
import type { UsersToolbarProps } from "./types";
import styles from "./UsersToolbar.module.css";

export function UsersToolbar(props: UsersToolbarProps) {
  const { t } = useI18n();
  return (
    <>
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
          <button
            type="button"
            className={`btn btn-outline ${props.advancedOpen ? styles.activeButton : ""}`}
            onClick={() => props.setAdvancedOpen((current) => !current)}
            aria-expanded={props.advancedOpen}
          >
            <SlidersHorizontal size={15} />
            {t("users_more_filters")}
            {props.activeFilterCount > 0 ? <span className={styles.filterCount}>{props.activeFilterCount}</span> : null}
          </button>
          <button type="button" className="btn btn-outline" onClick={props.refresh} disabled={props.isValidating}>
            <RefreshCw size={15} className={props.isValidating ? styles.spin : undefined} />
            {t("refresh")}
          </button>
          <button type="button" className="btn btn-outline" onClick={props.exportFilteredUsers} disabled={props.filteredCount === 0}>
            <Download size={15} />
            {t("users_export")}
          </button>
        </div>
      </div>
      <div
        className={`${styles.advancedDisclosure} ${props.advancedOpen ? styles.advancedDisclosureOpen : ""}`}
        aria-hidden={!props.advancedOpen}
        inert={!props.advancedOpen}
      >
        <div className={styles.advancedDisclosureInner}><AdvancedFilters {...props} /></div>
      </div>
      <FilterTagBar {...props} />
    </>
  );
}
