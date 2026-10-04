// The lyrics button (PLAN.md 3.5): one `button.pg-dock-btn` in Better Lyrics' dock, right after
// its controls, kept there while BL rebuilds the dock; and a floating `button.pg-floating-btn` at
// the top right of `#side-panel` when BL shows lyrics but no dock (the dock can be turned off).
//
// BL's dock (PLAN.md 1.4, checked in 3.0.0.4): `.blyrics-dock > .blyrics-dock__inner` persists
// across songs; `__controls` in it is replaced with `replaceWith` on every song or source switch,
// or prepended when there is none, and a `__voting` segment may be appended. A sibling right after
// `__controls` keeps its place through all of that; we only act when the dock is removed and
// mounted again, or when something else moves our button.
//
// Cost: BL rewrites its lyrics often while a song plays, inside the subtree we watch. So the
// observer takes child-list changes only (no attributes, no text), a check is a few
// querySelector calls, and checks are coalesced: the first change arms one CHECK_DELAY_MS timer
// and the changes after it ride on that timer. That caps checks at 10 a second and, unlike a
// debounce that restarts on every change, a steady stream of changes cannot postpone them forever.
import { BL_SELECTORS } from "../shared/blyrics";

export const DOCK_BUTTON_CLASS = "pg-dock-btn";
export const FLOATING_BUTTON_CLASS = "pg-floating-btn";
/** A zero-height box prepended to `#side-panel` that the floating button is positioned in. */
export const FLOATING_ANCHOR_CLASS = "pg-floating-anchor";
export const CHECK_DELAY_MS = 100;
/** BL's lyrics must be up this long with no dock before the floating button shows. */
export const FALLBACK_DELAY_MS = 3000;
export const LYRICS_BUTTON_LABEL = "Download lyrics (YTM Practice Grabber)";

// Our button's place is after this, among the dock's direct children.
const DOCK_CONTROLS = `:scope > ${BL_SELECTORS.controls}`;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface LyricsButtonOptions {
  /** Where `#side-panel` is looked for: the document (default) or an element holding it. */
  root?: Document | Element;
  /** Called with the button that was clicked: the dock button or the floating one. */
  onClick: (button: HTMLButtonElement, event: MouseEvent) => void;
}

export interface LyricsButtonController {
  /** Removes both buttons and stops watching the page. */
  dispose(): void;
}

export function mountLyricsButton({ root = document, onClick }: LyricsButtonOptions): LyricsButtonController {
  const doc = root.ownerDocument ?? (root as Document);
  const dockButton = createButton(doc, DOCK_BUTTON_CLASS, onClick);
  /** The floating button's anchor, made when first needed. */
  let floating: HTMLElement | null = null;
  /** What the observer is set up for: the side panel and its parent then (null: none, so all of root). */
  let watched: { panel: Element | null; parent: Node | null } | undefined;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  /** Lyrics have been up without a dock for FALLBACK_DELAY_MS. */
  let fallbackDue = false;
  let disposed = false;

  const observer = new MutationObserver(() => {
    if (checkTimer === undefined && !disposed) checkTimer = setTimeout(check, CHECK_DELAY_MS);
  });

  function check(): void {
    clearTimeout(checkTimer);
    checkTimer = undefined;
    if (disposed) return;
    const panel = root.querySelector(BL_SELECTORS.sidePanel);
    watch(panel);
    const inner = panel?.querySelector(BL_SELECTORS.dockInner);
    if (inner) {
      stopFallback();
      placeDockButton(inner);
    } else {
      // Gone with the dock it was in, or somewhere it should not be.
      dockButton.remove();
      if (panel?.querySelector(BL_SELECTORS.lyricsContainer)) startFallback(panel);
      else stopFallback();
    }
    // Every change before this check has been seen, so the records left are our own changes:
    // dropping them saves a check that would find nothing to do.
    observer.takeRecords();
  }

  // Narrows the observer to the side panel once it exists; while it does not, all of root.
  function watch(panel: Element | null): void {
    const parent = panel?.parentNode ?? null;
    if (watched && watched.panel === panel && watched.parent === parent) return;
    observer.disconnect();
    watched = { panel, parent };
    if (!panel) {
      observer.observe(root, { childList: true, subtree: true });
      return;
    }
    observer.observe(panel, { childList: true, subtree: true });
    // The panel's own removal or replacement shows only in its ancestors' child lists, which change
    // rarely; then the next check widens to root again.
    for (let node: Node | null = parent; node; node = node.parentNode) {
      observer.observe(node, { childList: true });
      if (node === root) break;
    }
  }

  function placeDockButton(inner: Element): void {
    const controls = inner.querySelector(DOCK_CONTROLS);
    if (controls) {
      if (controls.nextElementSibling !== dockButton) controls.after(dockButton);
    } else if (dockButton.parentNode !== inner) {
      // BL prepends the controls when they come, which leaves us right after them.
      inner.append(dockButton);
    }
  }

  function startFallback(panel: Element): void {
    if (!fallbackDue) {
      fallbackTimer ??= setTimeout(() => {
        fallbackTimer = undefined;
        fallbackDue = true;
        check();
      }, FALLBACK_DELAY_MS);
      return;
    }
    floating ??= createFloating(doc, onClick);
    if (floating.parentNode !== panel) panel.prepend(floating);
  }

  function stopFallback(): void {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
    fallbackDue = false;
    floating?.remove();
  }

  check();
  return {
    dispose() {
      disposed = true;
      observer.disconnect();
      clearTimeout(checkTimer);
      checkTimer = undefined;
      stopFallback();
      dockButton.remove();
    },
  };
}

// Positioned in a zero-height box of its own at the top of the side panel (styles.css), so neither
// YTM's nor BL's elements get a style or class from us.
function createFloating(doc: Document, onClick: LyricsButtonOptions["onClick"]): HTMLElement {
  const anchor = doc.createElement("div");
  anchor.className = FLOATING_ANCHOR_CLASS;
  anchor.append(createButton(doc, FLOATING_BUTTON_CLASS, onClick));
  return anchor;
}

// Own class names only: BL's querySelector calls must never find our element (PLAN.md 3.5).
function createButton(doc: Document, className: string, onClick: LyricsButtonOptions["onClick"]): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", LYRICS_BUTTON_LABEL);
  // It opens the lyrics menu (menu.ts), which sets aria-expanded while open.
  button.setAttribute("aria-haspopup", "menu");
  button.title = LYRICS_BUTTON_LABEL;
  button.append(downloadIcon(doc));
  button.addEventListener("click", (event) => onClick(button, event));
  return button;
}

// Built node by node rather than from markup, so no HTML parsing (and no Trusted Types policy of
// the page's) is involved. Drawn like BL's dock icons: 17 px, 24-unit grid, 2-unit round strokes.
function downloadIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  const attributes: Record<string, string> = {
    width: "17",
    height: "17",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  // An arrow down onto a tray.
  for (const d of ["M12 4v11", "M7.5 10.5 12 15l4.5-4.5", "M5 19.5h14"]) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
