import { useI18n } from "@/components/I18nProvider";
import { 
  Search, SlidersHorizontal, RefreshCw, Download, 
  CalendarDays, X
} from "lucide-react";
import { VALID_ROLES, VALID_STATUS, RoleFilter, StatusFilter, CreatedFilter, BinaryFilter } from "../types";

export function UsersToolbar(props: any) {
  const { t } = useI18n();
  const {
    searchInput, updateSearchQuery, roleFilter, updateRoleFilter,
    statusFilter, updateStatusFilter, advancedOpen, setAdvancedOpen,
    activeFilterCount, mutate, isValidating, exportFilteredUsers,
    filteredUsers, createdFilter, updateCreatedFilter, createdFrom,
    setCreatedFrom, setPage, createdTo, setCreatedTo, loginFrom,
    setLoginFrom, loginTo, setLoginTo, creatorFilter, setCreatorFilter,
    lockedFilter, setLockedFilter, neverLoginFilter, setNeverLoginFilter,
    clearFilters
  } = props;
  
const renderFilterTags = () => {
    const tags: Array<{ key: string; label: string; onRemove: () => void }> = [];
    if (searchInput.trim()) {
      tags.push({ key: "q", label: `${t("users_filter_keyword")}: ${searchInput.trim()}`, onRemove: () => updateSearchQuery("") });
    }
    if (roleFilter !== "all") {
      tags.push({ key: "role", label: `${t("users_role")}: ${t(`users_${roleFilter}`)}`, onRemove: () => updateRoleFilter("all") });
    }
    if (statusFilter !== "all") {
      tags.push({ key: "status", label: `${t("users_status")}: ${t(`users_${statusFilter}`)}`, onRemove: () => updateStatusFilter("all") });
    }
    if (createdFilter !== "all") {
      tags.push({ key: "created", label: `${t("users_created")}: ${t(`users_created_${createdFilter}`)}`, onRemove: () => updateCreatedFilter("all") });
    }
    if (createdFrom || createdTo) {
      tags.push({
        key: "createdRange",
        label: `${t("users_created_range")}: ${createdFrom || "--"} - ${createdTo || "--"}`,
        onRemove: () => {
          setCreatedFrom("");
          setCreatedTo("");
          setPage(1);
        },
      });
    }
    if (loginFrom || loginTo) {
      tags.push({
        key: "loginRange",
        label: `${t("users_last_login_range")}: ${loginFrom || "--"} - ${loginTo || "--"}`,
        onRemove: () => {
          setLoginFrom("");
          setLoginTo("");
          setPage(1);
        },
      });
    }
    if (creatorFilter.trim()) {
      tags.push({ key: "creator", label: `${t("users_detail_created_by")}: ${creatorFilter.trim()}`, onRemove: () => { setCreatorFilter(""); setPage(1); } });
    }
    if (lockedFilter !== "all") {
      tags.push({ key: "locked", label: `${t("users_locked_filter")}: ${t(`users_binary_${lockedFilter}`)}`, onRemove: () => { setLockedFilter("all"); setPage(1); } });
    }
    if (neverLoginFilter !== "all") {
      tags.push({ key: "neverLogin", label: `${t("users_never_login_filter")}: ${t(`users_binary_${neverLoginFilter}`)}`, onRemove: () => { setNeverLoginFilter("all"); setPage(1); } });
    }

    if (tags.length === 0) return null;
    return (
      <div className="users-filter-tags" aria-label={t("users_filter_tags")}>
        {tags.map((tag) => (
          <button key={tag.key} type="button" onClick={tag.onRemove} title={t("users_remove_filter")}>
            {tag.label}
            <X size={13} />
          </button>
        ))}
        <button type="button" className="users-clear-tag" onClick={clearFilters}>
          {t("users_clear_filters")}
        </button>
      </div>
    );
  };


  
  return (
    <>
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
              <button
                type="button"
                className={advancedOpen ? "btn btn-outline active" : "btn btn-outline"}
                onClick={() => setAdvancedOpen((current: any) => !current)}
                aria-expanded={advancedOpen}
              >
                <SlidersHorizontal size={15} />
                {t("users_more_filters")}
                {activeFilterCount > 0 ? <span className="users-filter-count">{activeFilterCount}</span> : null}
              </button>
              <button type="button" className="btn btn-outline" onClick={() => void mutate()} disabled={isValidating}>
                <RefreshCw size={15} className={isValidating ? "users-spin" : undefined} />
                {t("refresh")}
              </button>
              <button type="button" className="btn btn-outline" onClick={exportFilteredUsers} disabled={filteredUsers.length === 0}>
                <Download size={15} />
                {t("users_export")}
              </button>
            </div>
          </div>

          {advancedOpen ? (
            <div className="users-advanced-row">
              <label>
                <CalendarDays size={15} />
                <span>{t("users_created_filter")}</span>
                <select className="form-input" value={createdFilter} onChange={(event) => updateCreatedFilter(event.target.value as CreatedFilter)}>
                  <option value="all">{t("users_created_all")}</option>
                  <option value="today">{t("users_created_today")}</option>
                  <option value="7d">{t("users_created_7d")}</option>
                  <option value="30d">{t("users_created_30d")}</option>
                </select>
              </label>
              <label>
                <span>{t("users_created_range")}</span>
                <input type="date" className="form-input" value={createdFrom} onChange={(event) => { setCreatedFrom(event.target.value); setPage(1); }} />
                <input type="date" className="form-input" value={createdTo} onChange={(event) => { setCreatedTo(event.target.value); setPage(1); }} />
              </label>
              <label>
                <span>{t("users_last_login_range")}</span>
                <input type="date" className="form-input" value={loginFrom} onChange={(event) => { setLoginFrom(event.target.value); setPage(1); }} />
                <input type="date" className="form-input" value={loginTo} onChange={(event) => { setLoginTo(event.target.value); setPage(1); }} />
              </label>
              <label>
                <span>{t("users_detail_created_by")}</span>
                <input className="form-input" value={creatorFilter} onChange={(event) => { setCreatorFilter(event.target.value); setPage(1); }} placeholder={t("users_creator_ph")} />
              </label>
              <label>
                <span>{t("users_locked_filter")}</span>
                <select className="form-input" value={lockedFilter} onChange={(event) => { setLockedFilter(event.target.value as BinaryFilter); setPage(1); }}>
                  <option value="all">{t("users_binary_all")}</option>
                  <option value="yes">{t("users_binary_yes")}</option>
                  <option value="no">{t("users_binary_no")}</option>
                </select>
              </label>
              <label>
                <span>{t("users_never_login_filter")}</span>
                <select className="form-input" value={neverLoginFilter} onChange={(event) => { setNeverLoginFilter(event.target.value as BinaryFilter); setPage(1); }}>
                  <option value="all">{t("users_binary_all")}</option>
                  <option value="yes">{t("users_binary_yes")}</option>
                  <option value="no">{t("users_binary_no")}</option>
                </select>
              </label>
            </div>
          ) : null}
      {renderFilterTags()}
    </>
  );
}
