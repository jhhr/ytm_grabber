import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_TIMEOUT_MS, NETWORK_ENABLE_PARAMS } from "../src/background/capture";
import { UNISON_GRACE_MS } from "../src/background/networkWatcher";
import { UNISON_URL } from "../src/shared/blRequests";
import { parseSse } from "../src/shared/sse";
import type { CaptureSummary } from "../src/shared/summary";
import { ID, OTHER, STREAM, TAB, UNISON, YTM_URL, openPort, serveStream, serveUnison, setup, start, tick } from "./helpers/captureHarness";
import { blStreamRequest, FAKE_KEY_ID, FAKE_TOKEN, type FakeDebugger } from "./helpers/fakeDebugger";
import type { FakePort } from "./helpers/fakePort";
import type { FakeStorageArea } from "./helpers/fakeStorage";

/** The stream as EventSource messages; JSON spread over several lines, as a multi-line `data:` field arrives. */
const MESSAGES = parseSse(STREAM).map(({ event, data }) => ({ eventName: event, data: JSON.stringify(data, null, 1) }));

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

/** Detached exactly once from TAB, and nothing is attached any more. */
function expectDetached(fake: FakeDebugger): void {
  expect(fake.callsOf("detach")).toEqual([{ kind: "detach", tabId: TAB }]);
  expect(fake.attached.size).toBe(0);
}

