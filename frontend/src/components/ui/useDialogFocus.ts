/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/useDialogFocus.ts
 *
 * Adaptations:
 *   - Background inerting is reference counted. See the note on `backgroundLocks`
 *     below: the historical per-dialog snapshot/restore broke whenever a dialog
 *     opened on top of another one.
 *   - The overlay stack now records the overlay/layer element as well, so an
 *     underlying dialog is made inert even when the child dialog is rendered
 *     *inside* the parent's layer instead of as a sibling.
 *   - Escape is governed by an explicit dismissal policy (`closeOnEscape`).
 *   - Focus restoration falls back to the remaining topmost dialog when the
 *     original trigger was removed (route transition, list refresh).
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface OverlayEntry {
  dialog: HTMLElement;
  layer: HTMLElement;
}

const dialogStack: OverlayEntry[] = [];

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

/**
 * Elements behind the active overlay: every sibling along the dialog's ancestor
 * chain, stopping at <body> so the shell itself is never made inert.
 */
function collectBackgroundSiblings(dialog: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  let activeBranch: HTMLElement = dialog;
  while (activeBranch.parentElement) {
    const parent = activeBranch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === activeBranch) continue;
      elements.push(sibling);
    }
    if (parent === document.body) break;
    activeBranch = parent;
  }
  return elements;
}

/**
 * Disabled, hidden, inert and non-rendered elements are not eligible for focus.
 * `getClientRects()` excludes `display: none` and detached subtrees; the
 * attribute checks cover visually hidden but still rendered controls.
 */
function isFocusEligible(element: HTMLElement): boolean {
  if (element.getClientRects().length === 0) return false;
  if (element.closest("[inert]")) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  return true;
}

function collectFocusable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusEligible);
}

function focusTopmostFallback() {
  const topmost = dialogStack.at(-1)?.dialog;
  if (topmost && topmost.isConnected) {
    topmost.focus({ preventScroll: true });
    return;
  }
  document.body.focus({ preventScroll: true });
}

interface UseDialogFocusOptions {
  open: boolean;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Explicit Escape policy. `true` (the default) keeps the historical behaviour;
   * `false` blocks Escape entirely without invoking `onClose`, so an in-flight
   * mutation cannot be dismissed through the keyboard.
   */
  closeOnEscape?: boolean;
}

export function useDialogFocus({
  open,
  onClose,
  initialFocusRef,
  closeOnEscape = true,
}: UseDialogFocusOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const closeOnEscapeRef = useRef(closeOnEscape);

  useEffect(() => {
    onCloseRef.current = onClose;
    closeOnEscapeRef.current = closeOnEscape;
  }, [closeOnEscape, onClose]);

  useEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const layer = dialog.parentElement instanceof HTMLElement ? dialog.parentElement : dialog;
    const entry: OverlayEntry = { dialog, layer };
    const layersBelow = dialogStack.map((item) => item.layer);
    dialogStack.push(entry);

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backgroundElements = collectBackgroundSiblings(dialog);
    lockBodyOverflow();
    lockBackground(backgroundElements);
    /*
     * A child rendered *inside* its parent's layer is an ancestor of the child,
     * so the sibling walk above cannot inert it. Lock every layer below the
     * current one explicitly; the reference count keeps both mechanisms
     * balanced and order-independent.
     */
    lockBackground(layersBelow);

    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = initialFocusRef?.current;
      const target =
        preferred && preferred.isConnected && dialog.contains(preferred) && isFocusEligible(preferred)
          ? preferred
          : collectFocusable(dialog)[0] ?? dialog;
      target.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (dialogStack.at(-1)?.dialog !== dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!closeOnEscapeRef.current) return;
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = collectFocusable(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
        /* Keyboard focus drifted behind the topmost overlay: pull it back. */
        event.preventDefault();
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      const stackIndex = dialogStack.lastIndexOf(entry);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      releaseBackground(layersBelow);
      releaseBackground(backgroundElements);
      releaseBodyOverflow();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      else focusTopmostFallback();
    };
  }, [initialFocusRef, open]);

  return dialogRef;
}
