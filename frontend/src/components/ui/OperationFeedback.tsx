import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

export type FeedbackTone = 'info' | 'success' | 'warning' | 'danger';

const TONE_ICON: Record<FeedbackTone, ReactNode> = {
  info: <Info size={16} />,
  success: <CheckCircle2 size={16} />,
  warning: <AlertTriangle size={16} />,
  danger: <AlertTriangle size={16} />,
};

export type OperationFeedbackProps = {
  tone: FeedbackTone;
  title?: string;
  message: string;
  onDismiss?: () => void;
};

/**
 * Inline operator feedback. Presentation only: it never decides whether an
 * operation succeeded and never replaces a persistent error surface.
 */
export function OperationFeedback({ tone, title, message, onDismiss }: OperationFeedbackProps) {
  return (
    <div className={`op-notice-container op-notice-inline op-notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className={`op-notice-icon-box op-notice-icon-${tone}`} aria-hidden="true">{TONE_ICON[tone]}</span>
      <div className="op-notice-content">
        {title ? <p className="op-notice-title">{title}</p> : null}
        <p className="op-notice-message">{message}</p>
      </div>
      {onDismiss ? (
        <button type="button" className="op-notice-close-btn" onClick={onDismiss} aria-label="Dismiss">
          <X size={15} />
        </button>
      ) : null}
    </div>
  );
}
