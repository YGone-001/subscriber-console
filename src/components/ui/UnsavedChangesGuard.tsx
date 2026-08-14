"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
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
  const discardRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    keepEditingRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onMouseDown={onKeepEditing} onClick={(event) => event.stopPropagation()}>
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onKeepEditing();
          if (event.key === "Tab") {
            const movingBackward = event.shiftKey;
            if (movingBackward && document.activeElement === keepEditingRef.current) {
              event.preventDefault();
              discardRef.current?.focus();
            } else if (!movingBackward && document.activeElement === discardRef.current) {
              event.preventDefault();
              keepEditingRef.current?.focus();
            }
          }
        }}
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
          <button ref={discardRef} type="button" className="btn btn-danger" onClick={onDiscard}>
            {discardLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useUnsavedChangesGuard(isDirty: boolean | (() => boolean), onDiscard: () => void) {
  const [isPromptOpen, setIsPromptOpen] = useState(false);
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

  const requestClose = useCallback(() => {
    if (checkDirty()) {
      setIsPromptOpen(true);
      return;
    }
    onDiscard();
  }, [checkDirty, onDiscard]);

  const keepEditing = useCallback(() => setIsPromptOpen(false), []);
  const discardChanges = useCallback(() => {
    setIsPromptOpen(false);
    onDiscard();
  }, [onDiscard]);

  return { isPromptOpen, requestClose, keepEditing, discardChanges };
}
