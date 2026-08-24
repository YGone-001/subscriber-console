import { useI18n } from "@/components/I18nProvider";
import { 
  User, Search, RefreshCw, Plus, KeyRound,
  UserCheck, UserX, Eye, Settings,
  MoreHorizontal, Shield, X, Download
} from "lucide-react";
import { LoadingRows, EmptyState } from "@/components/OperationFeedback";
import { type RoleKey, VALID_ROLES } from "../types";
import { displayValue, formatDateTime } from "../utils";

export function UsersTable(props: any) {
  const { t } = useI18n();
  const {
    selectedUsernames, mutableSelectedUsers, requestBulkAction,
    bulkRole, setBulkRole, exportSelectedUsers, setSelectedUsernames,
    bulkMenuOpen, setBulkMenuOpen,
    filteredUsers, users, allPageSelected, togglePageSelection,
    pagedUsers, toggleSort, sortKey, sortDirection,
    isLoading, error, mutate, openCreateDrawer, clearFilters,
    isProtectedUser, normalizeStatus, toggleUserSelection,
    openDetails, renderRoleBadge, renderStatusBadge,
    startEdit, openMenuUsername, setOpenMenuUsername,
    setPendingStatusChange, setConfirmReason,
    pageSize, setPageSize, setPage, PAGE_SIZE_OPTIONS,
    safePage, pageCount, normalizePageSize
  } = props;

  const getAriaSort = (key: string): "ascending" | "descending" | "none" =>
    sortKey === key ? (sortDirection === "asc" ? "ascending" : "descending") : "none";

  return (
    <>
          {selectedUsernames.length > 0 ? (
            <div className="users-bulk-bar" role="region" aria-label={t("users_bulk_actions")}>
              <div>
                <strong>{t("users_selected_count", { count: selectedUsernames.length })}</strong>
                <span>{t("users_bulk_eligible", { count: mutableSelectedUsers.length })}</span>
              </div>
              <div className="users-bulk-actions">
                <button type="button" className="btn btn-outline" onClick={() => requestBulkAction("enable")} disabled={mutableSelectedUsers.length === 0}>
                  <UserCheck size={15} />
                  {t("users_bulk_enable")}
                </button>
                <button type="button" className="btn btn-outline" onClick={() => requestBulkAction("disable")} disabled={mutableSelectedUsers.length === 0}>
                  <UserX size={15} />
                  {t("users_bulk_disable")}
                </button>
                <label>
                  <span>{t("users_bulk_role")}</span>
                  <select className="form-input" value={bulkRole} onChange={(event) => setBulkRole(event.target.value as RoleKey)} disabled={mutableSelectedUsers.length === 0}>
                    {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
                  </select>
                </label>
                <button type="button" className="btn btn-outline" onClick={() => requestBulkAction("assignRole")} disabled={mutableSelectedUsers.length === 0}>
                  <Shield size={15} />
                  {t("users_bulk_assign_role")}
                </button>
                <div className="users-more users-bulk-more">
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setBulkMenuOpen((current: boolean) => !current)}
                    aria-expanded={bulkMenuOpen}
                    aria-label={t("users_more_actions")}
                  >
                    <MoreHorizontal size={15} />
                    {t("users_more_actions")}
                  </button>
                  {bulkMenuOpen ? (
                    <div className="users-more-menu" onKeyDown={(event) => { if (event.key === "Escape") setBulkMenuOpen(false); }}>
                      <button type="button" onClick={() => { exportSelectedUsers(); setBulkMenuOpen(false); }}>
                        <Download size={15} />
                        {t("users_bulk_export")}
                      </button>
                    </div>
                  ) : null}
                </div>
                <button type="button" className="btn btn-outline" onClick={() => setSelectedUsernames([])}>
                  <X size={15} />
                  {t("users_clear_selection")}
                </button>
              </div>
            </div>
          ) : null}

          <div className="users-table-meta">
            <span>{t("users_count_filtered", { count: filteredUsers.length, total: users.length })}</span>
            <span>{t("users_selected_count", { count: selectedUsernames.length })}</span>
          </div>

          <div className="users-table-scroll">
            <div className="users-mobile-table-controls">
              <label className="users-mobile-select-all">
                <input
                  type="checkbox"
                  aria-label={t("users_select_page")}
                  checked={allPageSelected}
                  onChange={togglePageSelection}
                  disabled={pagedUsers.length === 0}
                />
                <span>{t("users_select_page")}</span>
              </label>
              <div className="mobile-sort-strip">
                {[
                  ["username", t("users_col_user")],
                  ["status", t("users_status")],
                  ["lastLoginAt", t("users_last_login")],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={sortKey === key ? "mobile-sort-button active" : "mobile-sort-button"}
                    aria-pressed={sortKey === key}
                    onClick={() => toggleSort(key)}
                  >
                    {label}{sortKey === key ? ` · ${t(`users_sort_${sortDirection}`)}` : ""}
                  </button>
                ))}
              </div>
            </div>
            <table className="users-table">
              <caption className="sr-only">{t("users_title")}</caption>
              <thead>
                <tr>
                  <th className="users-select-col" data-column-priority="essential">
                    <input
                      type="checkbox"
                      aria-label={t("users_select_page")}
                      checked={allPageSelected}
                      onChange={togglePageSelection}
                      disabled={pagedUsers.length === 0}
                    />
                  </th>
                  <th className="users-user-col" aria-sort={getAriaSort("username")} data-column-priority="essential">
                    <button type="button" className="users-sort-btn" onClick={() => toggleSort("username")}>
                      <User size={15} /> {t("users_col_user")} {sortKey === "username" ? t(`users_sort_${sortDirection}`) : null}
                    </button>
                  </th>
                  <th data-column-priority="essential">{t("users_role")}</th>
                  <th aria-sort={getAriaSort("status")} data-column-priority="essential">
                    <button type="button" className="users-sort-btn" onClick={() => toggleSort("status")}>
                      {t("users_status")} {sortKey === "status" ? t(`users_sort_${sortDirection}`) : null}
                    </button>
                  </th>
                  <th aria-sort={getAriaSort("lastLoginAt")} data-column-priority="important">
                    <button type="button" className="users-sort-btn" onClick={() => toggleSort("lastLoginAt")}>
                      {t("users_last_login")} {sortKey === "lastLoginAt" ? t(`users_sort_${sortDirection}`) : null}
                    </button>
                  </th>
                  <th className="users-actions-col" data-column-priority="essential">{t("users_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr className="users-table-state-row">
                    <td colSpan={6}><LoadingRows columns={6} rows={6} /></td>
                  </tr>
                ) : error ? (
                  <tr className="users-table-state-row">
                    <td colSpan={6}>
                      <EmptyState
                        icon={<Shield size={44} />}
                        title={t("users_error_title")}
                        description={t("users_error_desc")}
                        action={
                          <button type="button" className="btn btn-outline" onClick={() => void mutate()}>
                            <RefreshCw size={15} />
                            {t("refresh")}
                          </button>
                        }
                      />
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr className="users-table-state-row">
                    <td colSpan={6}>
                      <EmptyState
                        icon={<UserCheck size={44} />}
                        title={t("users_empty")}
                        description={t("users_empty_desc")}
                        action={
                          <button type="button" className="btn btn-primary" onClick={openCreateDrawer}>
                            <Plus size={16} />
                            {t("users_new")}
                          </button>
                        }
                      />
                    </td>
                  </tr>
                ) : filteredUsers.length === 0 ? (
                  <tr className="users-table-state-row">
                    <td colSpan={6}>
                      <EmptyState
                        icon={<Search size={44} />}
                        title={t("users_no_match")}
                        description={t("users_no_match_desc")}
                        action={
                          <button type="button" className="btn btn-outline" onClick={clearFilters}>
                            <X size={15} />
                            {t("users_clear_filters")}
                          </button>
                        }
                      />
                    </td>
                  </tr>
                ) : pagedUsers.map((item: any) => {
                  const isProtected = isProtectedUser(item);
                  const itemStatus = normalizeStatus(item.status);
                  return (
                    <tr key={item.username}>
                      <td className="users-select-col users-mobile-select-cell" data-column-priority="essential">
                        <input
                          type="checkbox"
                          aria-label={t("users_select_user", { username: item.username })}
                          checked={selectedUsernames.includes(item.username)}
                          onChange={() => toggleUserSelection(item.username)}
                        />
                      </td>
                      <td className="users-user-col" data-label={t("users_col_user")} data-column-priority="essential">
                        <button type="button" className="users-identity-btn" onClick={() => openDetails(item)}>
                          <span className="users-avatar">{item.username.slice(0, 1).toUpperCase()}</span>
                          <span>
                            <strong>{item.username}</strong>
                            <small>{displayValue(item.displayName || item.description)}</small>
                          </span>
                        </button>
                      </td>
                      <td data-label={t("users_role")} data-column-priority="essential">{renderRoleBadge(item.role)}</td>
                      <td data-label={t("users_status")} data-column-priority="essential">{renderStatusBadge(item.status, item.locked)}</td>
                      <td className="users-date-cell" data-label={t("users_last_login")} data-column-priority="essential">
                        <span>{formatDateTime(item.lastLoginAt)}</span>
                        <small>{displayValue(item.lastLoginIp)}</small>
                      </td>
                      <td className="users-actions-col" data-label={t("users_actions")} data-column-priority="essential">
                        <div className="users-row-actions">
                          <button type="button" className="btn btn-ghost" onClick={() => openDetails(item)}>
                            <Eye size={15} />
                            {t("users_view")}
                          </button>
                          <button type="button" className="btn btn-ghost" onClick={() => startEdit(item)}>
                            <Settings size={15} />
                            {t("edit")}
                          </button>
                          <div className="users-more">
                            <button
                              type="button"
                              className="btn-icon"
                              onClick={() => setOpenMenuUsername((current: any) => current === item.username ? null : item.username)}
                              aria-expanded={openMenuUsername === item.username}
                              title={t("users_more_actions")}
                              aria-label={t("users_more_actions")}
                            >
                              <MoreHorizontal size={17} />
                            </button>
                            {openMenuUsername === item.username ? (
                              <div className="users-more-menu" onKeyDown={(event) => { if (event.key === "Escape") setOpenMenuUsername(null); }}>
                                <button type="button" onClick={() => { startEdit(item); setOpenMenuUsername(null); }}>
                                  <KeyRound size={15} />
                                  {t("users_reset_password")}
                                </button>
                                <button
                                  type="button"
                                  disabled={isProtected || itemStatus === "active"}
                                  onClick={() => { setPendingStatusChange({ username: item.username, status: "active" }); setConfirmReason(""); setOpenMenuUsername(null); }}
                                >
                                  <UserCheck size={15} />
                                  {t("users_enable_account")}
                                </button>
                                <button
                                  type="button"
                                  disabled={isProtected || itemStatus === "disabled"}
                                  onClick={() => { setPendingStatusChange({ username: item.username, status: "disabled" }); setConfirmReason(""); setOpenMenuUsername(null); }}
                                >
                                  <UserX size={15} />
                                  {t("users_disable_account")}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <footer className="users-pagination">
            <label>
              {t("users_page_size")}
              <select
                className="form-input"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(normalizePageSize(event.target.value));
                  setPage(1);
                }}
              >
                {PAGE_SIZE_OPTIONS.map((option: any) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <span>{t("users_page_info", { page: safePage, pages: pageCount })}</span>
            <div>
              <button type="button" className="btn btn-outline" onClick={() => setPage((current: any) => Math.max(1, current - 1))} disabled={safePage <= 1}>
                {t("prev")}
              </button>
              <button type="button" className="btn btn-outline" onClick={() => setPage((current: any) => Math.min(pageCount, current + 1))} disabled={safePage >= pageCount}>
                {t("next")}
              </button>
            </div>
          </footer>

    </>
  );
}
