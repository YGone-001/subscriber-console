/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/ChartDataTable.tsx
 * Adaptations: "use client" dropped; CSS-module import repointed to ../../styles/modules/.
 */
import type { ReactNode } from "react";
import styles from '../../styles/modules/ChartDataTable.module.css';

interface ChartDataColumn {
  key: string;
  label: ReactNode;
  numeric?: boolean;
}

interface ChartDataRow {
  key: string;
  cells: ReactNode[];
}

interface ChartDataTableProps {
  label: ReactNode;
  caption: ReactNode;
  columns: readonly ChartDataColumn[];
  rows: readonly ChartDataRow[];
}

export function ChartDataTable({ label, caption, columns, rows }: ChartDataTableProps) {
  return (
    <details className={styles.root}>
      <summary className={styles.summary}>{label}</summary>
      <div className={styles.scroller}>
        <table className={styles.table}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" data-numeric={column.numeric ? "true" : undefined}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {columns.map((column, index) => (
                  <td key={column.key} data-numeric={column.numeric ? "true" : undefined}>
                    {row.cells[index] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
