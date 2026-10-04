// @vitest-environment jsdom
// The confirm popover on its own: rendering, choosing, closing, keyboard and placement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentPopover, openConfirm, POPOVER_CLASS, POPOVER_GAP, POPOVER_MARGIN, POPOVER_TEXT_ID, type OpenPopover } from "../src/content/confirmPopover";

const WIDTH = 1024;
const HEIGHT = 768;

let anchor: HTMLButtonElement;
const onConfirm = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: WIDTH, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: HEIGHT, configurable: true });
  anchor = document.createElement("button");
  document.body.append(anchor);
});

afterEach(() => {
  currentPopover()?.close();
  document.body.replaceChildren();
  onConfirm.mockReset();
  onClose.mockReset();
  vi.restoreAllMocks();
});

const open = (at: HTMLElement = anchor): OpenPopover =>
  openConfirm({ anchor: at, text: "Sure?", label: "Question", confirmLabel: "Yes", dismissLabel: "No", onConfirm, onClose });
const buttonsOf = (popover: OpenPopover) => [...popover.element.querySelectorAll<HTMLButtonElement>("button")];
const key = (target: EventTarget, name: string, type = "keydown") => {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
const rect = (left: number, top: number, size = 40) => ({ left, top, right: left + size, bottom: top + size, width: size, height: size, x: left, y: top }) as DOMRect;

describe("rendering", () => {
  it("is a labelled alertdialog in <body>: the sentence, then the confirm and dismiss buttons; the dismiss button has focus", () => {
    const popover = open();
    expect(popover.element.parentElement).toBe(document.body);
    expect(popover.element.className).toContain(POPOVER_CLASS);
    expect(popover.element.getAttribute("role")).toBe("alertdialog");
    expect(popover.element.getAttribute("aria-label")).toBe("Question");
    expect(popover.element.getAttribute("aria-describedby")).toBe(POPOVER_TEXT_ID);
    expect(document.getElementById(POPOVER_TEXT_ID)!.textContent).toBe("Sure?");
    const [yes, no] = buttonsOf(popover);
    expect([yes.textContent, no.textContent]).toEqual(["Yes", "No"]);
    expect([yes.type, no.type]).toEqual(["button", "button"]);
    expect(document.activeElement).toBe(no);
    expect(currentPopover()).toBe(popover);
  });

  it("is the only one open", () => {
    const first = open();
    const other = document.createElement("button");
    document.body.append(other);
    const second = open(other);
    expect(first.element.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(`.${POPOVER_CLASS}`)).toHaveLength(1);
    expect(currentPopover()).toBe(second);
  });
});

describe("choosing and closing", () => {
  it("confirm closes it, gives focus back to the anchor and calls onConfirm after onClose", () => {
    const popover = open();
    const order: string[] = [];
    onClose.mockImplementation(() => order.push("close"));
    onConfirm.mockImplementation(() => order.push("confirm"));
    buttonsOf(popover)[0].click();
    expect(order).toEqual(["close", "confirm"]);
    expect(popover.element.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(currentPopover()).toBeNull();
  });

  it("dismiss, Esc and a click elsewhere close it without confirming", () => {
    let popover = open();
    buttonsOf(popover)[1].click();
    expect(popover.element.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);

    popover = open();
    const escape = key(document.activeElement!, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(popover.element.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);

    popover = open();
    document.body.click();
    expect(popover.element.isConnected).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("leaves a click on its anchor to the anchor's owner, and close() is idempotent", () => {
    const popover = open();
    anchor.click();
    expect(popover.element.isConnected).toBe(true);
    popover.close();
    popover.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("keyboard", () => {
  it("Tab and Shift+Tab move between the two buttons and stay in the popover", () => {
    const popover = open();
    const [yes, no] = buttonsOf(popover);
    expect(key(no, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(yes);
    no.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    no.dispatchEvent(event);
    expect(document.activeElement).toBe(yes);
    key(yes, "Tab");
    expect(document.activeElement).toBe(no);
  });

  it("keeps Space, Enter, Tab and Esc from YouTube Music's shortcuts", () => {
    const page = vi.fn();
    document.addEventListener("keydown", page);
    document.addEventListener("keyup", page);
    const popover = open();
    const [, no] = buttonsOf(popover);
    for (const name of [" ", "Enter", "Tab"]) key(no, name);
    key(no, " ", "keyup");
    expect(page).not.toHaveBeenCalled();
    // Other keys are not ours to stop.
    key(document.activeElement!, "a");
    expect(page).toHaveBeenCalledTimes(1);
    key(document.activeElement!, "Escape");
    expect(page).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", page);
    document.removeEventListener("keyup", page);
  });
});

describe("placement", () => {
  it("opens above an anchor at the bottom of the window, right edges lined up in the right half", () => {
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(900, 700));
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
    const popover = open();
    expect(popover.element.classList.contains(`${POPOVER_CLASS}--up`)).toBe(true);
    expect(popover.element.style.bottom).toBe(`${HEIGHT - 700 + POPOVER_GAP}px`);
    expect(popover.element.style.top).toBe("auto");
    expect(popover.element.style.left).toBe(`${940 - 300}px`);
  });

  it("opens below an anchor at the top, inside the viewport", () => {
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(2, 10));
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
    const popover = open();
    expect(popover.element.classList.contains(`${POPOVER_CLASS}--down`)).toBe(true);
    expect(popover.element.style.top).toBe(`${50 + POPOVER_GAP}px`);
    expect(popover.element.style.left).toBe(`${POPOVER_MARGIN}px`);
  });
});
