// @vitest-environment jsdom
// The lyrics menu popover: rendering the menu model, closing, keyboard and focus, placement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentMenu, MENU_CLASS, MENU_GAP, MENU_ID, MENU_LABEL, openMenu, VIEWPORT_MARGIN, type OpenMenu } from "../src/content/menu";
import { lyricsMenu, OTHER_SONG_NOTE_ID, type MenuItem } from "../src/shared/menuModel";
import { addPlayerPage, mountDock } from "./helpers/blPage";
import { fixtureSummary } from "./helpers/captureSummary";

const ID = "nKites0042x";
const SUMMARY = fixtureSummary(ID);
const DASH = "\u{2014}";
const WIDTH = 1024;
const HEIGHT = 768;

let anchor: HTMLButtonElement;
const onSelect = vi.fn<(item: MenuItem) => void>();

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: WIDTH, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: HEIGHT, configurable: true });
  addPlayerPage();
  anchor = button(mountDock());
});

afterEach(() => {
  currentMenu()?.close();
  document.body.replaceChildren();
  onSelect.mockReset();
  vi.restoreAllMocks();
});

function button(parent: Element): HTMLButtonElement {
  const element = document.createElement("button");
  element.className = "pg-dock-btn";
  parent.append(element);
  return element;
}

const items = (showingName: string | null = "Better Lyrics", forPlayingVideo = true) => lyricsMenu({ summary: SUMMARY, showingName, forPlayingVideo });
const open = (list: MenuItem[] = items(), at: HTMLElement = anchor) => openMenu({ anchor: at, items: list, onSelect });
const menuElement = () => document.querySelector<HTMLElement>(`.${MENU_CLASS}`);
const itemElements = (menu: OpenMenu) => [...menu.element.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const byLabel = (menu: OpenMenu, label: string) => itemElements(menu).find((element) => element.querySelector(".pg-menu__label")!.textContent === label)!;
const labelOf = (element: Element | null) => element?.querySelector(".pg-menu__label")?.textContent;
const key = (target: EventTarget, name: string) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
const rect = (left: number, top: number, size = 28) => ({ left, top, right: left + size, bottom: top + size, width: size, height: size, x: left, y: top }) as DOMRect;

describe("rendering", () => {
  it("shows the model's items in order, in <body>, as a labelled ARIA menu", () => {
    const list = items();
    const menu = open(list);
    expect(menu.element.parentElement).toBe(document.body);
    expect(menu.element.id).toBe(MENU_ID);
    expect(menu.element.getAttribute("role")).toBe("menu");
    expect(menu.element.getAttribute("aria-label")).toBe(MENU_LABEL);
    expect([...menu.element.children].map((element) => element.getAttribute("data-item-id"))).toEqual(list.map((item) => item.id));
    const roles = [...menu.element.children].map((element) => element.getAttribute("role"));
    expect(roles).toEqual(list.map((item) => ({ action: "menuitem", divider: "separator", header: "presentation" })[item.kind]));
    expect(labelOf(menu.element.firstElementChild)).toBe("Download TTML for Tony");
    expect(menu.element.querySelector(".pg-menu__header")!.textContent).toBe("Other sources");
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(anchor.getAttribute("aria-controls")).toBe(MENU_ID);
  });

  it("makes the Tony item bold, gives each action its detail line and marks the source BL shows", () => {
    const menu = open();
    const tony = itemElements(menu)[0];
    expect(tony.classList.contains("pg-menu__item--bold")).toBe(true);
    expect(tony.querySelector(".pg-menu__detail")!.textContent).toBe(`Better Lyrics ${DASH} word timing`);
    expect(itemElements(menu).filter((element) => element.classList.contains("pg-menu__item--bold"))).toHaveLength(1);
    const showing = itemElements(menu).filter((element) => element.classList.contains("pg-menu__item--showing"));
    expect(showing.map(labelOf)).toEqual([`Better Lyrics ${DASH} TTML, word-synced (showing)`]);
    expect(showing[0].querySelector(".pg-menu__detail")!.textContent).toBe(".golyrics.ttml");
    expect(byLabel(menu, "Raw response (.txt)").querySelector(".pg-menu__detail")!.textContent).toBe(".lyrics-stream.txt");
    // Re-capture has no detail line at all.
    expect(byLabel(menu, "Re-capture").querySelector(".pg-menu__detail")).toBeNull();
  });

  it("shows a disabled item's reason as its second line and tooltip; it takes no focus", () => {
    const list = items("YouTube");
    const reason = list.find((item) => item.label === "Download what's showing")!.reason!;
    expect(reason).toMatch(/YouTube/);
    const menu = open(list);
    const showing = byLabel(menu, "Download what's showing");
    expect(showing.getAttribute("aria-disabled")).toBe("true");
    expect(showing.title).toBe(reason);
    expect(showing.querySelector(".pg-menu__detail--reason")!.textContent).toBe(reason);
    expect(showing.hasAttribute("tabindex")).toBe(false);
    // Enabled ones are focusable by script only (roving focus), and not marked disabled.
    expect(itemElements(menu)[0].getAttribute("tabindex")).toBe("-1");
    expect(itemElements(menu)[0].hasAttribute("aria-disabled")).toBe(false);
  });

  it("shows the other-song note with the song it was captured for", () => {
    const menu = open(items("Better Lyrics", false));
    const note = itemElements(menu)[0];
    expect(note.getAttribute("data-item-id")).toBe(OTHER_SONG_NOTE_ID);
    expect(note.classList.contains("pg-menu__item--note")).toBe(true);
    expect(note.getAttribute("aria-disabled")).toBe("true");
    expect(labelOf(note)).toBe("Captured for another song");
    expect(note.querySelector(".pg-menu__detail")!.textContent).toBe("Marrow & Tin - Northbound Kites");
    expect(note.title).toBe("Captured for another song: Marrow & Tin - Northbound Kites");
    // The first enabled item gets focus, not the note.
    expect(labelOf(document.activeElement)).toBe("Download TTML for Tony");
  });
});

describe("choosing", () => {
  it("passes an enabled item to onSelect on a click anywhere in it, and stays open", () => {
    const menu = open();
    byLabel(menu, "Raw response (.txt)").querySelector<HTMLElement>(".pg-menu__detail")!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: "raw", label: "Raw response (.txt)" });
    expect(menuElement()).not.toBeNull();
  });

  it("ignores clicks on disabled items, dividers and the header", () => {
    const menu = open(items("YouTube"));
    byLabel(menu, "Download what's showing").click();
    menu.element.querySelector<HTMLElement>(".pg-menu__divider")!.click();
    menu.element.querySelector<HTMLElement>(".pg-menu__header")!.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(menuElement()).not.toBeNull();
  });

  it("ignores choices while busy", () => {
    const menu = open();
    menu.setBusy(true);
    expect(menu.element.getAttribute("aria-busy")).toBe("true");
    itemElements(menu)[0].click();
    key(itemElements(menu)[0], "Enter");
    expect(onSelect).not.toHaveBeenCalled();
    menu.setBusy(false);
    expect(menu.element.hasAttribute("aria-busy")).toBe(false);
    itemElements(menu)[0].click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("closing", () => {
  it("closes on Esc, returning focus to the button, and keeps the key from the page", () => {
    const pageKeys = vi.fn();
    document.addEventListener("keydown", pageKeys);
    open();
    expect(document.activeElement?.getAttribute("data-item-id")).toBe("tony");
    const event = key(document.activeElement!, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(pageKeys).not.toHaveBeenCalled();
    expect(menuElement()).toBeNull();
    expect(currentMenu()).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
    document.removeEventListener("keydown", pageKeys);
  });

  it("closes on Esc wherever focus is", () => {
    open();
    key(document.body, "Escape");
    expect(menuElement()).toBeNull();
  });

  it("closes on a click outside, but not on one inside or on its button", () => {
    const menu = open();
    menu.element.querySelector<HTMLElement>(".pg-menu__header")!.click();
    anchor.click();
    expect(menuElement()).not.toBeNull();
    document.querySelector<HTMLElement>("#main-panel")!.click();
    expect(menuElement()).toBeNull();
    // Focus was in the menu: it goes back to the button.
    expect(document.activeElement).toBe(anchor);
  });

  it("leaves focus where the user put it with an outside click", () => {
    const input = document.createElement("input");
    document.body.append(input);
    open();
    input.focus();
    input.click();
    expect(menuElement()).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("closes on Tab, focusing the button for the browser to move on from", () => {
    open();
    const event = key(document.activeElement!, "Tab");
    expect(event.defaultPrevented).toBe(false);
    expect(menuElement()).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it("stops listening once closed: a later Esc or click does not touch the button's focus", () => {
    const menu = open();
    menu.close();
    menu.close();
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    key(document.body, "Escape");
    other.click();
    expect(document.activeElement).toBe(other);
  });

  it("is the only menu: opening another closes the first", () => {
    const first = open();
    const second = open(items(), button(document.querySelector("#side-panel")!));
    expect(document.querySelectorAll(`.${MENU_CLASS}`)).toHaveLength(1);
    expect(first.element.isConnected).toBe(false);
    expect(currentMenu()).toBe(second);
  });
});

describe("keyboard", () => {
  it("moves between enabled items with Up/Down (wrapping), Home and End, skipping disabled ones", () => {
    const menu = open(items("YouTube"));
    const focused = () => labelOf(document.activeElement);
    const enabled = itemElements(menu).filter((element) => !element.hasAttribute("aria-disabled"));
    expect(focused()).toBe("Download TTML for Tony");
    key(document.activeElement!, "ArrowDown");
    // "Download what's showing" is disabled for YouTube lyrics.
    expect(document.activeElement).toBe(enabled[1]);
    expect(focused()).toBe(`LRCLib ${DASH} LRC, line-synced`);
    key(document.activeElement!, "ArrowUp");
    expect(focused()).toBe("Download TTML for Tony");
    key(document.activeElement!, "ArrowUp");
    expect(focused()).toBe("Re-capture");
    key(document.activeElement!, "ArrowDown");
    expect(focused()).toBe("Download TTML for Tony");
    key(document.activeElement!, "End");
    expect(focused()).toBe("Re-capture");
    key(document.activeElement!, "Home");
    expect(focused()).toBe("Download TTML for Tony");
  });

  it("chooses with Enter and Space, keeping handled keys from the page", () => {
    const pageKeys = vi.fn();
    document.addEventListener("keydown", pageKeys);
    open();
    key(document.activeElement!, "End");
    const enter = key(document.activeElement!, "Enter");
    key(document.activeElement!, "ArrowUp");
    const space = key(document.activeElement!, " ");
    expect(onSelect.mock.calls.map(([item]) => item.id)).toEqual(["recapture", "raw"]);
    expect([enter.defaultPrevented, space.defaultPrevented]).toEqual([true, true]);
    expect(pageKeys).not.toHaveBeenCalled();
    // Keys the menu does not handle go on to the page.
    key(document.activeElement!, "a");
    expect(pageKeys).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", pageKeys);
  });
});

describe("placement", () => {
  const placeAt = (at: HTMLElement, box: DOMRect, width = 0) => {
    vi.spyOn(at, "getBoundingClientRect").mockReturnValue(box);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
    return open(items(), at).element;
  };

  it("opens upwards from a bottom dock, its bottom edge just above the button", () => {
    const menu = placeAt(anchor, rect(900, 600));
    expect(menu.classList.contains("pg-menu--up")).toBe(true);
    expect(menu.style.bottom).toBe(`${HEIGHT - 600 + MENU_GAP}px`);
    expect(menu.style.top).toBe("auto");
    expect(menu.style.getPropertyValue("--pg-menu-room")).toBe(`${600 - MENU_GAP - VIEWPORT_MARGIN}px`);
  });

  it("opens downwards from a top dock", () => {
    document.querySelector<HTMLElement>(".blyrics-dock")!.dataset.position = "top-left";
    const menu = placeAt(anchor, rect(40, 64));
    expect(menu.classList.contains("pg-menu--down")).toBe(true);
    expect(menu.style.top).toBe(`${64 + 28 + MENU_GAP}px`);
    expect(menu.style.bottom).toBe("auto");
    expect(menu.style.getPropertyValue("--pg-menu-room")).toBe(`${HEIGHT - 92 - MENU_GAP - VIEWPORT_MARGIN}px`);
  });

  it("follows the dock even with more room on the other side", () => {
    document.querySelector<HTMLElement>(".blyrics-dock")!.dataset.position = "bottom-center";
    expect(placeAt(anchor, rect(500, 300)).classList.contains("pg-menu--up")).toBe(true);
  });

  it("opens to the other side when the dock's side has almost no room", () => {
    // A bottom dock 120 px from the top: about 100 px above, 600 below.
    expect(placeAt(anchor, rect(500, 120)).classList.contains("pg-menu--down")).toBe(true);
  });

  it("opens towards the larger room without a dock (the floating button)", () => {
    const floating = button(document.querySelector("#side-panel")!);
    expect(placeAt(floating, rect(900, 64)).classList.contains("pg-menu--down")).toBe(true);
    vi.restoreAllMocks();
    expect(placeAt(floating, rect(900, 700)).classList.contains("pg-menu--up")).toBe(true);
  });

  it("lines up right edges in the right half, left edges in the left, inside the viewport", () => {
    expect(placeAt(anchor, rect(900, 600), 300).style.left).toBe(`${928 - 300}px`);
    vi.restoreAllMocks();
    expect(placeAt(anchor, rect(1010, 600), 300).style.left).toBe(`${WIDTH - 300 - VIEWPORT_MARGIN}px`);
    vi.restoreAllMocks();
    expect(placeAt(anchor, rect(100, 600), 300).style.left).toBe("100px");
    vi.restoreAllMocks();
    expect(placeAt(anchor, rect(2, 600), 300).style.left).toBe(`${VIEWPORT_MARGIN}px`);
    // Wider than the window: the left margin wins (styles.css caps the width).
    vi.restoreAllMocks();
    expect(placeAt(anchor, rect(900, 600), 2000).style.left).toBe(`${VIEWPORT_MARGIN}px`);
  });

  it("stays inside the viewport for a button below it", () => {
    const menu = placeAt(anchor, rect(900, 900));
    expect(menu.classList.contains("pg-menu--up")).toBe(true);
    expect(menu.style.bottom).toBe(`${VIEWPORT_MARGIN}px`);
  });
});
