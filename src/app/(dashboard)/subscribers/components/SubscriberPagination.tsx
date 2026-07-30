import React from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";

interface SubscriberPaginationProps {
  currentPage: number;
  totalPages: number;
  displayPage: number;
  pageSize: number;
  totalSubscribers: number;
  getPageNumbers: () => number[];
  setPageSize: (size: number) => void;
  setCurrentPage: React.Dispatch<React.SetStateAction<number>>;
}

export default function SubscriberPagination({
  totalPages,
  displayPage,
  pageSize,
  totalSubscribers,
  getPageNumbers,
  setPageSize,
  setCurrentPage
}: SubscriberPaginationProps) {
  const { t } = useI18n();

  if (totalSubscribers === 0) return null;

  return (
    <div className="table-pagination">
      <div className="pagination-info">
        {t("showing")} {((displayPage - 1) * pageSize) + 1} {t("to")} {Math.min(displayPage * pageSize, totalSubscribers)} {t("of")} {totalSubscribers} {t("entries")}
      </div>
      <div className="pagination-controls">
        <select className="page-size-select" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}>
          <option value={10}>10 {t("per_page")}</option>
          <option value={20}>20 {t("per_page")}</option>
          <option value={50}>50 {t("per_page")}</option>
        </select>
        <div className="page-buttons" aria-label="Subscriber pagination">
          <button className="page-button icon" onClick={() => setCurrentPage(1)} disabled={displayPage === 1} title="First page">
            <ChevronsLeft size={15} />
          </button>
          <button className="page-button icon" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={displayPage === 1} title={t("prev")}>
            <ChevronLeft size={15} />
          </button>
          {getPageNumbers().map((page) => (
            <button
              key={page}
              className={page === displayPage ? "page-button active" : "page-button"}
              onClick={() => setCurrentPage(page)}
              aria-current={page === displayPage ? "page" : undefined}
            >
              {page}
            </button>
          ))}
          <button className="page-button icon" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={displayPage === totalPages} title={t("next")}>
            <ChevronRight size={15} />
          </button>
          <button className="page-button icon" onClick={() => setCurrentPage(totalPages)} disabled={displayPage === totalPages} title="Last page">
            <ChevronsRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
