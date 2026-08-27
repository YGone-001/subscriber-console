import { useEffect, useRef } from "react";
import {
  Eye,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  User,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { RoleBadge } from "@/components/iam/RoleBadge";
import { StatusBadge } from "@/components/iam/StatusBadge";
import iamStyles from "@/components/iam/iam.module.css";
import { EmptyState, LoadingRows } from "@/components/OperationFeedback";
import type { SortKey } from "../types";
import { displayValue, formatDateTime, normalizeStatus } from "../utils";
import { BulkActionBar } from "./BulkActionBar";
import type { UsersTableProps } from "./types";
import { UsersPagination } from "./UsersPagination";
import styles from "./UsersTable.module.css";

const MOBILE_SORT_KEYS: SortKey[] = ["username", "status", "lastLoginAt"];

export function UsersTable(props: UsersTableProps) {
  const { t } = useI18n();
  const openMenuRef = useRef<HTMLDivElement>(null);
  const { openMenuUsername, setOpenMenuUsername } = props;

  useEffect(() => {
    if (!openMenuUsername) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!openMenuRef.current?.contains(event.target as Node)) setOpenMenuUsername(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuUsername(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    openMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenuUsername, setOpenMenuUsername]);

  const getAriaSort = (key: SortKey): "ascending" | "descending" | "none" =>
    props.sortKey === key ? (props.sortDirection === "asc" ? "ascending" : "descending") : "none";

  return (
    <>
      <BulkActionBar {...props} />
      <div className={styles.tableMeta}>
        <span>{t("users_count_filtered", { count: props.total, total: props.totalUsers })}</span>
        <span>{t("users_selected_count", { count: props.selectedUsernames.length })}</span>
      </div>
      <div className={styles.tableScroll}>
        <div className={styles.mobileTableControls}>
          <label className={styles.mobileSelectAll}>
            <input type="checkbox" aria-label={t("users_select_page")} checked={props.allPageSelected} onChange={props.togglePageSelection} disabled={props.pagedUsers.length === 0} />
            <span>{t("users_select_page")}</span>
          </label>
          <div className="mobile-sort-strip">
            {MOBILE_SORT_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                className={props.sortKey === key ? "mobile-sort-button active" : "mobile-sort-button"}
                aria-pressed={props.sortKey === key}
                onClick={() => props.toggleSort(key)}
              >
                {t(key === "username" ? "users_col_user" : key === "status" ? "users_status" : "users_last_login")}
                {props.sortKey === key ? ` · ${t(`users_sort_${props.sortDirection}`)}` : ""}
              </button>
            ))}
          </div>
        </div>
        <table className={styles.table}>
          <caption className="sr-only">{t("users_title")}</caption>
          <thead>
            <tr>
              <th className={styles.selectCol} data-column-priority="essential">
                <input type="checkbox" aria-label={t("users_select_page")} checked={props.allPageSelected} onChange={props.togglePageSelection} disabled={props.pagedUsers.length === 0} />
              </th>
              <th className={styles.userCol} aria-sort={getAriaSort("username")} data-column-priority="essential">
                <button type="button" className={styles.sortButton} onClick={() => props.toggleSort("username")}><User size={15} /> {t("users_col_user")} {props.sortKey === "username" ? t(`users_sort_${props.sortDirection}`) : null}</button>
              </th>
              <th data-column-priority="essential">{t("users_role")}</th>
              <th aria-sort={getAriaSort("status")} data-column-priority="essential">
                <button type="button" className={styles.sortButton} onClick={() => props.toggleSort("status")}>{t("users_status")} {props.sortKey === "status" ? t(`users_sort_${props.sortDirection}`) : null}</button>
              </th>
              <th aria-sort={getAriaSort("lastLoginAt")} data-column-priority="important">
                <button type="button" className={styles.sortButton} onClick={() => props.toggleSort("lastLoginAt")}>{t("users_last_login")} {props.sortKey === "lastLoginAt" ? t(`users_sort_${props.sortDirection}`) : null}</button>
              </th>
              <th aria-sort={getAriaSort('createdAt')} data-column-priority="important"><button type="button" className={styles.sortButton} onClick={() => props.toggleSort('createdAt')}>{t('users_detail_created_at')}</button></th>
              <th className={styles.actionsCol} data-column-priority="essential">{t("users_actions")}</th>
            </tr>
          </thead>
          <tbody>
            {props.isLoading ? (
              <tr className={styles.tableStateRow}><td colSpan={7}><LoadingRows columns={7} rows={6} /></td></tr>
            ) : props.error ? (
              <tr className={styles.tableStateRow}><td colSpan={7}><EmptyState icon={<Shield size={44} />} title={t("users_error_title")} description={t("users_error_desc")} action={<button type="button" className="btn btn-outline" onClick={props.refresh}><RefreshCw size={15} />{t("refresh")}</button>} /></td></tr>
            ) : props.totalUsers === 0 ? (
              <tr className={styles.tableStateRow}><td colSpan={7}><EmptyState icon={<UserCheck size={44} />} title={t("users_empty")} description={t("users_empty_desc")} action={props.canCreate ? <button type="button" className="btn btn-primary" onClick={props.openCreateDrawer}><Plus size={16} />{t("users_new")}</button> : undefined} /></td></tr>
            ) : props.filteredUsers.length === 0 ? (
              <tr className={styles.tableStateRow}><td colSpan={7}><EmptyState icon={<Search size={44} />} title={t("users_no_match")} description={t("users_no_match_desc")} action={<button type="button" className="btn btn-outline" onClick={props.clearFilters}><X size={15} />{t("users_clear_filters")}</button>} /></td></tr>
            ) : props.pagedUsers.map((item) => {
              const isProtected = props.isProtectedUser(item);
              const itemStatus = normalizeStatus(item.status);
              return (
                <tr key={item.username}>
                  <td className={`${styles.selectCol} ${styles.mobileSelectCell}`} data-column-priority="essential">
                    <input type="checkbox" aria-label={t("users_select_user", { username: item.username })} checked={props.selectedUsernames.includes(item.username)} onChange={() => props.toggleUserSelection(item.username)} />
                  </td>
                  <td className={`${styles.userCol} ${styles.userIdentityCell}`} data-label={t("users_col_user")} data-column-priority="essential">
                    <button type="button" className={styles.identityButton} onClick={() => props.openDetails(item)}>
                      <span className={iamStyles.avatar}>{item.username.slice(0, 1).toUpperCase()}</span>
                      <span><strong>{displayValue(item.displayName || item.username)}</strong><small>{item.username}</small></span>
                    </button>
                    <span className={styles.userPreview} aria-hidden="true">
                      <span className={`${iamStyles.avatar} ${iamStyles.avatarLarge}`}>{item.username.slice(0, 1).toUpperCase()}</span>
                      <span><strong>{displayValue(item.displayName || item.username)}</strong><small>{item.username}</small><span><RoleBadge role={item.role} /><StatusBadge status={item.status} locked={item.locked} /></span></span>
                    </span>
                  </td>
                  <td data-label={t("users_role")} data-column-priority="essential"><RoleBadge role={item.role} /></td>
                  <td data-label={t("users_status")} data-column-priority="essential"><StatusBadge status={item.status} locked={item.locked} /></td>
                  <td className={styles.dateCell} data-label={t("users_last_login")} data-column-priority="important"><span>{formatDateTime(item.security?.lastLoginAt || item.lastLoginAt)}</span></td>
                  <td className={styles.dateCell} data-label={t('users_detail_created_at')} data-column-priority="important">{formatDateTime(item.createdAt)}</td>
                  <td className={styles.actionsCol} data-label={t("users_actions")} data-column-priority="essential">
                    <div className={styles.rowActions}>
                      <button type="button" className="btn btn-ghost" onClick={() => props.openDetails(item)}><Eye size={15} />{t("users_view")}</button>
                      {props.canManage(item, 'update') ? <button type="button" className="btn btn-ghost" onClick={() => props.startEdit(item)}><Settings size={15} />{t("edit")}</button> : null}
                      {props.canManage(item, 'password.reset') || props.canManage(item, 'disable') ? (
                      <div className={styles.more} ref={props.openMenuUsername === item.username ? openMenuRef : undefined}>
                        <button type="button" className="btn-icon" onClick={() => props.setOpenMenuUsername((current) => current === item.username ? null : item.username)} aria-expanded={props.openMenuUsername === item.username} aria-haspopup="menu" title={t("users_more_actions")} aria-label={t("users_more_actions")}><MoreHorizontal size={17} /></button>
                        {props.openMenuUsername === item.username ? (
                          <div className={styles.moreMenu} role="menu" aria-label={t("users_more_actions")}>
                            {props.canManage(item, 'password.reset') ? <button type="button" role="menuitem" onClick={() => { props.startPasswordReset(item); props.setOpenMenuUsername(null); }}><KeyRound size={15} />{t("users_reset_password")}</button> : null}
                            <button type="button" role="menuitem" disabled={isProtected} onClick={() => { props.setPendingStatusChange({ username: item.username, status: itemStatus === "active" ? "disabled" : "active" }); props.setConfirmReason(""); props.setOpenMenuUsername(null); }}>
                              {itemStatus === "active" ? <UserX size={15} /> : <UserCheck size={15} />}
                              {t(itemStatus === 'locked' ? 'users_unlock_account' : itemStatus === "active" ? "users_disable_account" : "users_enable_account")}
                            </button>
                            {itemStatus === 'active' && props.canManage(item, 'lock') ? <button type="button" role="menuitem" onClick={() => { props.setPendingStatusChange({ username: item.username, status: 'locked' }); props.setConfirmReason(''); props.setOpenMenuUsername(null); }}><LockKeyhole size={15} />{t('users_lock_account')}</button> : null}
                          </div>
                        ) : null}
                      </div>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <UsersPagination {...props} />
    </>
  );
}
