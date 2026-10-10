// @vitest-environment jsdom
// No page bridge here: either nothing answers, or the test answers as the bridge would.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_TIMEOUT_MS, PLAYER_BAR_SELECTORS, getNowPlaying, nowPlayingFromPage, stemFor } from "../src/content/nowPlaying";
import { NOW_PLAYING_EVENT, WHAT_IS_PLAYING_EVENT, decodeRequest } from "../src/shared/bridgeProtocol";

const ID = "nKites0042x";
const BULLET = "\u{2022}";
let answer: ((event: Event) => void) | undefined;

beforeEach(() => {
  history.replaceState(null, "", `/watch?v=${ID}&list=RDAMVM${ID}`);
});

afterEach(() => {
  if (answer) document.removeEventListener(WHAT_IS_PLAYING_EVENT, answer);
  answer = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function playerBar(title: string | null, byline: string | null): void {
  const bar = document.createElement("ytmusic-player-bar");
  for (const [className, text] of [["title", title], ["byline", byline]] as const) {
    if (text === null) continue;
    const element = document.createElement("yt-formatted-string");
    element.className = `${className} style-scope ytmusic-player-bar`;
    element.textContent = text;
    bar.append(element);
  }
  document.body.append(bar);
}

/** Answers requests as the bridge would; `replies` turns a request id into the details to send back. */
function fakeBridge(replies: (requestId: string) => unknown[]): void {
  answer = (event) => {
    const requestId = decodeRequest((event as CustomEvent<unknown>).detail);
    if (requestId === null) return;
    for (const detail of replies(requestId)) document.dispatchEvent(new CustomEvent(NOW_PLAYING_EVENT, { detail }));
  };
  document.addEventListener(WHAT_IS_PLAYING_EVENT, answer);
}

const reply = (requestId: string, fields: object) =>
  JSON.stringify({ requestId, videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: "MUSIC_VIDEO_TYPE_OMV", ...fields });

describe("getNowPlaying", () => {
  it("falls back to the URL and the player bar when the bridge does not answer in time", async () => {
    vi.useFakeTimers();
    playerBar("  Northbound Kites ", `Marrow & Tin ${BULLET} Paper Weather ${BULLET} 2026`);
    let result: unknown;
    void getNowPlaying().then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: null, from: "page" });
  });

  it("waits as long as it is told", async () => {
    vi.useFakeTimers();
    let done = false;
    void getNowPlaying(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("takes the bridge's answer to its own request only, and stops listening", async () => {
    vi.useFakeTimers();
    const removed = vi.spyOn(document, "removeEventListener");
    fakeBridge((requestId) => [
      reply("someone-else", { title: "Wrong Song" }),
      JSON.parse(reply(requestId, { title: "Not a string detail" })),
      reply(requestId, {}),
      reply(requestId, { title: "Second answer" }),
    ]);
    // Answered inside the request: no waiting for the timeout.
    const result = await getNowPlaying();
    expect(result).toEqual({ videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: "MUSIC_VIDEO_TYPE_OMV", from: "bridge" });
    expect(removed).toHaveBeenCalledWith(NOW_PLAYING_EVENT, expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps two requests in flight apart", async () => {
    const pending: ((title: string) => void)[] = [];
    fakeBridge((requestId) => {
      pending.push((title) => document.dispatchEvent(new CustomEvent(NOW_PLAYING_EVENT, { detail: reply(requestId, { title }) })));
      return [];
    });
    const first = getNowPlaying();
    const second = getNowPlaying();
    pending[1]("Second");
    pending[0]("First");
    expect((await first).title).toBe("First");
    expect((await second).title).toBe("Second");
  });

  it("uses the page, not a mix, when the bridge names no valid video", async () => {
    playerBar("Northbound Kites", "Marrow & Tin");
    for (const videoId of [null, "", "short", `${ID}x`, 42]) {
      answer && document.removeEventListener(WHAT_IS_PLAYING_EVENT, answer);
      fakeBridge((requestId) => [reply(requestId, { videoId, title: "Bridge Title" })]);
      expect(await getNowPlaying()).toEqual({ videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: null, from: "page" });
    }
  });

  it("keeps the bridge's fields as they are, even empty ones the page could fill", async () => {
    playerBar("Page Title", "Page Artist");
    fakeBridge((requestId) => [reply(requestId, { title: null, author: "Marrow & Tin - Topic", musicVideoType: null })]);
    expect(await getNowPlaying()).toEqual({ videoId: ID, title: null, author: "Marrow & Tin - Topic", musicVideoType: null, from: "bridge" });
  });
});

describe("nowPlayingFromPage", () => {
  it("reads the selectors that are to be checked on the live page", () => {
    expect(PLAYER_BAR_SELECTORS).toEqual({ title: "ytmusic-player-bar .title", byline: "ytmusic-player-bar .byline" });
  });

  it("takes the artist from the byline up to the first bullet", () => {
    const cases: [string, string | null][] = [
      [`Marrow & Tin ${BULLET} Paper Weather ${BULLET} 2026`, "Marrow & Tin"],
      [`Marrow & Tin\u{A0}${BULLET}\u{A0}Paper Weather`, "Marrow & Tin"],
      ["Marrow & Tin", "Marrow & Tin"],
      [`Dot${BULLET}Com ${BULLET} Album`, `Dot${BULLET}Com`],
      [`Marrow & Tin ${BULLET}`, "Marrow & Tin"],
      [`  ${BULLET} Album`, null],
      ["   ", null],
    ];
    for (const [byline, author] of cases) {
      document.body.replaceChildren();
      playerBar("Northbound Kites", byline);
      expect(nowPlayingFromPage().author, byline).toBe(author);
    }
  });

  it("gives nulls for what the page does not show, and no id unless the URL has a valid one", () => {
    expect(nowPlayingFromPage()).toEqual({ videoId: ID, title: null, author: null, musicVideoType: null, from: "page" });
    for (const path of ["/", "/watch", "/watch?v=", "/watch?v=short", `/watch?v=${ID}x`, `/watch?list=x&v=${ID.slice(1)}`]) {
      history.replaceState(null, "", path);
      expect(nowPlayingFromPage().videoId, path).toBeNull();
    }
    history.replaceState(null, "", `/watch?list=RDAMVM&v=${ID}`);
    expect(nowPlayingFromPage().videoId).toBe(ID);
  });
});

describe("stemFor", () => {
  it("builds the stem with buildStem", () => {
    expect(stemFor({ videoId: ID, title: "Northbound Kites", author: "Marrow & Tin" })).toEqual({ stem: `Marrow & Tin - Northbound Kites [${ID}]` });
    expect(stemFor({ videoId: ID, title: null, author: null })).toEqual({ stem: `[${ID}]` });
    expect(stemFor({ videoId: ID, title: "What? / Why:", author: "  " })).toEqual({ stem: `What Why [${ID}]` });
  });

  it("gives a reason instead of throwing when there is no valid id", () => {
    expect(stemFor({ videoId: null, title: "Northbound Kites", author: "Marrow & Tin" })).toEqual({ stem: null, reason: "Could not tell which video is playing" });
    expect(stemFor({ videoId: "not an id", title: "Northbound Kites", author: null })).toEqual({ stem: null, reason: '"not an id" is not a YouTube video id' });
    expect(stemFor({ videoId: "", title: null, author: null }).stem).toBeNull();
  });
});
