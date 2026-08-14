import type { ReactNode } from "react";
import styles from "./DataTableState.module.css";

type DataTableState = "loading" | "empty" | "error";

interface DataTableStateRowProps {
  colSpan: number;
  state: DataTableState;
  children: ReactNode;
}

export function DataTableStateRow({ colSpan, state, children }: DataTableStateRowProps) {
  return (
    <tr className={styles.row} data-state={state}>
      <td colSpan={colSpan} className={styles.cell}>
        <span role={state === "error" ? "alert" : "status"} aria-live="polite">
          {children}
        </span>
      </td>
    </tr>
  );
}
