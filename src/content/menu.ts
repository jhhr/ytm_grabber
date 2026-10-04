// The lyrics menu popover (PLAN.md 3.5): shows the menu model (shared/menuModel.ts) next to the
// lyrics button. Like BL's own dock menus it is appended to <body> and positioned `fixed` from the
// button's screen rectangle, since inside the dock it would be clipped. It opens upwards from a
// bottom dock and downwards from a top one (BL's rule), towards the larger free space when there
// is no dock (the floating button) or the dock's side has almost none; it is kept inside the
// viewport and scrolls when taller than the room it has.
//
// Keyboard (the WAI-ARIA menu pattern): opening focuses the first enabled item; Up/Down (wrapping),
// Home/End move between enabled items; Enter/Space choose; Esc and Tab close it, as does a click
// anywhere else. The keys handled here stop at the menu, so YouTube Music's own shortcuts (Space
// plays and pauses) do not fire as well. Disabled items stay in view with their reason; they take
// no focus and do nothing when clicked.
//
// Only one menu is open at a time; opening another closes it.

import { BL_DOCK_POSITION_ATTRIBUTE, BL_SELECTORS } from "../shared/blyrics";
import { OTHER_SONG_NOTE_ID, type MenuItem } from "../shared/menuModel";

export const MENU_CLASS = "pg-menu";
export const MENU_ID = "pg-lyrics-menu";
export const MENU_LABEL = "Lyrics downloads";
/** Between the button and the menu. */
export const MENU_GAP = 8;
/** Kept free between the menu and the viewport's edges. */
export const VIEWPORT_MARGIN = 8;
/** With less room than this on the dock's side, the menu opens on the other side if that has more. */
export const MIN_ROOM = 160;

export interface MenuOptions {
  anchor: HTMLElement;
  items: readonly MenuItem[];
  /** An enabled action was chosen. The menu stays open: the caller closes it when it is done. */
  onSelect(item: MenuItem): void;
  label?: string;
}

export interface OpenMenu {
  readonly anchor: HTMLElement;
  readonly element: HTMLElement;
  /** Closes the menu (idempotent); focus goes back to the anchor unless the user moved it elsewhere. */
  close(): void;
  /** While busy (a download is being saved) choosing an item does nothing. */
  setBusy(busy: boolean): void;
}

let current: OpenMenu | null = null;

/** The menu that is open, if any. */
export function currentMenu(): OpenMenu | null {
  return current;
}

