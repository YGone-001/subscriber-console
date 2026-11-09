import styles from '../../styles/modules/DataTablePagination.module.css';

type CursorPaginationProps = {
  summary: string;
  previousLabel: string;
  nextLabel: string;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

/** Cursor navigation keeps the shared table geometry without inventing page totals. */
export function CursorPagination({ summary, previousLabel, nextLabel, hasPrevious, hasNext, onPrevious, onNext }: CursorPaginationProps) {
  return <nav className={styles.root} aria-label={summary}>
    <div className={styles.summary} aria-live="polite">{summary}</div>
    <div className={styles.controls}>
      <button type="button" disabled={!hasPrevious} onClick={onPrevious}>{previousLabel}</button>
      <button type="button" disabled={!hasNext} onClick={onNext}>{nextLabel}</button>
    </div>
  </nav>;
}