describe("on-demand capture", () => {
  it("attaches, turns Network on, posts ready; then stores the stream and Unison, detaches and posts done", async () => {
    const { fake, manager, stored } = await setup();
    const port = await start(manager);
    expect(fake.calls).toEqual([
      { kind: "getTargets" },
      { kind: "attach", tabId: TAB, version: "1.3" },
      { kind: "command", tabId: TAB, method: "Network.enable", params: { maxResourceBufferSize: 10_485_760, maxTotalBufferSize: 52_428_800 } },
    ]);
    expect(NETWORK_ENABLE_PARAMS).toEqual({ maxResourceBufferSize: 10_485_760, maxTotalBufferSize: 52_428_800 });
    expect(port.types()).toEqual(["ready"]);

    await serveUnison(fake);
    await serveStream(fake);
    // Unison had already finished: no grace needed.
    expect(port.types()).toEqual(["ready", "done"]);
    const summary = summaryOf(port);
    expect(summary).toMatchObject({ videoId: ID, bodySource: "getResponseBody", metadata: { song: "Northbound Kites", artist: "Marrow & Tin" } });
    expect(summary.sources.map((source) => source.id)).toContain("unison");
    expect(summary.tonyPick?.sourceId).toBe("golyrics");
    expect(stored()).toMatchObject({ videoId: ID, rawStream: STREAM, unisonRaw: UNISON, bodySource: "getResponseBody" });
    expectDetached(fake);
  });

  describe("Unison and the grace period", () => {
    it("finishes without Unison when none appears within the grace", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS - 1);
      expect(port.types()).toEqual(["ready"]);
      expect(fake.callsOf("detach")).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(summaryOf(port).sources.map((source) => source.id)).not.toContain("unison");
      expect(stored()).toBeDefined();
      expect(stored()).not.toHaveProperty("unisonRaw");
      expectDetached(fake);
    });

    it("waits for a Unison request that appears during the grace, up to the grace from then", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS - 500);
      const unison = await serveUnison(fake, { finish: false });
      // Past the first grace, but the request appeared 1.5 s in and gets its own grace to finish.
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS - 1);
      expect(port.types()).toEqual(["ready"]);
      unison.finish();
      await tick();
      expect(port.types()).toEqual(["ready", "done"]);
      expect(stored()?.unisonRaw).toBe(UNISON);
    });

    it("gives a Unison request still running when the stream ends the grace to finish, then goes on without it", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      const unison = await serveUnison(fake, { finish: false });
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS - 1);
      expect(port.types()).toEqual(["ready"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(port.types()).toEqual(["ready", "done"]);
      expect(stored()).not.toHaveProperty("unisonRaw");
      // Too late, and no longer seen: the debugger is gone.
      unison.finish();
      await tick();
      expect(port.types()).toEqual(["ready", "done"]);
      expectDetached(fake);
    });

    it("takes a Unison 404 as no Unison lyrics, not an error, and finishes at once", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveStream(fake);
      await serveUnison(fake, { status: 404 });
      expect(port.types()).toEqual(["ready", "done"]);
      expect(stored()).not.toHaveProperty("unisonRaw");
      expect(fake.commands("Network.getResponseBody").map((params) => params.requestId)).toEqual(["1000.1"]);

      const again = await start(manager);
      await serveUnison(fake, { requestId: "2000.2", status: 404 });
      await serveStream(fake, { requestId: "1000.2" });
      expect(again.types()).toEqual(["ready", "done"]);
    });

    it("does not pair Unison for another video with the stream", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveUnison(fake, { videoId: OTHER });
      await serveStream(fake);
      expect(port.types()).toEqual(["ready"]);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(port.types()).toEqual(["ready", "done"]);
      expect(stored()).not.toHaveProperty("unisonRaw");
    });
  });

  describe("body paths", () => {
    it("uses Network.getResponseBody, decoding a base64 body as UTF-8", async () => {
      expect(/[^\x00-\x7f]/.test(STREAM)).toBe(true);
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveStream(fake, { bodyMode: "base64" });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(port).bodySource).toBe("getResponseBody");
      expect(stored()?.rawStream).toBe(STREAM);
    });

    it("uses the streamed bytes when getResponseBody is empty: bufferedData first, then each dataReceived", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      const request = blStreamRequest(fake, TAB, "1000.1", { videoId: ID });
      request.bodyMode = "empty";
      request.respond(200);
      // Arrives before Chrome has turned streaming on: it comes back as bufferedData.
      request.data(STREAM.slice(0, 300));
      expect(request.streaming).toBe(false);
      await tick();
      expect(request.streaming).toBe(true);
      expect(fake.commands("Network.streamResourceContent")).toEqual([{ requestId: "1000.1" }]);
      request.data(STREAM.slice(300, 2000)).data(STREAM.slice(2000)).finish();
      await tick();
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(port).bodySource).toBe("stream");
      expect(stored()).toMatchObject({ rawStream: STREAM, bodySource: "stream" });
    });

    it("decodes the streamed bytes once, so a character split across two dataReceived chunks survives", async () => {
      const bytes = new TextEncoder().encode(STREAM);
      const cut = bytes.findIndex((byte) => byte >= 0x80) + 1;
      expect(cut).toBeGreaterThan(0);
      expect(bytes[cut] & 0xc0).toBe(0x80); // the cut is inside the character
      const { fake, manager, stored } = await setup();
      await start(manager);
      await serveStream(fake, { bodyMode: "error", chunks: [bytes.slice(0, cut), bytes.slice(cut)] });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(stored()).toMatchObject({ rawStream: STREAM, bodySource: "stream" });
    });

    it("rebuilds the stream from EventSource messages when the other two have nothing", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveStream(fake, { bodyMode: "error", streamable: false, eventSource: MESSAGES });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      const summary = summaryOf(port);
      expect(summary.bodySource).toBe("eventSource");
      expect(parseSse(stored()!.rawStream)).toEqual(parseSse(STREAM));
      expect(summary.tonyPick?.sourceId).toBe("golyrics");
    });

    it("fails when no path has the body, and still detaches", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveStream(fake, { bodyMode: "error", streamable: false });
      expect(reasonOf(port)).toBe("Could not read the lyrics response");
      expect(stored()).toBeUndefined();
      expectDetached(fake);
    });

    it("logs the path used, with sizes and times, only when debugCapture is on", async () => {
      const log = vi.mocked(console.log);
      const quiet = await setup();
      await start(quiet.manager);
      await serveStream(quiet.fake, { bodyMode: "empty" });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(log).not.toHaveBeenCalled();

      const loud = await setup({ debug: true });
      await start(loud.manager);
      await serveStream(loud.fake, { bodyMode: "empty" });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => /stream 1000\.1 finished after \d+ ms: getResponseBody 0 B, stream \d+ B, eventSource 0 messages; using stream/.test(line))).toBe(true);
      expect(lines.some((line) => line.includes("stored a capture") && line.includes("body from stream"))).toBe(true);
      expect(lines.every((line) => line.startsWith("[YTM Practice Grabber] capture: "))).toBe(true);
    });
  });

  describe("which video", () => {
    it("stores a stream for another video under that video's id and says so in done", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager, { videoId: ID });
      await serveStream(fake, { videoId: OTHER });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(port).videoId).toBe(OTHER);
      expect(stored(OTHER)?.rawStream).toBe(STREAM);
      expect(stored(ID)).toBeUndefined();
    });

    it("reads the video id from postDataEntries when the event has no postData", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      await serveStream(fake, { videoId: OTHER, entriesOnly: true });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(port).videoId).toBe(OTHER);
    });

    it("falls back to the stream's metadata, then to the video asked for", async () => {
      const withId = STREAM.replace('data: {"song":"Northbound Kites"', `data: {"videoId":"${OTHER}","song":"Northbound Kites"`);
      expect(withId).not.toBe(STREAM);
      const { fake, manager } = await setup();
      const first = await start(manager);
      await serveStream(fake, { noBody: true, chunks: [withId] });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(first).videoId).toBe(OTHER);

      const second = await start(manager, { videoId: ID });
      await serveStream(fake, { requestId: "1000.2", noBody: true });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(second).videoId).toBe(ID);
    });
  });

  it("ignores verify-turnstile, Unison votes and preflights, and every other request", async () => {
    const { fake, manager } = await setup();
    const port = await start(manager);
    const others = [
      fake.request(TAB, "500.1", { url: "https://lyrics.api.dacubeking.com/verify-turnstile", method: "POST", postData: `token=${FAKE_TOKEN}` }),
      fake.request(TAB, "500.2", { url: `${UNISON_URL}/31337/vote`, method: "POST", headers: { "x-key-id": FAKE_KEY_ID }, postData: '{"vote":1}' }),
      fake.request(TAB, "500.3", { url: `${UNISON_URL}?v=${ID}&song=x`, method: "OPTIONS" }),
      fake.request(TAB, "500.4", { url: "https://music.youtube.com/youtubei/v1/next", method: "POST", postData: "{}" }),
    ];
    for (const request of others) request.respond(200, "application/json");
    await tick();
    for (const request of others) request.data('{"ok":true}').finish();
    await tick();
    expect(port.types()).toEqual(["ready"]);
    await serveStream(fake);
    // Had the vote or the preflight counted as Unison, the capture would be done now.
    await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS - 1);
    expect(port.types()).toEqual(["ready"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(port.types()).toEqual(["ready", "done"]);
    const asked = [...fake.commands("Network.streamResourceContent"), ...fake.commands("Network.getResponseBody")].map((params) => params.requestId);
    expect(asked).toEqual(["1000.1", "1000.1"]);
  });

  describe("failed stream requests", () => {
    it("waits for BL's retry after a 403 (it fetches a new token) and takes that stream", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveStream(fake, { requestId: "1000.1", status: 403, chunks: ['{"error":"Forbidden"}'] });
      expect(port.types()).toEqual(["ready"]);
      const turnstile = fake.request(TAB, "1000.2", { url: "https://lyrics.api.dacubeking.com/verify-turnstile", method: "POST", postData: "token=t" });
      turnstile.respond(200, "application/json");
      await tick();
      turnstile.data('{"jwt":"x"}').finish();
      await tick();
      await serveStream(fake, { requestId: "1000.3", token: "second-token" });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(port).videoId).toBe(ID);
      expect(stored()?.rawStream).toBe(STREAM);
      expect(fake.commands("Network.getResponseBody").map((params) => params.requestId)).toEqual(["1000.3"]);
    });

    it("fails when the retry is refused too", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      await serveStream(fake, { requestId: "1000.1", status: 403, chunks: ["{}"] });
      await serveStream(fake, { requestId: "1000.2", status: 403, chunks: ["{}"] });
      expect(reasonOf(port)).toBe("The lyrics server refused the request (HTTP 403)");
      expectDetached(fake);
    });

    it("fails at once on any other error status (BL does not retry those)", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      await serveStream(fake, { status: 500, chunks: ['{"error":"oops"}'] });
      expect(reasonOf(port)).toBe("The lyrics server answered HTTP 500");
      expectDetached(fake);
    });

    it("fails when the request fails, naming Chrome's network error but nothing else it says", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      const request = blStreamRequest(fake, TAB, "1000.1", { videoId: ID });
      request.respond(200);
      await tick();
      request.data(STREAM.slice(0, 500)).fail("net::ERR_CONNECTION_RESET");
      await tick();
      expect(reasonOf(port)).toBe("The lyrics request failed (net::ERR_CONNECTION_RESET)");
      expectDetached(fake);

      const again = await start(manager);
      const odd = blStreamRequest(fake, TAB, "1000.2", { videoId: ID });
      odd.respond(200);
      await tick();
      odd.fail("something <odd> happened");
      await tick();
      expect(reasonOf(again)).toBe("The lyrics request failed");
    });

    it("says when the request was cancelled", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      const request = blStreamRequest(fake, TAB, "1000.1", { videoId: ID });
      request.respond(200);
      await tick();
      request.data(STREAM.slice(0, 500)).fail("net::ERR_ABORTED", true);
      await tick();
      expect(reasonOf(port)).toBe("The lyrics request was cancelled before it finished");
    });

    it("keeps a stream cancelled after its done event (a server that keeps the connection open)", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      const request = blStreamRequest(fake, TAB, "1000.1", { videoId: ID });
      request.respond(200);
      await tick();
      request.data(STREAM).fail("net::ERR_ABORTED", true);
      await tick();
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(port).bodySource).toBe("stream");
      expect(stored()?.rawStream).toBe(STREAM);
    });
  });

  describe("timeout", () => {
    it("gives up after 30 s when Better Lyrics makes no request, and detaches", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1);
      expect(port.types()).toEqual(["ready"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(reasonOf(port)).toBe("Better Lyrics made no lyrics request within 30 s");
      expectDetached(fake);
    });

    it("gives up after 30 s when the response does not finish", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      const request = blStreamRequest(fake, TAB, "1000.1", { videoId: ID });
      request.respond(200);
      await tick();
      request.data(STREAM.slice(0, 100));
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
      expect(reasonOf(port)).toBe("The lyrics response did not finish within 30 s");
      expectDetached(fake);
    });

    it("keeps a stream in hand when the 30 s run out while Unison is still running", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveUnison(fake, { finish: false });
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1000);
      await serveStream(fake);
      expect(port.types()).toEqual(["ready"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(summaryOf(port).videoId).toBe(ID);
      expect(stored()).not.toHaveProperty("unisonRaw");
      expectDetached(fake);
    });
  });

  describe("debugger lifecycle", () => {
    it("ends with a clear error when the user cancels debugging, without a detach call", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      fake.browserDetach(TAB, "canceled_by_user");
      await tick();
      expect(reasonOf(port)).toBe("Debugging was cancelled (Cancel on Chrome's debugging bar)");
      expect(fake.callsOf("detach")).toEqual([]);
      // The tab is free: the next start attaches again.
      const again = await start(manager);
      expect(again.types()).toEqual(["ready"]);
      expect(fake.callsOf("attach")).toHaveLength(2);
    });

    it("ends when the tab closes", async () => {
      const { fake, manager } = await setup();
      const port = await start(manager);
      fake.browserDetach(TAB, "target_closed");
      await tick();
      expect(reasonOf(port)).toBe("The tab was closed or navigated away");
      expect(fake.callsOf("detach")).toEqual([]);
    });

    it("keeps a stream already in hand when Chrome detaches during the grace", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      await serveStream(fake);
      fake.browserDetach(TAB, "canceled_by_user");
      await tick();
      expect(summaryOf(port).videoId).toBe(ID);
      expect(stored()?.rawStream).toBe(STREAM);
    });

    it("explains an attach refused because another debugger is attached", async () => {
      const { fake, manager } = await setup({ before: (fake) => fake.attachedElsewhere.add(TAB) });
      // (Start-up already tried, harmlessly, to detach what getTargets showed as attached.)
      const startUp = fake.calls.length;
      const port = await start(manager);
      expect(port.types()).toEqual(["error"]);
      expect(reasonOf(port)).toBe("Another debugger is already attached to this tab. Close other debugging tools on it (or reload the tab) and try again.");
      // Attach refused, then the check whether the session is this extension's own: also refused.
      expect(fake.calls.slice(startUp)).toEqual([
        { kind: "attach", tabId: TAB, version: "1.3" },
        { kind: "command", tabId: TAB, method: "Network.enable", params: NETWORK_ENABLE_PARAMS },
      ]);
      expect(fake.attachedElsewhere.has(TAB)).toBe(true);
    });

    it("passes on Chrome's reason for any other attach failure", async () => {
      const { fake, manager } = await setup();
      fake.beforeAttach = () => {
        throw new Error("Cannot attach to this target.");
      };
      const port = await start(manager);
      expect(reasonOf(port)).toBe("Could not attach the debugger to this tab: Cannot attach to this target.");
    });

    it("detaches when Network.enable fails after the attach", async () => {
      const { fake, manager } = await setup();
      fake.beforeCommand = (_tabId, method) => {
        if (method === "Network.enable") throw new Error("Internal error");
      };
      const port = await start(manager);
      expect(port.types()).toEqual(["error"]);
      expect(reasonOf(port)).toBe("Could not start watching the tab's network requests");
      expectDetached(fake);
    });

    it("detaches, at start-up, a session an earlier service worker left on a tab", async () => {
      const { fake, manager } = await setup({
        before: (fake) => {
          fake.attached.add(TAB);
          fake.networkEnabled.add(TAB);
        },
      });
      expectDetached(fake);
      const port = await start(manager);
      expect(port.types()).toEqual(["ready"]);
    });

    type Ending = (h: { fake: FakeDebugger; port: FakePort; area: FakeStorageArea }) => Promise<unknown>;
    it.each<[string, Ending]>([
      ["a capture", async ({ fake }) => serveStream(fake).then(() => vi.advanceTimersByTimeAsync(UNISON_GRACE_MS))],
      ["an error status", async ({ fake }) => serveStream(fake, { status: 502, chunks: ["{}"] })],
      ["a failed request", async ({ fake }) => blStreamRequest(fake, TAB, "9.1", { videoId: ID }).fail("net::ERR_FAILED") && tick()],
      ["a timeout", async () => vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS)],
      ["the page going away", async ({ port }) => (port.remoteDisconnect(), tick())],
      [
        "a storage failure",
        async ({ fake, area }) => {
          area.beforeSet = () => {
            throw new Error("Storage broke");
          };
          await serveStream(fake);
          await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
        },
      ],
    ])("detaches after %s", async (_name, end) => {
      const { fake, manager, area } = await setup();
      const port = await start(manager);
      await end({ fake, port, area });
      await tick();
      expectDetached(fake);
      expect(port.posted.length).toBeLessThanOrEqual(2);
    });

    it("reports a storage failure as the capture's error", async () => {
      const { fake, manager, area } = await setup();
      const port = await start(manager);
      area.beforeSet = () => {
        throw new Error("Storage broke");
      };
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(reasonOf(port)).toBe("Storage broke");
    });
  });

  describe("one capture per tab", () => {
    it("lets a second start join: ready at once, then the same done", async () => {
      const { fake, manager } = await setup();
      const first = await start(manager);
      const second = await start(manager);
      expect(second.types()).toEqual(["ready"]);
      expect(fake.callsOf("attach")).toHaveLength(1);
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(first.types()).toEqual(["ready", "done"]);
      expect(second.posted).toEqual(first.posted);
      expectDetached(fake);
    });

    it("gives starts that arrive together one attach, and each its ready", async () => {
      const { fake, manager } = await setup();
      const first = openPort(manager);
      const second = openPort(manager);
      first.deliver({ type: "start", videoId: ID });
      second.deliver({ type: "start", videoId: ID });
      await tick();
      expect(first.types()).toEqual(["ready"]);
      expect(second.types()).toEqual(["ready"]);
      expect(fake.callsOf("attach")).toHaveLength(1);
    });

    it("stops and detaches when the page that asked goes away", async () => {
      const { fake, manager, stored } = await setup();
      const port = await start(manager);
      port.remoteDisconnect();
      await tick();
      expectDetached(fake);
      // BL's request now goes unseen.
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
      expect(stored()).toBeUndefined();
      expect(port.posted).toEqual([{ type: "ready" }]);
    });

    it("keeps going while another page that joined is still there", async () => {
      const { fake, manager, stored } = await setup();
      const first = await start(manager);
      const second = await start(manager);
      first.remoteDisconnect();
      await tick();
      expect(fake.callsOf("detach")).toEqual([]);
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(second.types()).toEqual(["ready", "done"]);
      expect(stored()).toBeDefined();
      expectDetached(fake);
    });

    it("keeps tabs apart: events go to the capture of their own tab", async () => {
      const { fake, manager, stored } = await setup({ tabs: { [TAB]: YTM_URL, 8: YTM_URL } });
      const seven = await start(manager, { tabId: TAB });
      const eight = await start(manager, { tabId: 8 });
      await serveStream(fake, { tabId: 8, requestId: "800.1", videoId: OTHER });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(eight).videoId).toBe(OTHER);
      expect(seven.types()).toEqual(["ready"]);
      expect(stored(ID)).toBeUndefined();
      await serveStream(fake, { tabId: TAB });
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      expect(summaryOf(seven).videoId).toBe(ID);
    });

    it("ignores a malformed start message", async () => {
      const { fake, manager } = await setup();
      const port = openPort(manager);
      port.deliver({ type: "start", videoId: "not a video" });
      port.deliver({ type: "stop" });
      await tick();
      expect(port.posted).toEqual([]);
      expect(fake.callsOf("attach")).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith("[YTM Practice Grabber] capture: ignored a malformed capture message");
    });
  });

  describe("captureNow (dev helper)", () => {
    it("attaches, tells the user to click BL's refresh button, and resolves with the summary", async () => {
      const { fake, manager } = await setup();
      const result = manager.captureNow(TAB);
      await tick();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining("click Better Lyrics' refresh button"));
      await serveStream(fake);
      await vi.advanceTimersByTimeAsync(UNISON_GRACE_MS);
      await expect(result).resolves.toMatchObject({ videoId: ID, bodySource: "getResponseBody" });
      expectDetached(fake);
    });

    it("rejects with the reason, and refuses arguments that are not ids", async () => {
      const { manager } = await setup({ before: (fake) => fake.attachedElsewhere.add(TAB) });
      await expect(manager.captureNow(TAB)).rejects.toThrow("Another debugger is already attached to this tab");
      await expect(manager.captureNow(Number.NaN)).rejects.toThrow(TypeError);
      await expect(manager.captureNow(TAB, "nope")).rejects.toThrow(TypeError);
    });
  });
});