export function openMenu({ anchor, items, onSelect, label = MENU_LABEL }: MenuOptions): OpenMenu {
  current?.close();
  const doc = anchor.ownerDocument;
  const menu = doc.createElement("div");
  menu.className = MENU_CLASS;
  menu.id = MENU_ID;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  // Focusable itself, so a click on a disabled item or a divider keeps focus in the menu.
  menu.tabIndex = -1;
  /** The enabled actions' elements, in order. */
  const actions = new Map<Element, MenuItem>();
  for (const item of items) {
    const element = renderItem(doc, item);
    if (item.kind === "action" && item.enabled) actions.set(element, item);
    menu.append(element);
  }
  const enabled = [...actions.keys()] as HTMLElement[];
  let busy = false;
  let closed = false;

  const choose = (element: Element | null | undefined) => {
    const item = element ? actions.get(element) : undefined;
    if (item && !busy && !closed) onSelect(item);
  };
  const focusAt = (index: number) => enabled[index]?.focus();

  const onKeyDown = (event: KeyboardEvent) => {
    const index = enabled.indexOf(doc.activeElement as HTMLElement);
    const last = enabled.length - 1;
    switch (event.key) {
      case "ArrowDown":
        focusAt(index < 0 || index === last ? 0 : index + 1);
        break;
      case "ArrowUp":
        focusAt(index <= 0 ? last : index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(last);
        break;
      case "Enter":
      case " ":
        choose(doc.activeElement);
        break;
      case "Tab":
        // Focus goes back to the button first, so the browser's Tab moves on from there.
        close(true);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const onMenuClick = (event: MouseEvent) => {
    choose((event.target as Element | null)?.closest?.('[role="menuitem"]'));
  };
  // Capture phase: seen even when the page stops the click on its way up, and never by the
  // click that opened the menu (it is past the document by the time the menu exists).
  const onDocumentClick = (event: MouseEvent) => {
    const target = event.target as Node | null;
    // The anchor's own click is the caller's (it closes the menu on a second click).
    if (target && (menu.contains(target) || anchor.contains(target))) return;
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
    // Focus that was in the menu (or fell to <body>) goes back to the button; focus the user
    // put somewhere else by clicking it stays there.
    const active = doc.activeElement;
    const restore = focusAnchor || active === null || active === doc.body || menu.contains(active);
    doc.removeEventListener("click", onDocumentClick, true);
    doc.removeEventListener("keydown", onDocumentKeyDown, true);
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (current === handle) current = null;
    if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  const handle: OpenMenu = {
    anchor,
    element: menu,
    close: () => close(),
    setBusy(value) {
      busy = value;
      menu.classList.toggle(`${MENU_CLASS}--busy`, value);
      if (value) menu.setAttribute("aria-busy", "true");
      else menu.removeAttribute("aria-busy");
    },
  };

  doc.body.append(menu);
  place(menu, anchor);
  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", MENU_ID);
  menu.addEventListener("keydown", onKeyDown);
  menu.addEventListener("click", onMenuClick);
  doc.addEventListener("click", onDocumentClick, true);
  doc.addEventListener("keydown", onDocumentKeyDown, true);
  current = handle;
  (enabled[0] ?? menu).focus({ preventScroll: true });
  return handle;
}

function renderItem(doc: Document, item: MenuItem): HTMLElement {
  const element = doc.createElement("div");
  element.dataset.itemId = item.id;
  switch (item.kind) {
    case "divider":
      element.className = `${MENU_CLASS}__divider`;
      element.setAttribute("role", "separator");
      return element;
    case "header":
      element.className = `${MENU_CLASS}__header`;
      element.setAttribute("role", "presentation");
      element.textContent = item.label;
      return element;
    case "action":
      break;
  }
  element.className = `${MENU_CLASS}__item`;
  element.setAttribute("role", "menuitem");
  const label = doc.createElement("span");
  label.className = `${MENU_CLASS}__label`;
  label.textContent = item.label;
  element.append(label);
  // The second line: what the file is; for a disabled item why it is disabled, except on the
  // other-song note, whose reason only repeats its label and song.
  const note = item.id === OTHER_SONG_NOTE_ID;
  const showReason = !item.enabled && !note && item.reason !== undefined;
  const secondary = showReason ? item.reason : item.detail;
  if (secondary !== undefined && secondary !== "") {
    const detail = doc.createElement("span");
    detail.className = `${MENU_CLASS}__detail`;
    if (showReason) detail.classList.add(`${MENU_CLASS}__detail--reason`);
    detail.textContent = secondary;
    element.append(detail);
  }
  if (item.bold) element.classList.add(`${MENU_CLASS}__item--bold`);
  if (item.showing) element.classList.add(`${MENU_CLASS}__item--showing`);
  if (note) element.classList.add(`${MENU_CLASS}__item--note`);
  if (item.enabled) {
    element.tabIndex = -1;
  } else {
    element.setAttribute("aria-disabled", "true");
    if (item.reason !== undefined) element.title = item.reason;
  }
  return element;
}

/** Puts the menu (already in the page, so it has a width) next to the anchor, inside the viewport. */
function place(menu: HTMLElement, anchor: HTMLElement): void {
  const view = anchor.ownerDocument.defaultView;
  if (!view) return;
  const rect = anchor.getBoundingClientRect();
  const width = view.innerWidth;
  const height = view.innerHeight;
  const roomAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
  const roomBelow = height - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const corner = anchor.closest(BL_SELECTORS.dock)?.getAttribute(BL_DOCK_POSITION_ATTRIBUTE) ?? "";
  let up: boolean;
  if (corner.startsWith("bottom")) up = roomAbove >= MIN_ROOM || roomAbove >= roomBelow;
  else if (corner.startsWith("top")) up = roomBelow < MIN_ROOM && roomAbove > roomBelow;
  else up = roomAbove > roomBelow;

  menu.classList.add(`${MENU_CLASS}--${up ? "up" : "down"}`);
  // styles.css caps the height at this (and at its own maximum); the rest scrolls.
  menu.style.setProperty("--pg-menu-room", `${Math.floor(Math.max(0, up ? roomAbove : roomBelow))}px`);
  if (up) {
    menu.style.top = "auto";
    menu.style.bottom = `${clamp(height - rect.top + MENU_GAP, VIEWPORT_MARGIN, height - VIEWPORT_MARGIN)}px`;
  } else {
    menu.style.bottom = "auto";
    menu.style.top = `${clamp(rect.bottom + MENU_GAP, VIEWPORT_MARGIN, height - VIEWPORT_MARGIN)}px`;
  }
  // Right edges lined up when the button is in the right half of the window (BL's dock usually
  // is), else left edges; then moved inside the viewport.
  const menuWidth = menu.offsetWidth;
  const left = rect.left + rect.width / 2 > width / 2 ? rect.right - menuWidth : rect.left;
  menu.style.left = `${clamp(left, VIEWPORT_MARGIN, width - menuWidth - VIEWPORT_MARGIN)}px`;
}

/** `value` within [min, max]; `min` wins when the range is empty (a menu wider than the window). */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
