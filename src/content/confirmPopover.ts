// A small confirm popover (B10): one sentence and two buttons next to the button that asked, as
// the audio button's music-video warning ("Download anyway" / "Cancel") and its "Stop this audio
// download?". Like the lyrics menu (menu.ts) it is appended to <body>, positioned `fixed` from
// the anchor's screen rectangle and styled alike (styles.css, .pg-popover): towards the larger
// free space (above the player bar, in practice), kept inside the viewport.
//
// Keyboard (an ARIA alertdialog): opening focuses the dismiss button, the choice that changes
// nothing; Tab and Shift+Tab move between the two buttons; Enter and Space press them; Esc, the
// dismiss button or a click anywhere else closes it without choosing. The keys handled here stop
// at the popover, so YouTube Music's own shortcuts (Space plays and pauses) do not fire as well.
//
// Only one popover is open at a time; opening another closes it.

export const POPOVER_CLASS = "pg-popover";
export const POPOVER_TEXT_ID = "pg-popover-text";
/** Between the anchor and the popover. */
export const POPOVER_GAP = 8;
/** Kept free between the popover and the viewport's edges. */
export const POPOVER_MARGIN = 8;

export interface ConfirmOptions {
  anchor: HTMLElement;
  /** The sentence shown. */
  text: string;
  /** The popover's accessible name. */
  label: string;
  confirmLabel: string;
  dismissLabel: string;
  /** The confirm button was pressed (the popover has closed by then). */
  onConfirm(): void;
  /** Called once when the popover closes, whatever closed it; before onConfirm when that closed it. */
  onClose?(): void;
}

export interface OpenPopover {
  readonly anchor: HTMLElement;
  readonly element: HTMLElement;
  /** Closes it without choosing (idempotent); focus goes back to the anchor if it was in the popover. */
  close(): void;
}

let current: OpenPopover | null = null;

/** The popover that is open, if any. */
export function currentPopover(): OpenPopover | null {
  return current;
}

export function openConfirm({ anchor, text, label, confirmLabel, dismissLabel, onConfirm, onClose }: ConfirmOptions): OpenPopover {
  current?.close();
  const doc = anchor.ownerDocument;
  const popover = doc.createElement("div");
  popover.className = POPOVER_CLASS;
  popover.setAttribute("role", "alertdialog");
  popover.setAttribute("aria-label", label);
  popover.setAttribute("aria-describedby", POPOVER_TEXT_ID);
  const sentence = doc.createElement("p");
  sentence.className = `${POPOVER_CLASS}__text`;
  sentence.id = POPOVER_TEXT_ID;
  sentence.textContent = text;
  const confirm = createButton(doc, confirmLabel, `${POPOVER_CLASS}__btn ${POPOVER_CLASS}__btn--primary`);
  const dismiss = createButton(doc, dismissLabel, `${POPOVER_CLASS}__btn`);
  const actions = doc.createElement("div");
  actions.className = `${POPOVER_CLASS}__actions`;
  actions.append(confirm, dismiss);
  popover.append(sentence, actions);
  let closed = false;

  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "Tab":
        // Two buttons: Tab and Shift+Tab both go to the other one.
        (doc.activeElement === confirm ? dismiss : confirm).focus();
        event.preventDefault();
        break;
      case "Enter":
      case " ":
        // The focused button presses itself; only keep the key from YTM.
        break;
      default:
        return;
    }
    event.stopPropagation();
  };
  // Space presses a button on keyup: keep that from YTM too.
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") event.stopPropagation();
  };
  // Capture phase, as the lyrics menu: seen even when the page stops the click on its way up.
  const onDocumentClick = (event: MouseEvent) => {
    const target = event.target as Node | null;
    // The anchor's own click is the caller's (a second click on it closes the popover).
    if (target && (popover.contains(target) || anchor.contains(target))) return;
    close();
  };
  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  function close(focusAnchor = false): void {
    if (closed) return;
    closed = true;
    const active = doc.activeElement;
    const restore = focusAnchor || active === null || active === doc.body || popover.contains(active);
    doc.removeEventListener("click", onDocumentClick, true);
    doc.removeEventListener("keydown", onDocumentKeyDown, true);
    popover.remove();
    if (current === handle) current = null;
    if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
    onClose?.();
  }

  const handle: OpenPopover = { anchor, element: popover, close: () => close() };
  confirm.addEventListener("click", () => {
    if (closed) return;
    close(true);
    onConfirm();
  });
  dismiss.addEventListener("click", () => close(true));
  popover.addEventListener("keydown", onKeyDown);
  popover.addEventListener("keyup", onKeyUp);

  doc.body.append(popover);
  place(popover, anchor);
  doc.addEventListener("click", onDocumentClick, true);
  doc.addEventListener("keydown", onDocumentKeyDown, true);
  current = handle;
  dismiss.focus({ preventScroll: true });
  return handle;
}

function createButton(doc: Document, text: string, className: string): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  return button;
}

/** Puts the popover (already in the page, so it has a width) next to the anchor, inside the viewport. */
function place(popover: HTMLElement, anchor: HTMLElement): void {
  const view = anchor.ownerDocument.defaultView;
  if (!view) return;
  const rect = anchor.getBoundingClientRect();
  const width = view.innerWidth;
  const height = view.innerHeight;
  const up = rect.top >= height - rect.bottom;
  popover.classList.add(`${POPOVER_CLASS}--${up ? "up" : "down"}`);
  if (up) {
    popover.style.top = "auto";
    popover.style.bottom = `${clamp(height - rect.top + POPOVER_GAP, POPOVER_MARGIN, height - POPOVER_MARGIN)}px`;
  } else {
    popover.style.bottom = "auto";
    popover.style.top = `${clamp(rect.bottom + POPOVER_GAP, POPOVER_MARGIN, height - POPOVER_MARGIN)}px`;
  }
  // Right edges lined up when the anchor is in the right half of the window, else left edges.
  const popoverWidth = popover.offsetWidth;
  const left = rect.left + rect.width / 2 > width / 2 ? rect.right - popoverWidth : rect.left;
  popover.style.left = `${clamp(left, POPOVER_MARGIN, width - popoverWidth - POPOVER_MARGIN)}px`;
}

/** `value` within [min, max]; `min` wins when the range is empty. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
