/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/OperationFeedback.tsx
 *
 * Adaptations: "use client" dropped; `@/components/...` aliases replaced with
 * relative imports; the local stylesheet import dropped because
 * `styles/feedback.css` is already loaded through the stylesheet entry layer.
 *
 * The reference exports `OperationNotice`, `ConfirmActionPanel`, `EmptyState` and
 * `LoadingRows`. The earlier local `OperationFeedback` component (a smaller
 * inline notice with a different prop shape) is kept as a named export so
 * existing call sites keep working unchanged.
 */
import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { Dialog } from './Dialog';

export type FeedbackTone = 'info' | 'success' | 'warning' | 'danger';

function ToneIcon({ tone, size = 18 }: { tone: FeedbackTone; size?: number }) {
  if (tone === 'success') return <CheckCircle2 size={size} />;
  if (tone === 'danger' || tone === 'warning') return <AlertTriangle size={size} />;
  return <Info size={size} />;
}

export function OperationNotice({
  tone,
  presentation = 'inline',
  title,
  message,
  onClose,
}: {
  tone: FeedbackTone;
  presentation?: 'inline' | 'modal';
  title?: string;
  message: string;
  onClose?: () => void;
}) {
  const isModal = presentation === 'modal';
  const titleId = useId();
  const messageId = useId();
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  const containerClass = `op-notice-container ${isModal ? 'op-notice-modal' : 'op-notice-inline'} op-notice-${tone}${isModal ? '-modal' : ''}`;

  const notice = (
    <div role={isModal ? undefined : tone === 'danger' ? 'alert' : 'status'} className={containerClass}>
      <div className={`op-notice-icon-box op-notice-icon-${tone}`} aria-hidden="true">
        <ToneIcon tone={tone} />
      </div>
      <div className="op-notice-content">
        {title && <h2 id={titleId} className="op-notice-title">{title}</h2>}
        <div id={messageId} className="op-notice-message">{message}</div>
        {isModal && onClose && (
          <button
            ref={acknowledgeRef}
            type="button"
            className="btn btn-primary op-notice-ok-btn"
            onClick={onClose}
          >
            OK
          </button>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notice"
          className="op-notice-close-btn"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );

  if (isModal) {
    return (
      <Dialog
        open
        onClose={onClose || (() => undefined)}
        overlayClassName="op-modal-backdrop"
        className="op-modal-dialog-shell"
        labelledBy={title ? titleId : undefined}
        describedBy={messageId}
        ariaLabel={title || message}
        initialFocusRef={acknowledgeRef}
      >
        {notice}
      </Dialog>
    );
  }

  return notice;
}

export function ConfirmActionPanel({
  tone = 'danger',
  presentation = 'inline',
  title,
  message,
  children,
  confirmLabel,
  cancelLabel,
  isWorking,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  tone?: FeedbackTone;
  presentation?: 'inline' | 'modal';
  title: string;
  message: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  isWorking?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isModal = presentation === 'modal';
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const containerClass = `op-confirm-panel ${isModal ? 'op-confirm-modal' : 'op-confirm-inline'} op-confirm-${tone}${isModal ? '-modal' : ''}`;

  const panel = (
    <div className={containerClass}>
      <div className={`op-confirm-icon-box op-confirm-icon-${tone}`} aria-hidden="true">
        <ToneIcon tone={tone} size={19} />
      </div>
      <div className="op-confirm-content">
        <h2 id={titleId} className="op-confirm-title">{title}</h2>
        <div id={messageId} className="op-confirm-message">{message}</div>
        {children && <div className="op-confirm-children">{children}</div>}
      </div>
      <div className="op-confirm-actions">
        <button ref={cancelRef} type="button" className="btn btn-outline" onClick={onCancel} disabled={isWorking}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn op-confirm-btn op-confirm-btn-${tone}`}
          onClick={onConfirm}
          disabled={isWorking || confirmDisabled}
        >
          {isWorking ? <Loader2 size={16} className="op-spinner" /> : confirmLabel}
        </button>
      </div>
    </div>
  );

  if (isModal) {
    return (
      <Dialog
        open
        onClose={() => { if (!isWorking) onCancel(); }}
        overlayClassName="op-modal-backdrop-darker"
        className="op-modal-dialog-shell"
        labelledBy={titleId}
        describedBy={messageId}
        initialFocusRef={cancelRef}
        role="alertdialog"
        closeOnOverlay={!isWorking}
      >
        {panel}
      </Dialog>
    );
  }

  return panel;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="op-empty-state">
      <div className="op-empty-icon">{icon}</div>
      <div className="op-empty-title">{title}</div>
      {description && <div className="op-empty-desc">{description}</div>}
      {action && <div className="op-empty-action">{action}</div>}
    </div>
  );
}

export function LoadingRows({ columns = 6, rows = 5 }: { columns?: number; rows?: number }) {
  return (
    <div className="op-loading-container" aria-busy="true">
      <div
        className="op-loading-header"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(64px, 1fr))` }}
      >
        {Array.from({ length: columns }, (_, index) => (
          <div key={index} className="skeleton-loader op-loading-cell" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="op-loading-row">
          {Array.from({ length: 5 }, (_, colIndex) => (
            <div key={colIndex} className="skeleton-loader op-loading-cell" />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Backward-compatible local notice.
 *
 * The earlier shell/business layer shipped a smaller inline notice under this
 * name. It is preserved so no existing call site regresses.
 * ------------------------------------------------------------------------- */

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
