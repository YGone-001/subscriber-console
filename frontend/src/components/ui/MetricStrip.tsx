/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/MetricStrip.tsx
 * Adaptations: "use client" dropped; CSS-module import repointed to ../../styles/modules/.
 */
import type { CSSProperties, ReactNode } from "react";
import styles from '../../styles/modules/ConsolePrimitives.module.css';

export type MetricTone = "primary" | "success" | "warning" | "danger" | "muted";

export type MetricStripVariant = "strip" | "cards";

export type MetricStripItem = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  tone?: MetricTone;
  icon?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  detail?: ReactNode;
  indicator?: ReactNode;
  accent?: string;
  compactValue?: boolean;
};

type MetricStripProps = {
  items: MetricStripItem[];
  ariaLabel: string;
  className?: string;
  variant?: MetricStripVariant;
  columns?: number;
};

export default function MetricStrip({ items, ariaLabel, className, variant = "strip", columns }: MetricStripProps) {
  if (variant === "cards") {
    const cardsStyle = columns ? ({ "--metric-card-count": columns } as CSSProperties) : undefined;

    return (
      <section
        className={[styles.metricCards, className || ""].filter(Boolean).join(" ")}
        style={cardsStyle}
        data-columns={columns ? "true" : undefined}
        aria-label={ariaLabel}
      >
        {items.map((item) => (
          <div
            key={item.key}
            className={styles.metricCard}
            data-tone={item.tone || "primary"}
            style={item.accent ? ({ "--metric-accent": item.accent } as CSSProperties) : undefined}
          >
            <div className={styles.metricCardHead}>
              <span className={styles.metricCardLabel}>{item.label}</span>
              {item.icon ? <span className={styles.metricCardIcon}>{item.icon}</span> : null}
            </div>
            <div className={styles.metricCardValue} data-compact={item.compactValue ? "true" : undefined}>{item.value}</div>
            {item.detail ? <div className={styles.metricCardDetail}>{item.detail}</div> : null}
            {item.indicator ? <div className={styles.metricCardIndicator}>{item.indicator}</div> : null}
          </div>
        ))}
      </section>
    );
  }

  const stripStyle = { "--metric-count": Math.min(items.length, 6) } as CSSProperties;

  return (
    <section
      className={[styles.metricStrip, className || ""].filter(Boolean).join(" ")}
      style={stripStyle}
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const content = (
          <>
            <span className={styles.metricCopy}>
              <span className={styles.metricLabel}>{item.label}</span>
              <strong className={styles.metricValue}>{item.value}</strong>
            </span>
            {item.icon ? <span className={styles.metricIcon}>{item.icon}</span> : null}
          </>
        );

        if (item.onClick) {
          return (
            <button
              key={item.key}
              type="button"
              className={styles.metricItem}
              data-tone={item.tone || "primary"}
              data-active={item.active || undefined}
              onClick={item.onClick}
              aria-label={item.ariaLabel}
              aria-pressed={item.active}
            >
              {content}
            </button>
          );
        }

        return (
          <div key={item.key} className={styles.metricItem} data-tone={item.tone || "primary"}>
            {content}
          </div>
        );
      })}
    </section>
  );
}