/*
 * Legacy modal adapter.
 *
 * The historical Modal rendered its own backdrop and never reused the shared
 * dialog infrastructure, so keyboard focus could escape behind a blocking
 * modal. It is kept as a compatibility adapter: the public props are unchanged,
 * the markup classes the existing stylesheets rely on are preserved, and the
 * interaction contract (focus trap, focus restoration, Escape policy, reference
 * counted background isolation) is delegated to the shared Dialog.
 */
import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { Dialog } from './ui/Dialog';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
  /** Escape dismissal policy; keyboard dismissal is provided by the shared policy. */
  closeOnEscape?: boolean;
  /**
   * Backdrop dismissal policy. The historical Modal ignored backdrop clicks, so
   * the adapter keeps that default; a consumer opts in when it has been tested.
   */
  closeOnOverlay?: boolean;
  /** Opt-in body-level overlay boundary. */
  portal?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth,
  closeOnEscape = true,
  closeOnOverlay = false,
  portal = false,
  initialFocusRef,
}: ModalProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      overlayClassName="modal-backdrop"
      className="modal-card"
      labelledBy={titleId}
      initialFocusRef={initialFocusRef ?? closeButtonRef}
      closeOnEscape={closeOnEscape}
      closeOnOverlay={closeOnOverlay}
      portal={portal}
      style={maxWidth ? { width: maxWidth } : undefined}
    >
      <header className="modal-header">
        <h2 id={titleId}>{title}</h2>
        <button
          ref={closeButtonRef}
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>
      </header>
      <div className="modal-body">{children}</div>
      {footer ? <footer className="modal-footer">{footer}</footer> : null}
    </Dialog>
  );
}
