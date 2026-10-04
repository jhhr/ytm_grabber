// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_DELAY_MS,
  DOCK_BUTTON_CLASS,
  FALLBACK_DELAY_MS,
  FLOATING_ANCHOR_CLASS,
  FLOATING_BUTTON_CLASS,
  LYRICS_BUTTON_LABEL,
  mountLyricsButton,
  type LyricsButtonController,
} from "../src/content/lyricsButton";
import { addPlayerPage, buildControls, clearLyrics, mountDock, mountVoting, showLyrics, unmountDock } from "./helpers/blPage";

let controller: LyricsButtonController | undefined;
const onClick = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  controller?.dispose();
  controller = undefined;
  document.body.replaceChildren();
  onClick.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mount = (root?: Document | Element) => (controller = mountLyricsButton({ root, onClick }));
/** Lets the observer report and the coalesced check run. */
const settle = () => vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
const buttons = () => document.querySelectorAll(`.${DOCK_BUTTON_CLASS}`);
const floating = () => document.querySelector<HTMLButtonElement>(`.${FLOATING_BUTTON_CLASS}`);
const inner = () => document.querySelector<HTMLElement>(".blyrics-dock__inner")!;
/** The inner's children by role: "controls", "button", "voting". */
/** Counts the controller's checks: each one ends with takeRecords(). */
const countChecks = () => vi.spyOn(MutationObserver.prototype, "takeRecords");
const layout = () =>
  [...inner().children].map((child) => (child.classList.contains(DOCK_BUTTON_CLASS) ? "button" : child.className.replace("blyrics-dock__", "")));

