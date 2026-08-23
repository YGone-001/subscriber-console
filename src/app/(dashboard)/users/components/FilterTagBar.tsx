import { X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import type { UsersToolbarProps } from "./types";
import styles from "./UsersToolbar.module.css";

type FilterTagBarProps = Omit<
  UsersToolbarProps,
  "advancedOpen" | "setAdvancedOpen" | "activeFilterCount" | "refresh" | "isValidating" | "exportFilteredUsers" | "filteredCount"
>;

export function FilterTagBar(props: FilterTagBarProps) {
  const { t } = useI18n();
  const tags: Array<{ key: string; label: string; onRemove: () => void }> = [];
  if (props.searchInput.trim()) tags.push({ key: "q", label: `${t("users_filter_keyword")}: ${props.searchInput.trim()}`, onRemove: () => props.updateSearchQuery("") });
  if (props.roleFilter !== "all") tags.push({ key: "role", label: `${t("users_role")}: ${t(`users_${props.roleFilter}`)}`, onRemove: () => props.updateRoleFilter("all") });
  if (props.statusFilter !== "all") tags.push({ key: "status", label: `${t("users_status")}: ${t(`users_${props.statusFilter}`)}`, onRemove: () => props.updateStatusFilter("all") });
  if (props.createdFilter !== "all") tags.push({ key: "created", label: `${t("users_created")}: ${t(`users_created_${props.createdFilter}`)}`, onRemove: () => props.updateCreatedFilter("all") });
  if (props.createdFrom || props.createdTo) tags.push({
    key: "createdRange",
    label: `${t("users_created_range")}: ${props.createdFrom || "--"} - ${props.createdTo || "--"}`,
    onRemove: () => { props.setCreatedFrom(""); props.setCreatedTo(""); },
  });
  if (props.loginFrom || props.loginTo) tags.push({
    key: "loginRange",
    label: `${t("users_last_login_range")}: ${props.loginFrom || "--"} - ${props.loginTo || "--"}`,
    onRemove: () => { props.setLoginFrom(""); props.setLoginTo(""); },
  });
  if (props.creatorFilter.trim()) tags.push({ key: "creator", label: `${t("users_detail_created_by")}: ${props.creatorFilter.trim()}`, onRemove: () => props.setCreatorFilter("") });
  if (props.lockedFilter !== "all") tags.push({ key: "locked", label: `${t("users_locked_filter")}: ${t(`users_binary_${props.lockedFilter}`)}`, onRemove: () => props.setLockedFilter("all") });
  if (props.neverLoginFilter !== "all") tags.push({ key: "neverLogin", label: `${t("users_never_login_filter")}: ${t(`users_binary_${props.neverLoginFilter}`)}`, onRemove: () => props.setNeverLoginFilter("all") });
  if (tags.length === 0) return null;

  return (
    <div className={styles.filterTags} aria-label={t("users_filter_tags")}>
      {tags.map((tag) => (
        <button key={tag.key} type="button" onClick={tag.onRemove} title={t("users_remove_filter")}>
          {tag.label}<X size={13} />
        </button>
      ))}
      <button type="button" className={styles.clearTag} onClick={props.clearFilters}>{t("users_clear_filters")}</button>
    </div>
  );
}
