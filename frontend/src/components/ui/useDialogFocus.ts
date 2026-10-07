/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/useDialogFocus.ts
 *
 * Adaptation: background inerting is now reference counted. See the note on
 * `backgroundLocks` - the historical per-dialog snapshot/restore broke whenever a
 * dialog opened on top of another one.
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const dialogStack: HTMLDivElement[] = [];

/*
 * Background lock, reference counted.
 *
 * Every dialog inerts the background elements along its ancestor chain. The historical
 * implementation snapshotted those elements PER DIALOG and restored them on unmount,
 * which breaks with nested dialogs:
 *
 *   1. the subscriber dialog opens and inerts #root, snapshotting inert=false
 *   2. the unsaved-changes prompt opens on top; #root is ALREADY inert, so its
 *      snapshot records inert=true
 *   3. both unmount together; if the prompt's cleanup runs after the dialog's, it
 *      writes inert=true back onto #root
 *
 * The app root then stays inert and the entire page stops responding to clicks.
 * Counting the locks makes apply and restore symmetric no matter how dialogs nest or
 * in which order React unmounts them: an element is restored only when the last holder
 * releases it.
 */
type BackgroundLock = { originalInert: boolean; originalAriaHidden: string | null; holders: number };
const backgroundLocks = new Map<HTMLElement, BackgroundLock>();
let overflowHolders = 0;
let originalBodyOverflow = "";

function lockBackground(elements: HTMLElement[]) {
  for (const element of elements) {
    const existing = backgroundLocks.get(element);
    if (existing) {
      existing.holders += 1;
      continue;
    }
    backgroundLocks.set(element, {
      originalInert: element.inert,
      originalAriaHidden: element.getAttribute("aria-hidden"),
      holders: 1,
    });
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
  }
}

function releaseBackground(elements: HTMLElement[]) {
  for (const element of elements) {
    const entry = backgroundLocks.get(element);
    if (!entry) continue;
    entry.holders -= 1;
    if (entry.holders > 0) continue;
    backgroundLocks.delete(element);
    element.inert = entry.originalInert;
    if (entry.originalAriaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", entry.originalAriaHidden);
  }
}

function lockBodyOverflow() {
  if (overflowHolders === 0) originalBodyOverflow = document.body.style.overflow;
  overflowHolders += 1;
  document.body.style.overflow = "hidden";
}

function releaseBodyOverflow() {
  overflowHolders = Math.max(0, overflowHolders - 1);
  if (overflowHolders === 0) document.body.style.overflow = originalBodyOverflow;
}

interface UseDialogFocusOptions {
  open: boolean;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function useDialogFocus({ open, onClose, initialFocusRef }: UseDialogFocusOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    dialogStack.push(dialog);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const lockedElements: HTMLElement[] = [];
    lockBodyOverflow();

    const focusFrame = window.requestAnimationFrame(() => {
      let activeBranch: HTMLElement = dialog;
      while (activeBranch.parentElement) {
        const parent = activeBranch.parentElement;
        for (const sibling of Array.from(parent.children)) {
          if (!(sibling instanceof HTMLElement) || sibling === activeBranch) continue;
          lockedElements.push(sibling);
        }
        if (parent === document.body) break;
        activeBranch = parent;
      }
      lockBackground(lockedElements);

      const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (initialFocusRef?.current || firstFocusable || dialogRef.current)?.focus();
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (dialogStack.at(-1) !== dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);

      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      const stackIndex = dialogStack.lastIndexOf(dialog);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      releaseBodyOverflow();
      releaseBackground(lockedElements);
      previousFocus?.focus();
    };
  }, [initialFocusRef, open]);

  return dialogRef;
}
