import { useI18n } from "@/components/I18nProvider";
import { PAGE_SIZE_OPTIONS } from "../types";
import type { UsersTableProps } from "./types";
import styles from "./UsersTable.module.css";

type UsersPaginationProps = Pick<UsersTableProps, "pageSize" | "setPageSize" | "setPage" | "safePage" | "pageCount">;

export function UsersPagination({ pageSize, setPageSize, setPage, safePage, pageCount }: UsersPaginationProps) {
  const { t } = useI18n();
  return (
    <footer className={styles.pagination}>
      <label>
        {t("users_page_size")}
        <select
          className="form-input"
          value={pageSize}
          onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
        >
          {PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <span>{t("users_page_info", { page: safePage, pages: pageCount })}</span>
      <div>
        <button type="button" className="btn btn-outline" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={safePage <= 1}>{t("prev")}</button>
        <button type="button" className="btn btn-outline" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={safePage >= pageCount}>{t("next")}</button>
      </div>
    </footer>
  );
}
