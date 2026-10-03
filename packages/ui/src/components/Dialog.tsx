import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cx } from "../lib/cx.js";

/**
 * Dialog — modal dialog shell with keyboard and focus management.
 *
 * Renders exactly the DOM the hand-written dialogs used, so styles and
 * `getByRole("dialog", { name })` queries keep working:
 *
 *   div.dialog-overlay[role=presentation]
 *     section.dialog[role=dialog][aria-modal=true][aria-labelledby]
 *       {children}   // .dialog-header / .dialog-body / .dialog-footer
 *
 * Behaviour: Esc closes (when `dismissible`), focus moves into the dialog on
 * mount (first focusable element, or `initialFocusRef`), Tab is trapped inside,
 * and focus returns to the previously focused element on unmount. With stacked
 * dialogs only the topmost one reacts to the keyboard.
 */
export interface DialogProps {
  /** id of the element that titles the dialog (`aria-labelledby`). */
  labelledBy: string;
  /** Optional id of descriptive text (`aria-describedby`). */
  describedBy?: string;
  /**
   * Called for Esc and (when `closeOnOverlayClick`) backdrop clicks. Not called
   * while `dismissible` is false.
   */
  onClose?: () => void;
  /** Set false while a submit is in flight: Esc and backdrop clicks are ignored. Default true. */
  dismissible?: boolean;
  /** Close when the backdrop is clicked. Default false (safer for forms). */
  closeOnOverlayClick?: boolean;
  /** Element to focus on open instead of the first focusable one. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Extra class on the `.dialog` section (e.g. a width modifier). */
  className?: string;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true"
  );
}

/** Open dialogs, topmost last. Only the topmost handles the keyboard. */
const openDialogs: object[] = [];

export function Dialog({
  labelledBy,
  describedBy,
  onClose,
  dismissible = true,
  closeOnOverlayClick = false,
  initialFocusRef,
  className,
  children
}: DialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const mouseDownOnOverlay = useRef(false);

  // Latest props for the document-level handler, without re-subscribing.
  const latest = useRef({ onClose, dismissible });
  latest.current = { onClose, dismissible };
  const initialFocus = useRef(initialFocusRef);
  initialFocus.current = initialFocusRef;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;

    const token = {};
    openDialogs.push(token);
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target = initialFocus.current?.current ?? getFocusable(dialog)[0] ?? dialog;
    target.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (openDialogs[openDialogs.length - 1] !== token) return;

      if (event.key === "Escape") {
        const { onClose: close, dismissible: canDismiss } = latest.current;
        if (canDismiss && close !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = getFocusable(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first || active === dialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const index = openDialogs.indexOf(token);
      if (index !== -1) openDialogs.splice(index, 1);
      if (previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        mouseDownOnOverlay.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const startedOnOverlay = mouseDownOnOverlay.current;
        mouseDownOnOverlay.current = false;
        if (
          closeOnOverlayClick &&
          dismissible &&
          startedOnOverlay &&
          event.target === event.currentTarget
        ) {
          onClose?.();
        }
      }}
    >
      <section
        ref={dialogRef}
        className={cx("dialog", className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}
