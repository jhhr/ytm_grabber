// Short messages for the user (PLAN.md 3.5): "Saved", a capture's error, BL's offset. One
// `div.pg-toast` at the bottom right of the page, above YouTube Music's player bar; a newer
// message replaces the one showing, and each hides by itself after TOAST_MS (or on a click).
// main.ts makes one toaster for the page and hands it to everything that talks to the user,
// so two parts of the extension never stack their messages or hide each other's.

export const TOAST_CLASS = "pg-toast";
export const TOAST_ERROR_CLASS = "pg-toast--error";
export const TOAST_MS = 6000;

export type ToastKind = "info" | "error";

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The page's timers, looked up on each call (so a test's fake timers apply). */
export const pageTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Toaster {
  /** Shows `text` (line breaks kept) in place of any message showing. */
  show(text: string, kind?: ToastKind): void;
  hide(): void;
}

export function createToaster({ doc = document, timers = pageTimers }: { doc?: Document; timers?: Timers } = {}): Toaster {
  let element: HTMLElement | null = null;
  let hideTimer: unknown;

  function hide(): void {
    timers.clearTimeout(hideTimer);
    hideTimer = undefined;
    if (element) element.hidden = true;
  }

  return {
    show(text, kind = "info") {
      if (!element) {
        element = doc.createElement("div");
        element.className = TOAST_CLASS;
        // Read out when its text changes, without interrupting.
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        element.addEventListener("click", hide);
      }
      // YouTube Music rebuilds parts of the page, never <body> itself; put it back if it went.
      if (!element.isConnected) doc.body.append(element);
      element.textContent = text;
      element.classList.toggle(TOAST_ERROR_CLASS, kind === "error");
      element.hidden = false;
      timers.clearTimeout(hideTimer);
      hideTimer = timers.setTimeout(hide, TOAST_MS);
    },
    hide,
  };
}
