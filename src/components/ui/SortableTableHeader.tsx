import type { CSSProperties, ReactNode } from "react";
import styles from "./SortableTableHeader.module.css";

interface SortableTableHeaderProps {
  label: ReactNode;
  active: boolean;
  direction: "asc" | "desc";
  icon: ReactNode;
  onSort: () => void;
  style?: CSSProperties;
}

export function SortableTableHeader({
  label,
  active,
  direction,
  icon,
  onSort,
  style,
}: SortableTableHeaderProps) {
  return (
    <th
      className={`${styles.header} ${active ? styles.active : ""}`}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      style={style}
    >
      <button type="button" className={styles.button} onClick={onSort}>
        <span>{label}</span>
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      </button>
    </th>
  );
}
