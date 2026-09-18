"use client";

import type { CSSProperties, KeyboardEventHandler, MouseEvent, ReactNode, RefObject } from "react";
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
  role?: "dialog" | "alertdialog";
  closeOnOverlay?: boolean;
  overlayStyle?: CSSProperties;
  style?: CSSProperties;
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
  role = "dialog",
  closeOnOverlay = true,
  overlayStyle,
  style,
}: DialogProps) {
  const dialogRef = useDialogFocus({ open, onClose, initialFocusRef });

  if (!open) return null;

  const handleOverlayMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (closeOnOverlay && event.target === event.currentTarget) onClose();
  };

  return (
    <div className={overlayClassName} style={overlayStyle} onMouseDown={handleOverlayMouseDown}>
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        tabIndex={-1}
        className={className}
        style={style}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