describe("secrets", () => {
  it("never lets BL's token or x-key-id reach storage, logs, port messages or errors", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const { fake, manager, area, stored } = await setup({ debug: true });
    const ports: FakePort[] = [];
    const errors: unknown[] = [];

    // A capture with Unison (x-key-id header), a refused stream, then BL's retry, read by streaming.
    ports.push(await start(manager));
    fake.emit(TAB, "Network.requestWillBeSentExtraInfo", { requestId: "2000.1", headers: { "x-key-id": FAKE_KEY_ID }, associatedCookies: [] });
    await serveUnison(fake);
    await serveStream(fake, { requestId: "1.1", status: 403, chunks: [`{"error":"bad token ${FAKE_TOKEN}"}`] });
    await serveStream(fake, { requestId: "1.2", bodyMode: "empty" });
    expect(summaryOf(ports[0]).videoId).toBe(ID);
    expect(stored()?.unisonRaw).toBe(UNISON);

    // The body only in postDataEntries, the stream only as EventSource, Unison 404.
    ports.push(await start(manager));
    fake.emit(TAB, "Network.requestWillBeSentExtraInfo", { requestId: "2.1", headers: { cookie: FAKE_TOKEN }, associatedCookies: [] });
    await serveStream(fake, { requestId: "2.1", entriesOnly: true, bodyMode: "error", streamable: false, eventSource: MESSAGES });
    await serveUnison(fake, { requestId: "2.2", status: 404 });
    expect(summaryOf(ports[1]).bodySource).toBe("eventSource");

    // Failures: a request failing with odd error text, a non-2xx stream, and captureNow's rejection.
    ports.push(await start(manager));
    const failing = blStreamRequest(fake, TAB, "3.1", { videoId: ID });
    failing.respond(200);
    await tick();
    failing.data(STREAM.slice(0, 100)).fail(`net::ERR_FAILED token=${FAKE_TOKEN}`);
    await tick();
    expect(reasonOf(ports[2])).toBe("The lyrics request failed");
    const rejected = manager.captureNow(TAB).catch((error: unknown) => errors.push(error));
    await tick();
    await serveStream(fake, { requestId: "4.1", status: 500, chunks: [`{"echo":"${FAKE_KEY_ID}"}`] });
    await rejected;
    expect(errors).toHaveLength(1);

    const text = [
      area.writtenText(),
      ...spies.flatMap((spy) => spy.mock.calls.flat().map(asText)),
      ...ports.map((port) => JSON.stringify(port.posted)),
      ...errors.map(asText),
    ].join("\n");
    expect(spies[0].mock.calls.length).toBeGreaterThan(10); // the debug log ran
    for (const secret of [FAKE_TOKEN, FAKE_KEY_ID, FAKE_TOKEN.split(".")[1]]) expect(text).not.toContain(secret);
  });
});

function asText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}\n${String(value.cause ?? "")}`;
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}
