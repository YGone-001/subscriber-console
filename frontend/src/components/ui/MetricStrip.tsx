import type { CSSProperties, ReactNode } from "react";
import styles from "./ConsolePrimitives.module.css";

export type MetricTone = "primary" | "success" | "warning" | "danger" | "muted";

export type MetricStripItem = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  tone?: MetricTone;
  icon?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
};

type MetricStripProps = {
  items: MetricStripItem[];
  ariaLabel: string;
  className?: string;
};

export default function MetricStrip({ items, ariaLabel, className }: MetricStripProps) {
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
