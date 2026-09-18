"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useDialogFocus } from "./useDialogFocus";
import styles from "./UnsavedChangesGuard.module.css";

interface UnsavedChangesDialogProps {
  open: boolean;
  title: string;
  description: string;
  keepEditingLabel: string;
  discardLabel: string;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

export function UnsavedChangesDialog({
  open,
  title,
  description,
  keepEditingLabel,
  discardLabel,
  onKeepEditing,
  onDiscard,
}: UnsavedChangesDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialogFocus({ open, onClose: onKeepEditing, initialFocusRef: keepEditingRef });

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onKeepEditing();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <span className={styles.icon} aria-hidden="true"><AlertTriangle size={22} /></span>
        <div className={styles.content}>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </div>
        <div className={styles.actions}>
          <button ref={keepEditingRef} type="button" className="btn btn-outline" onClick={onKeepEditing}>
            {keepEditingLabel}
          </button>
          <button type="button" className="btn btn-danger" onClick={onDiscard}>
            {discardLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useUnsavedChangesGuard(isDirty: boolean | (() => boolean), onDiscard: () => void) {
  const router = useRouter();
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const pendingNavigationRef = useRef<string | null>(null);
  const checkDirty = useCallback(
    () => typeof isDirty === "function" ? isDirty() : isDirty,
    [isDirty],
  );

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!checkDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [checkDirty]);

  useEffect(() => {
    const handleNavigationClick = (event: MouseEvent) => {
      if (
        !checkDirty()
        || event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
        || !(event.target instanceof Element)
      ) return;

      const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.download || (anchor.target && anchor.target !== "_self")) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;

      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const destinationPath = `${destination.pathname}${destination.search}${destination.hash}`;
      if (destinationPath === currentPath) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      pendingNavigationRef.current = destinationPath;
      setIsPromptOpen(true);
    };

    document.addEventListener("click", handleNavigationClick, true);
    return () => document.removeEventListener("click", handleNavigationClick, true);
  }, [checkDirty]);

  const requestClose = useCallback(() => {
    if (checkDirty()) {
      pendingNavigationRef.current = null;
      setIsPromptOpen(true);
      return;
    }
    onDiscard();
  }, [checkDirty, onDiscard]);

  const keepEditing = useCallback(() => {
    pendingNavigationRef.current = null;
    setIsPromptOpen(false);
  }, []);
  const discardChanges = useCallback(() => {
    const pendingNavigation = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    setIsPromptOpen(false);
    onDiscard();
    if (pendingNavigation) router.push(pendingNavigation);
  }, [onDiscard, router]);

  return { isPromptOpen, requestClose, keepEditing, discardChanges };
}
