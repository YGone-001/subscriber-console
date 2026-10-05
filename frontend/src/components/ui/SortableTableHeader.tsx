/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/SortableTableHeader.tsx
 * Adaptations: "use client" dropped; CSS-module import repointed to ../../styles/modules/.
 */
import type { CSSProperties, ReactNode } from "react";
import styles from '../../styles/modules/SortableTableHeader.module.css';

interface SortableTableHeaderProps {
  label: ReactNode;
  active: boolean;
  direction: "asc" | "desc";
  icon: ReactNode;
  onSort: () => void;
  style?: CSSProperties;
  className?: string;
  priority?: "essential" | "important" | "supplementary";
}

export function SortableTableHeader({
  label,
  active,
  direction,
  icon,
  onSort,
  style,
  className,
  priority = "essential",
}: SortableTableHeaderProps) {
  return (
    <th
      className={`${styles.header} ${active ? styles.active : ""} ${className ?? ""}`}
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
