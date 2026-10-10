// @vitest-environment jsdom
// The real page bridge, loaded into jsdom as Chrome loads it into the page, with a stub of
// YouTube's #movie_player.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getNowPlaying } from "../src/content/nowPlaying";
import { NOW_PLAYING_EVENT, WHAT_IS_PLAYING_EVENT } from "../src/shared/bridgeProtocol";

const ID = "nKites0042x";
const errors: ErrorEvent[] = [];
const onError = (event: ErrorEvent) => {
  errors.push(event);
  event.preventDefault();
};

beforeAll(async () => {
  window.addEventListener("error", onError);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await import("../src/content/page-bridge");
  expect(log).toHaveBeenCalledWith("[YTM Practice Grabber] page bridge loaded");
  log.mockRestore();
});

afterAll(() => window.removeEventListener("error", onError));

afterEach(() => {
  document.querySelector("#movie_player")?.remove();
  errors.length = 0;
});

/** Puts a #movie_player with these members into the page (methods as own properties, as YouTube's are). */
function stubPlayer(members: object): HTMLElement {
  const player = document.createElement("div");
  player.id = "movie_player";
  Object.defineProperties(player, Object.getOwnPropertyDescriptors(members));
  document.body.append(player);
  return player;
}

const songPlayer = {
  getVideoData: () => ({ video_id: ID, title: "Northbound Kites", author: "Marrow & Tin", list: "RDAMVM" }),
  getPlayerResponse: () => ({ videoDetails: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV", videoId: ID } }),
};

/** Dispatches requests as the content script does and returns every reply's raw detail. */
function ask(...details: unknown[]): unknown[] {
  const replies: unknown[] = [];
  const listener = (event: Event) => replies.push((event as CustomEvent<unknown>).detail);
  document.addEventListener(NOW_PLAYING_EVENT, listener);
  try {
    for (const detail of details) document.dispatchEvent(new CustomEvent(WHAT_IS_PLAYING_EVENT, { detail }));
  } finally {
    document.removeEventListener(NOW_PLAYING_EVENT, listener);
  }
  return replies;
}

const request = (requestId: unknown) => JSON.stringify({ requestId });
const nulls = { videoId: null, title: null, author: null, musicVideoType: null };

describe("page bridge", () => {
  it("answers at once with a JSON string carrying the request id and what the player reports", () => {
    stubPlayer(songPlayer);
    const replies = ask(request("pg-1-abc"));
    expect(replies).toHaveLength(1);
    expect(typeof replies[0]).toBe("string");
    expect(JSON.parse(replies[0] as string)).toEqual({
      requestId: "pg-1-abc",
      videoId: ID,
      title: "Northbound Kites",
      author: "Marrow & Tin",
      musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
    });
  });

  it("answers each request under its own id", () => {
    stubPlayer(songPlayer);
    const replies = ask(request("first"), request("second")).map((detail) => JSON.parse(detail as string).requestId);
    expect(replies).toEqual(["first", "second"]);
  });

  it("answers with nulls when there is no player", () => {
    expect(ask(request("r")).map((detail) => JSON.parse(detail as string))).toEqual([{ requestId: "r", ...nulls }]);
  });

  it("never throws into the page, and keeps what it could read", () => {
    const boom = () => {
      throw new Error("player not ready");
    };
    const cases: [object, object][] = [
      [{}, nulls],
      [{ getVideoData: boom, getPlayerResponse: songPlayer.getPlayerResponse }, { ...nulls, musicVideoType: "MUSIC_VIDEO_TYPE_ATV" }],
      [{ getVideoData: songPlayer.getVideoData, getPlayerResponse: boom }, { videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: null }],
      [{ getVideoData: () => null, getPlayerResponse: () => ({ videoDetails: null }) }, nulls],
      [{ getVideoData: () => ({ video_id: 42, title: ["x"], author: {} }), getPlayerResponse: () => ({ videoDetails: { musicVideoType: 7 } }) }, nulls],
      [{ getVideoData: "not a function", getPlayerResponse: undefined }, nulls],
      [{ get getVideoData() { return boom(); }, get getPlayerResponse() { return boom(); } }, nulls],
    ];
    for (const [members, expected] of cases) {
      const player = stubPlayer(members);
      expect(ask(request("r")).map((detail) => JSON.parse(detail as string))).toEqual([{ requestId: "r", ...expected }]);
      player.remove();
    }
    expect(errors).toEqual([]);
  });

  it("does not answer requests that are not a JSON string with a request id", () => {
    stubPlayer(songPlayer);
    const details = [undefined, null, { requestId: "object" }, "not json", "[]", "null", request(5), request(""), request("has space"), request("x".repeat(65)), "{}"];
    expect(ask(...details)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("is what the content script's getNowPlaying hears", async () => {
    stubPlayer(songPlayer);
    const [one, two] = await Promise.all([getNowPlaying(), getNowPlaying()]);
    const expected = { videoId: ID, title: "Northbound Kites", author: "Marrow & Tin", musicVideoType: "MUSIC_VIDEO_TYPE_ATV", from: "bridge" };
    expect(one).toEqual(expected);
    expect(two).toEqual(expected);
  });
});
