import type { CSSProperties, ReactNode } from "react";
import styles from "./SortableTableHeader.module.css";

interface SortableTableHeaderProps {
  label: ReactNode;
  active: boolean;
  direction: "asc" | "desc";
  icon: ReactNode;
  onSort: () => void;
  style?: CSSProperties;
  priority?: "essential" | "important" | "supplementary";
}

export function SortableTableHeader({
  label,
  active,
  direction,
  icon,
  onSort,
  style,
  priority = "essential",
}: SortableTableHeaderProps) {
  return (
    <th
      className={`${styles.header} ${active ? styles.active : ""}`}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      style={style}
      data-column-priority={priority}
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
