import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';

export type EmptyStateProps = {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
};

/** Structured empty state: heading, explanation and an optional valid action. */
export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <section className="state-panel" role="status">
      <span className="state-panel-icon" aria-hidden="true">{icon ?? <Inbox size={30} />}</span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div className="state-panel-actions">{action}</div> : null}
    </section>
  );
}

export type ErrorStateProps = {
  title: string;
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
};

/** Operator-facing error panel. Backend error text is surfaced unchanged. */
export function ErrorState({ title, message, retryLabel, onRetry }: ErrorStateProps) {
  return (
    <section className="state-panel error" role="alert">
      <span className="state-panel-icon" aria-hidden="true"><AlertTriangle size={28} /></span>
      <h3>{title}</h3>
      <p>{message}</p>
      {onRetry ? (
        <div className="state-panel-actions">
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            <RefreshCw size={15} />
            {retryLabel ?? 'Retry'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export type LoadingStateProps = { label: string };

/** Accessible inline loading indicator for surfaces without a skeleton. */
export function LoadingState({ label }: LoadingStateProps) {
  return (
    <section className="state-panel" role="status" aria-live="polite">
      <span className="state-panel-icon" aria-hidden="true"><RefreshCw size={26} className="op-spinner" /></span>
      <p>{label}</p>
    </section>
  );
}
