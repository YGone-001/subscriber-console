import { CalendarDays } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import type { BinaryFilter, CreatedFilter } from "../types";
import type { UsersToolbarProps } from "./types";
import styles from "./UsersToolbar.module.css";

type AdvancedFiltersProps = Pick<
  UsersToolbarProps,
  | "createdFilter"
  | "updateCreatedFilter"
  | "createdFrom"
  | "setCreatedFrom"
  | "createdTo"
  | "setCreatedTo"
  | "loginFrom"
  | "setLoginFrom"
  | "loginTo"
  | "setLoginTo"
  | "creatorFilter"
  | "setCreatorFilter"
  | "lockedFilter"
  | "setLockedFilter"
  | "neverLoginFilter"
  | "setNeverLoginFilter"
>;

export function AdvancedFilters(props: AdvancedFiltersProps) {
  const { t } = useI18n();
  return (
    <div className={styles.advancedRow}>
      <label>
        <CalendarDays size={15} />
        <span>{t("users_created_filter")}</span>
        <select className="form-input" value={props.createdFilter} onChange={(event) => props.updateCreatedFilter(event.target.value as CreatedFilter)}>
          <option value="all">{t("users_created_all")}</option>
          <option value="today">{t("users_created_today")}</option>
          <option value="7d">{t("users_created_7d")}</option>
          <option value="30d">{t("users_created_30d")}</option>
        </select>
      </label>
      <label>
        <span>{t("users_created_range")}</span>
        <input type="date" className="form-input" value={props.createdFrom} onChange={(event) => props.setCreatedFrom(event.target.value)} />
        <input type="date" className="form-input" value={props.createdTo} onChange={(event) => props.setCreatedTo(event.target.value)} />
      </label>
      <label>
        <span>{t("users_last_login_range")}</span>
        <input type="date" className="form-input" value={props.loginFrom} onChange={(event) => props.setLoginFrom(event.target.value)} />
        <input type="date" className="form-input" value={props.loginTo} onChange={(event) => props.setLoginTo(event.target.value)} />
      </label>
      <label>
        <span>{t("users_detail_created_by")}</span>
        <input className="form-input" value={props.creatorFilter} onChange={(event) => props.setCreatorFilter(event.target.value)} placeholder={t("users_creator_ph")} />
      </label>
      <label>
        <span>{t("users_locked_filter")}</span>
        <select className="form-input" value={props.lockedFilter} onChange={(event) => props.setLockedFilter(event.target.value as BinaryFilter)}>
          <option value="all">{t("users_binary_all")}</option>
          <option value="yes">{t("users_binary_yes")}</option>
          <option value="no">{t("users_binary_no")}</option>
        </select>
      </label>
      <label>
        <span>{t("users_never_login_filter")}</span>
        <select className="form-input" value={props.neverLoginFilter} onChange={(event) => props.setNeverLoginFilter(event.target.value as BinaryFilter)}>
          <option value="all">{t("users_binary_all")}</option>
          <option value="yes">{t("users_binary_yes")}</option>
          <option value="no">{t("users_binary_no")}</option>
        </select>
      </label>
    </div>
  );
}