describe("the dock button", () => {
  it("goes right after the dock's controls, as a labelled pg- button with an icon", () => {
    addPlayerPage();
    mountDock();
    mount();
    expect(layout()).toEqual(["controls", "button"]);
    const button = buttons()[0] as HTMLButtonElement;
    expect(button.className).toBe(DOCK_BUTTON_CLASS);
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe(LYRICS_BUTTON_LABEL);
    expect(button.title).toBe(LYRICS_BUTTON_LABEL);
    expect(button.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
    expect(button.querySelectorAll("svg path").length).toBeGreaterThan(0);
    // BL's own lookups never see it.
    expect(document.querySelector(".blyrics-dock__controls")!.contains(button)).toBe(false);
    expect(document.querySelectorAll("[class*='blyrics'] button:not([class*='blyrics'])")).toHaveLength(1);
  });

  it("appears once BL mounts its dock, also when the side panel comes later", async () => {
    mount();
    await settle();
    addPlayerPage();
    await settle();
    expect(buttons()).toHaveLength(0);
    mountDock();
    await settle();
    expect(layout()).toEqual(["controls", "button"]);
  });

  it("works under an element root", async () => {
    const { page } = addPlayerPage();
    mount(page);
    mountDock();
    await settle();
    expect(layout()).toEqual(["controls", "button"]);
  });

  it("keeps its place when BL replaces the controls on a song or source switch", async () => {
    addPlayerPage();
    mountDock();
    mount();
    const button = buttons()[0];
    for (let i = 0; i < 3; i++) {
      const old = document.querySelector(".blyrics-dock__controls")!;
      mountDock();
      // In place at once, before any check of ours runs.
      expect(old.isConnected).toBe(false);
      expect(layout()).toEqual(["controls", "button"]);
      await settle();
      expect(layout()).toEqual(["controls", "button"]);
      expect(buttons()[0]).toBe(button);
    }
  });

  it("stays right after controls that BL prepends later, and before BL's voting segment", async () => {
    addPlayerPage();
    mountDock({ controls: false });
    mount();
    expect(layout()).toEqual(["button"]);
    mountVoting();
    mountDock();
    expect(layout()).toEqual(["controls", "button", "voting"]);
    await settle();
    expect(layout()).toEqual(["controls", "button", "voting"]);
  });

  it("moves right after the controls when it ended up behind the voting segment", async () => {
    addPlayerPage();
    mountDock({ controls: false });
    mountVoting();
    mount();
    expect(layout()).toEqual(["voting", "button"]);
    mountDock();
    expect(layout()).toEqual(["controls", "voting", "button"]);
    await settle();
    expect(layout()).toEqual(["controls", "button", "voting"]);
  });

  it("is put back when removed", async () => {
    addPlayerPage();
    mountDock();
    mount();
    const button = buttons()[0];
    button.remove();
    await settle();
    expect(layout()).toEqual(["controls", "button"]);
    expect(buttons()[0]).toBe(button);
  });

  it("is moved out of the controls when it ends up inside them", async () => {
    addPlayerPage();
    mountDock();
    mount();
    const controls = document.querySelector(".blyrics-dock__controls")!;
    controls.append(buttons()[0]);
    await settle();
    expect(controls.querySelector(`.${DOCK_BUTTON_CLASS}`)).toBeNull();
    expect(layout()).toEqual(["controls", "button"]);
  });

  it("comes back when BL removes the whole dock and mounts it again", async () => {
    addPlayerPage();
    mountDock();
    mount();
    unmountDock();
    await settle();
    expect(buttons()).toHaveLength(0);
    mountDock({ position: "top-left" });
    await settle();
    expect(layout()).toEqual(["controls", "button"]);
  });

  it("follows a side panel that is replaced, or whose page is", async () => {
    const first = addPlayerPage();
    mountDock();
    mount();
    // The panel itself replaced.
    const panel = document.createElement("div");
    panel.id = "side-panel";
    first.sidePanel.replaceWith(panel);
    mountDock();
    await settle();
    expect(panel.querySelector(`.blyrics-dock__inner > .${DOCK_BUTTON_CLASS}`)).not.toBeNull();
    // Its whole page replaced: nothing in the old panel changes, only an ancestor's children.
    first.page.remove();
    addPlayerPage();
    mountDock();
    await settle();
    expect(buttons()).toHaveLength(1);
    expect(layout()).toEqual(["controls", "button"]);
  });

  it("stays exactly one button through many changes", async () => {
    addPlayerPage();
    mountDock();
    mount();
    const changes = [
      () => mountDock(),
      () => buttons()[0]?.remove(),
      () => document.querySelector(".blyrics-dock__controls")?.append(buttons()[0] ?? ""),
      () => unmountDock(),
      () => mountDock({ controls: false }),
      () => mountVoting(),
      () => inner()?.prepend(buildControls()),
      () => document.querySelector(".blyrics-dock__controls")?.remove(),
    ];
    for (let round = 0; round < 40; round++) {
      changes[(round * 7 + (round >> 2)) % changes.length]();
      if (round % 3 === 0) await settle();
    }
    mountDock();
    await settle();
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].previousElementSibling?.className).toBe("blyrics-dock__controls");
  });

  it("calls onClick with the button", () => {
    addPlayerPage();
    mountDock();
    mount();
    const button = buttons()[0] as HTMLButtonElement;
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toBe(button);
    expect(onClick.mock.calls[0][1]).toBeInstanceOf(MouseEvent);
  });
});

