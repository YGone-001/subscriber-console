/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/Dialog.tsx
 * Adaptations: "use client" dropped; CSS-module import repointed to ../../styles/modules/.
 *
 * The overlay surface is now the single interaction authority for every consumer:
 *   - `closeOnOverlay` / `closeOnEscape` are independent dismissal policies.
 *   - `portal` moves the overlay into a body-level boundary so deeply nested page
 *     components cannot be covered by shell headers, sidebars or floating panels.
 *     It is opt-in: consumers keep their current DOM position unless they ask.
 */
import { useLayoutEffect, useState } from "react";
import type { CSSProperties, KeyboardEventHandler, MouseEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
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
  closeOnEscape?: boolean;
  portal?: boolean;
  overlayStyle?: CSSProperties;
  style?: CSSProperties;
}

/*
 * Portal overlays live in their own body-level layer. Every dialog gets a stable
 * monotonic level, which keeps the visual order deterministic (a child always
 * paints above its parent) while leaving the non-portal consumers on their
 * existing CSS z-index.
 */
let portalLevelSeed = 0;

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
  closeOnEscape = true,
  portal = false,
  overlayStyle,
  style,
}: DialogProps) {
  const dialogRef = useDialogFocus({ open, onClose, initialFocusRef, closeOnEscape });
  const [portalHost] = useState<HTMLElement | null>(() => {
    if (!portal || typeof document === "undefined") return null;
    const host = document.createElement("div");
    host.className = "xcloud-dialog-portal";
    host.setAttribute("data-xcloud-overlay-portal", "");
    return host;
  });
  const [portalLevel] = useState(() => {
    if (!portalHost) return 0;
    portalLevelSeed += 1;
    return portalLevelSeed;
  });

  useLayoutEffect(() => {
    if (!portalHost || !open) return;
    document.body.appendChild(portalHost);
    return () => {
      portalHost.remove();
    };
  }, [open, portalHost]);

  if (!open) return null;

  const handleOverlayMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!closeOnOverlay) return;
    if (event.button !== 0) return;
    if (event.target === event.currentTarget) onClose();
  };

  const overlay = (
    <div
      className={overlayClassName}
      style={portalHost ? { ...overlayStyle, zIndex: 1200 + portalLevel } : overlayStyle}
      onMouseDown={handleOverlayMouseDown}
    >
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

  return portalHost ? createPortal(overlay, portalHost) : overlay;
}
