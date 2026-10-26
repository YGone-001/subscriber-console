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
  /** Optional class for the detail line only, so one surface can let a long
   * sentence wrap without changing the shared primitive for every consumer. */
  detailClassName?: string;
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
  const detailClass = (item: MetricStripItem, base: string) => [base, item.detailClassName || ""].filter(Boolean).join(" ");

  if (variant === "cards") {
    const cardsStyle = columns ? ({ "--metric-card-count": columns } as CSSProperties) : undefined;

    return (
      <section
        className={[styles.metricCards, className || ""].filter(Boolean).join(" ")}
        style={cardsStyle}
        data-columns={columns ? "true" : undefined}
        aria-label={ariaLabel}
      >
        {items.map((item) => {
          const content = (
            <>
              <span className={styles.metricCardHead}>
                <span className={styles.metricCardLabel}>{item.label}</span>
                {item.icon ? <span className={styles.metricCardIcon}>{item.icon}</span> : null}
              </span>
              <span className={styles.metricCardValue} data-compact={item.compactValue ? "true" : undefined}>{item.value}</span>
              {item.detail ? <span className={detailClass(item, styles.metricCardDetail)}>{item.detail}</span> : null}
              {item.indicator ? <span className={styles.metricCardIndicator}>{item.indicator}</span> : null}
            </>
          );

          if (item.onClick) {
            return (
              <button
                key={item.key}
                type="button"
                className={`${styles.metricCard} ${styles.metricCardButton}`}
                data-tone={item.tone || "primary"}
                style={item.accent ? ({ "--metric-accent": item.accent } as CSSProperties) : undefined}
                onClick={item.onClick}
                aria-label={item.ariaLabel}
              >
                {content}
              </button>
            );
          }

          return (
            <div
              key={item.key}
              className={styles.metricCard}
              data-tone={item.tone || "primary"}
              style={item.accent ? ({ "--metric-accent": item.accent } as CSSProperties) : undefined}
            >
              {content}
            </div>
          );
        })}
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
        /*
         * The strip renders the same information as the card variant - detail line and
         * trailing indicator included - so a surface can adopt the continuous panel without
         * losing any data. Items are laid out on a three-track grid (copy / indicator /
         * icon); a track collapses to zero width when the item does not use it.
         */
        const content = (
          <>
            <span className={styles.metricCopy}>
              <span className={styles.metricLabel}>{item.label}</span>
              <strong className={styles.metricValue}>{item.value}</strong>
              {item.detail ? <span className={detailClass(item, styles.metricDetail)}>{item.detail}</span> : null}
            </span>
            {item.indicator ? <span className={styles.metricIndicator}>{item.indicator}</span> : null}
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