describe("what the observer costs", () => {
  it("observes child lists only, never attributes or text", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    mount();
    addPlayerPage();
    mountDock();
    await settle();
    expect(observe).toHaveBeenCalled();
    for (const [, options] of observe.mock.calls) {
      expect(options?.childList).toBe(true);
      expect(Object.keys(options ?? {}).filter((key) => key !== "childList" && key !== "subtree")).toEqual([]);
    }
  });

  it("checks at most once per CHECK_DELAY_MS under a steady stream of changes, and is not held off by it", async () => {
    addPlayerPage();
    mountDock();
    const lyrics = showLyrics();
    mount();
    const checks = countChecks();
    buttons()[0].remove();
    // BL rewriting its lyrics every 10 ms for one second.
    for (let i = 0; i < 100; i++) {
      lyrics.append(document.createElement("div"));
      await vi.advanceTimersByTimeAsync(10);
      if (i === 10) expect(layout()).toEqual(["controls", "button"]);
    }
    expect(checks.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(checks.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it("does not check for changes outside the side panel, or attribute changes in it", async () => {
    const { mainPanel } = addPlayerPage();
    mountDock();
    showLyrics();
    mount();
    await settle();
    const checks = countChecks();
    for (let i = 0; i < 20; i++) mainPanel.append(document.createElement("div"));
    const line = document.querySelector(".blyrics-container > div")!;
    line.setAttribute("data-state", "active");
    (line.firstChild as Text).data = "Another line";
    await vi.advanceTimersByTimeAsync(1000);
    expect(checks).not.toHaveBeenCalled();
  });
});

describe("the floating button", () => {
  it("appears 3 s after BL shows lyrics without a dock, at the top of the side panel", async () => {
    const { sidePanel } = addPlayerPage();
    mount();
    showLyrics();
    await settle();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS - CHECK_DELAY_MS - 1);
    expect(floating()).toBeNull();
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS + 1);
    const button = floating()!;
    expect(button).not.toBeNull();
    expect(button.parentElement!.className).toBe(FLOATING_ANCHOR_CLASS);
    expect(sidePanel.firstElementChild).toBe(button.parentElement);
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe(LYRICS_BUTTON_LABEL);
    expect(buttons()).toHaveLength(0);
    button.click();
    expect(onClick).toHaveBeenCalledWith(button, expect.any(MouseEvent));
  });

  it("goes away as soon as a dock appears, and the dock button takes over", async () => {
    addPlayerPage();
    showLyrics();
    mount();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS);
    expect(floating()).not.toBeNull();
    mountDock();
    await settle();
    expect(floating()).toBeNull();
    expect(document.querySelector(`.${FLOATING_ANCHOR_CLASS}`)).toBeNull();
    expect(layout()).toEqual(["controls", "button"]);
    // And back once the dock is gone again for 3 s.
    unmountDock();
    await settle();
    expect(floating()).toBeNull();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS);
    expect(floating()).not.toBeNull();
  });

  it("does not appear when the dock comes within the 3 s", async () => {
    addPlayerPage();
    showLyrics();
    mount();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS - 500);
    mountDock();
    await vi.advanceTimersByTimeAsync(10 * FALLBACK_DELAY_MS);
    expect(floating()).toBeNull();
    expect(layout()).toEqual(["controls", "button"]);
  });

  it("never appears without BL's lyrics", async () => {
    addPlayerPage();
    mount();
    await vi.advanceTimersByTimeAsync(10 * FALLBACK_DELAY_MS);
    expect(floating()).toBeNull();
    // Lyrics that go before the 3 s are up start the wait again when they come back.
    showLyrics();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS - 500);
    clearLyrics();
    await vi.advanceTimersByTimeAsync(10 * FALLBACK_DELAY_MS);
    expect(floating()).toBeNull();
    showLyrics();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS - 500);
    expect(floating()).toBeNull();
    await vi.advanceTimersByTimeAsync(500 + CHECK_DELAY_MS);
    expect(floating()).not.toBeNull();
    // Gone with the lyrics.
    clearLyrics();
    await settle();
    expect(floating()).toBeNull();
  });

  it("is put back when removed while it is due", async () => {
    addPlayerPage();
    showLyrics();
    mount();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS);
    document.querySelector(`.${FLOATING_ANCHOR_CLASS}`)!.remove();
    await settle();
    expect(document.querySelectorAll(`.${FLOATING_BUTTON_CLASS}`)).toHaveLength(1);
  });
});

describe("dispose", () => {
  it("removes the dock button and stops watching", async () => {
    addPlayerPage();
    mountDock();
    mount();
    const checks = countChecks();
    controller!.dispose();
    expect(buttons()).toHaveLength(0);
    unmountDock();
    mountDock();
    showLyrics();
    await vi.advanceTimersByTimeAsync(10 * FALLBACK_DELAY_MS);
    expect(buttons()).toHaveLength(0);
    expect(checks).not.toHaveBeenCalled();
  });

  it("removes the floating button and cancels a pending one", async () => {
    addPlayerPage();
    showLyrics();
    mount();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS);
    controller!.dispose();
    expect(floating()).toBeNull();

    mount();
    await vi.advanceTimersByTimeAsync(FALLBACK_DELAY_MS - 500);
    controller!.dispose();
    await vi.advanceTimersByTimeAsync(10 * FALLBACK_DELAY_MS);
    expect(floating()).toBeNull();
  });
});
