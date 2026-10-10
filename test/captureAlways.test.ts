import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_TIMEOUT_MS } from "../src/background/capture";
import { UNISON_GRACE_MS } from "../src/background/networkWatcher";
import type { CaptureSummary } from "../src/shared/summary";
import { ID, OTHER, STREAM, TAB, UNISON, YTM_URL, serveStream, serveUnison, setup, start, tick } from "./helpers/captureHarness";
import type { FakePort } from "./helpers/fakePort";

const ELSEWHERE = "https://example.com/";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function summaryOf(port: FakePort): CaptureSummary {
  const last = port.posted.at(-1) as { type: string; summary: CaptureSummary };
  expect(last.type).toBe("done");
  return last.summary;
}

function reasonOf(port: FakePort): string {
  const last = port.posted.at(-1) as { type: string; reason: string };
  expect(last.type).toBe("error");
  return last.reason;
}

describe("always-attached capture", () => {
  it("attaches at start-up to every YouTube Music tab, and only those, with Network on", async () => {
    const { fake } = await setup({ mode: "always", tabs: { [TAB]: YTM_URL, 8: "https://music.youtube.com/library", 9: ELSEWHERE } });
    expect([...fake.attached].sort()).toEqual([TAB, 8]);
    expect([...fake.networkEnabled].sort()).toEqual([TAB, 8]);
    expect(fake.callsOf("detach")).toEqual([]);
  });

  it("stores every stream as it passes, without a start, and stays attached", async () => {
    const { fake, stored } = await setup({ mode: "always" });
    await serveUnison(fake);
    await serveStream(fake);
    expect(stored()).toMatchObject({ rawStream: STREAM, unisonRaw: UNISON, bodySource: "getResponseBody" });
    await serveStream(fake, { requestId: "1000.2", videoId: OTHER, bodyMode: "empty" });
    await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
    expect(stored(OTHER)).toMatchObject({ rawStream: STREAM, bodySource: "stream" });
    expect(fake.callsOf("detach")).toEqual([]);
    expect(fake.attached.has(TAB)).toBe(true);
  });

  it("answers a start with ready at once, then with the tab's next stream (a second start shares it)", async () => {
    const { fake, manager } = await setup({ mode: "always" });
    const attaches = fake.callsOf("attach").length;
    const port = await start(manager);
    const second = await start(manager);
    expect(port.types()).toEqual(["ready"]);
    expect(second.types()).toEqual(["ready"]);
    expect(fake.callsOf("attach")).toHaveLength(attaches);
    await serveStream(fake);
    await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
    expect(summaryOf(port).videoId).toBe(ID);
    expect(second.posted).toEqual(port.posted);
    // Later streams are stored, not sent.
    await serveStream(fake, { requestId: "1000.2", videoId: OTHER });
    await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
    expect(port.types()).toEqual(["ready", "done"]);
    expect(fake.callsOf("detach")).toEqual([]);
  });

  it("tells a waiting start when the next stream fails, or when none comes within 30 s", async () => {
    const { fake, manager } = await setup({ mode: "always" });
    const port = await start(manager);
    await serveStream(fake, { status: 500, chunks: ["{}"] });
    expect(reasonOf(port)).toBe("The lyrics server answered HTTP 500");

    const late = await start(manager);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1);
    expect(late.types()).toEqual(["ready"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reasonOf(late)).toBe("No lyrics stream from Better Lyrics within 30 s");
    expect(fake.attached.has(TAB)).toBe(true);
  });

  it("expects BL's retry after a later song's 403 even when an earlier 403 was never retried", async () => {
    const { fake, manager } = await setup({ mode: "always" });
    // BL could not get a new token that time: no retry came.
    await serveStream(fake, { requestId: "1.1", status: 403, chunks: ["{}"] });
    await vi.advanceTimersByTimeAsync(40_000);
    const port = await start(manager);
    await serveStream(fake, { requestId: "2.1", status: 403, chunks: ["{}"] });
    expect(port.types()).toEqual(["ready"]);
    await serveStream(fake, { requestId: "2.2" });
    await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
    expect(summaryOf(port).videoId).toBe(ID);
  });

  it("forgets a waiting start whose page went away, and still stores the stream", async () => {
    const { fake, manager, stored } = await setup({ mode: "always" });
    const port = await start(manager);
    port.remoteDisconnect();
    await serveStream(fake);
    await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
    expect(port.posted).toEqual([{ type: "ready" }]);
    expect(stored()).toBeDefined();
  });

  it("attaches a tab that was not attached yet when a start comes from it", async () => {
    const { fake, manager } = await setup({ mode: "always", tabs: {} });
    fake.tabs.set(8, YTM_URL);
    const port = await start(manager, { tabId: 8 });
    expect(port.types()).toEqual(["ready"]);
    expect(fake.attached.has(8)).toBe(true);
  });

  it("gives a start the reason when its tab cannot be attached", async () => {
    const { manager } = await setup({ mode: "always", before: (fake) => fake.attachedElsewhere.add(TAB) });
    const port = await start(manager);
    expect(reasonOf(port)).toBe("Another debugger is already attached to this tab. Close other debugging tools on it (or reload the tab) and try again.");
  });

  it("attaches when a YouTube Music tab finishes loading, and lets go when it leaves YouTube Music", async () => {
    const { fake, manager } = await setup({ mode: "always", tabs: {} });
    fake.tabs.set(8, YTM_URL);
    manager.handleTabUpdated(8, { status: "loading" }, { url: YTM_URL });
    await tick();
    expect(fake.attached.has(8)).toBe(false);
    manager.handleTabUpdated(8, { status: "complete" }, { url: YTM_URL });
    await tick();
    expect(fake.attached.has(8)).toBe(true);
    // Loading again (a single-page app) keeps the session it has.
    manager.handleTabUpdated(8, { status: "complete" }, { url: YTM_URL });
    await tick();
    expect(fake.callsOf("attach", 8)).toHaveLength(1);
    // Elsewhere, Chrome gives no URL (no host permission).
    fake.tabs.set(8, ELSEWHERE);
    manager.handleTabUpdated(8, { status: "complete" }, {});
    await tick();
    expect(fake.attached.has(8)).toBe(false);
    expect(fake.callsOf("detach", 8)).toHaveLength(1);
  });

  it("does nothing when a tab finishes loading in on-demand mode", async () => {
    const { fake, manager } = await setup();
    manager.handleTabUpdated(TAB, { status: "complete" }, { url: YTM_URL });
    await tick();
    expect(fake.callsOf("attach")).toEqual([]);
  });

  it("tells a waiting start when Chrome detaches the tab, and attaches again on the next load", async () => {
    const { fake, manager } = await setup({ mode: "always" });
    const port = await start(manager);
    fake.browserDetach(TAB, "canceled_by_user");
    await tick();
    expect(reasonOf(port)).toBe("Debugging was cancelled (Cancel on Chrome's debugging bar)");
    expect(fake.callsOf("detach")).toEqual([]);
    manager.handleTabUpdated(TAB, { status: "complete" }, { url: YTM_URL });
    await tick();
    expect(fake.attached.has(TAB)).toBe(true);
  });

  it("takes over the session an earlier service worker left, instead of attaching again", async () => {
    const { fake, stored } = await setup({
      mode: "always",
      before: (fake) => {
        fake.attached.add(TAB);
        fake.networkEnabled.add(TAB);
      },
    });
    expect(fake.callsOf("detach")).toEqual([]);
    expect(fake.calls).toEqual([
      { kind: "getTargets" },
      { kind: "attach", tabId: TAB, version: "1.3" },
      { kind: "command", tabId: TAB, method: "Network.enable", params: { maxResourceBufferSize: 10_485_760, maxTotalBufferSize: 52_428_800 } },
    ]);
    await serveStream(fake);
    await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
    expect(stored()?.rawStream).toBe(STREAM);
  });

  describe("switching modes", () => {
    it("to on-demand detaches every tab and tells waiting starts; then captures attach per start", async () => {
      const { fake, manager, settingsArea } = await setup({ mode: "always", tabs: { [TAB]: YTM_URL, 8: YTM_URL } });
      const port = await start(manager);
      await settingsArea.set({ captureMode: "on-demand" });
      await tick();
      expect(fake.attached.size).toBe(0);
      expect(fake.callsOf("detach").map((call) => ("tabId" in call ? call.tabId : -1)).sort()).toEqual([TAB, 8]);
      expect(reasonOf(port)).toBe("The capture mode was changed; try again");

      const next = await start(manager);
      expect(next.types()).toEqual(["ready"]);
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(next).videoId).toBe(ID);
      expect(fake.attached.size).toBe(0);
    });

    it("to always attaches the YouTube Music tabs", async () => {
      const { fake, settingsArea } = await setup({ tabs: { [TAB]: YTM_URL, 9: ELSEWHERE } });
      expect(fake.attached.size).toBe(0);
      await settingsArea.set({ captureMode: "always" });
      await tick();
      expect([...fake.attached]).toEqual([TAB]);
    });

    it("to always during an on-demand capture lets the capture finish, then attaches for good", async () => {
      const { fake, manager, settingsArea, stored } = await setup();
      const port = await start(manager);
      await settingsArea.set({ captureMode: "always" });
      await tick();
      expect(fake.callsOf("attach")).toHaveLength(1);
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(port).videoId).toBe(ID);
      expect(stored()).toBeDefined();
      expect(fake.callsOf("detach")).toHaveLength(1);
      expect(fake.callsOf("attach")).toHaveLength(2);
      expect(fake.attached.has(TAB)).toBe(true);
    });

    it("turns the debug log on and off", async () => {
      const { fake, settingsArea } = await setup({ mode: "always" });
      await settingsArea.set({ debugCapture: true });
      await tick();
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      const lines = vi.mocked(console.log).mock.calls.length;
      expect(lines).toBeGreaterThan(0);
      await settingsArea.set({ debugCapture: false });
      await tick();
      await serveStream(fake, { requestId: "1000.2" });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(vi.mocked(console.log).mock.calls.length).toBe(lines);
    });
  });
});
