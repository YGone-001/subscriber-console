/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/SectionHeader.tsx
 * Adaptations: "use client" dropped; CSS-module import repointed to ../../styles/modules/.
 */
import type { ReactNode } from "react";
import styles from '../../styles/modules/ConsolePrimitives.module.css';

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
