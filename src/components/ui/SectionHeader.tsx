import type { ReactNode } from "react";
import styles from "./ConsolePrimitives.module.css";

type SectionHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export default function SectionHeader({ title, description, actions, className }: SectionHeaderProps) {
  return (
    <header className={[styles.sectionHeader, className || ""].filter(Boolean).join(" ")}>
      <div>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {description ? <p className={styles.sectionDescription}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
    </header>
  );
}
