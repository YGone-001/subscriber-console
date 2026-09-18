"use client";

import styles from "./DataTablePagination.module.css";

const DEFAULT_PAGE_SIZES = [10, 20, 50, 100] as const;

interface PaginationLabels {
  showing: string;
  to: string;
  of: string;
  entries: string;
  previous: string;
  next: string;
  perPage: string;
}

interface DataTablePaginationProps {
  page: number;
  pageSize: number;
  total: number;
  visibleCount: number;
  totalPages: number;
  labels: PaginationLabels;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizes?: readonly number[];
}

export function DataTablePagination({
  page,
  pageSize,
  total,
  visibleCount,
  totalPages,
  labels,
  onPageChange,
  onPageSizeChange,
  pageSizes = DEFAULT_PAGE_SIZES,
}: DataTablePaginationProps) {
  const firstEntry = visibleCount > 0 ? (page - 1) * pageSize + 1 : 0;
  const lastEntry = Math.min(page * pageSize, total);

  return (
    <nav className={styles.root} aria-label={labels.entries}>
      <div className={styles.summary} aria-live="polite">
        {labels.showing} {firstEntry} {labels.to} {lastEntry} {labels.of} {total} {labels.entries}
      </div>
      <div className={styles.controls}>
        <label className={styles.pageSize}>
          <span className="sr-only">{labels.perPage}</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label={labels.perPage}
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>{size} {labels.perPage}</option>
            ))}
          </select>
        </label>
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>
          {labels.previous}
        </button>
        <span className={styles.pageNumber}>{page} / {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(Math.min(totalPages, page + 1))}>
          {labels.next}
        </button>
      </div>
    </nav>
  );
}
