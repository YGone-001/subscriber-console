"use client";

import type { KeyboardEventHandler, MouseEvent, ReactNode, RefObject } from "react";
import { useDialogFocus } from "./useDialogFocus";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className: string;
  overlayClassName: string;
  labelledBy?: string;
  describedBy?: string;
  ariaLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

export function Dialog({
  open,
  onClose,
  children,
  className,
  overlayClassName,
  labelledBy,
  describedBy,
  ariaLabel,
  initialFocusRef,
  onKeyDown,
}: DialogProps) {
  const dialogRef = useDialogFocus({ open, onClose, initialFocusRef });

  if (!open) return null;

  const handleOverlayMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className={overlayClassName} onMouseDown={handleOverlayMouseDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        tabIndex={-1}
        className={className}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
