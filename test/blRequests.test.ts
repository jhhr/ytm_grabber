import { describe, expect, it } from "vitest";
import {
  chooseBody,
  decodeBase64,
  LYRICS_STREAM_URL,
  readRequest,
  responseBodyText,
  sseFromEventSource,
  streamHasEnded,
  UNISON_URL,
  utf8,
} from "../src/shared/blRequests";
import { parseSse } from "../src/shared/sse";
import { base64, FAKE_TOKEN } from "./helpers/fakeDebugger";
import { STREAM } from "./helpers/captureHarness";

const ID = "Synth3t1cK1";
const FORM = `videoId=${ID}&song=Northbound+Kites&artist=Marrow+%26+Tin&duration=72&alwaysFetchMetadata=false&token=${FAKE_TOKEN}`;

function event(request: Record<string, unknown>, requestId = "42.7") {
  return { requestId, request: { headers: { "x-key-id": "k" }, ...request }, type: "Fetch" };
}

describe("readRequest", () => {
  it("tracks BL's stream (POST v2/lyrics) and reads only the video id from its body", () => {
    const seen = readRequest(event({ url: LYRICS_STREAM_URL, method: "POST", postData: FORM, hasPostData: true }));
    expect(seen).toEqual({ requestId: "42.7", kind: "stream", path: LYRICS_STREAM_URL, videoId: ID });
    expect(JSON.stringify(seen)).not.toContain(FAKE_TOKEN);
  });

  it("reads the body from postDataEntries (base64 bytes, possibly split) when postData is missing", () => {
    const bytes = new TextEncoder().encode(FORM);
    const entries = [{ bytes: base64(bytes.slice(0, 5)) }, { bytes: base64(bytes.slice(5)) }];
    expect(readRequest(event({ url: LYRICS_STREAM_URL, method: "POST", hasPostData: true, postDataEntries: entries }))?.videoId).toBe(ID);
    expect(readRequest(event({ url: LYRICS_STREAM_URL, method: "POST", postData: "", postDataEntries: entries }))?.videoId).toBe(ID);
  });

  it("tracks a stream whose body it cannot read, or whose video id is not one, without a video id", () => {
    for (const request of [
      { url: LYRICS_STREAM_URL, method: "POST", hasPostData: true },
      { url: LYRICS_STREAM_URL, method: "POST", postData: "videoId=not-an-id&token=x" },
      { url: LYRICS_STREAM_URL, method: "POST", postDataEntries: [{ bytes: "%%%" }] },
    ]) {
      expect(readRequest(event(request))).toEqual({ requestId: "42.7", kind: "stream", path: LYRICS_STREAM_URL });
    }
  });

  it("tracks Unison's GET /lyrics with any query, its v parameter as the video id", () => {
    expect(readRequest(event({ url: `${UNISON_URL}?v=${ID}&song=x&artist=y&duration=72`, method: "GET" }))).toEqual({
      requestId: "42.7",
      kind: "unison",
      path: UNISON_URL,
      videoId: ID,
    });
    expect(readRequest(event({ url: `${UNISON_URL}?song=x`, method: "GET" }))).toEqual({ requestId: "42.7", kind: "unison", path: UNISON_URL });
  });

  it("ignores everything else: verify-turnstile, votes, preflights, other methods, paths and hosts", () => {
    for (const request of [
      { url: "https://lyrics.api.dacubeking.com/verify-turnstile", method: "POST", postData: "token=abc" },
      { url: "https://lyrics.api.dacubeking.com/v2/lyrics", method: "GET" },
      { url: "https://lyrics.api.dacubeking.com/v2/lyrics", method: "OPTIONS" },
      { url: "https://lyrics.api.dacubeking.com/v2/lyrics/extra", method: "POST", postData: FORM },
      { url: "https://lyrics.api.dacubeking.com/v2/lyricsx", method: "POST", postData: FORM },
      { url: "https://lyrics.api.dacubeking.com/v1/lyrics", method: "POST", postData: FORM },
      { url: `${UNISON_URL}/31337/vote`, method: "POST" },
      { url: `${UNISON_URL}/31337/vote`, method: "DELETE" },
      { url: `${UNISON_URL}/31337`, method: "GET" },
      { url: `${UNISON_URL}/`, method: "GET" },
      { url: `${UNISON_URL}?v=${ID}`, method: "OPTIONS" },
      { url: `${UNISON_URL}?v=${ID}`, method: "POST" },
      { url: `http://unison.betterlyrics.org/lyrics?v=${ID}`, method: "GET" },
      { url: `https://unison.betterlyrics.org.evil.example/lyrics?v=${ID}`, method: "GET" },
      { url: "https://music.youtube.com/youtubei/v1/next", method: "POST", postData: "{}" },
      { url: "not a url", method: "POST" },
    ]) {
      expect(readRequest(event(request)), `${request.method} ${request.url}`).toBeNull();
    }
    expect(readRequest(null)).toBeNull();
    expect(readRequest({ requestId: 1, request: { url: LYRICS_STREAM_URL, method: "POST" } })).toBeNull();
    expect(readRequest({ requestId: "1" })).toBeNull();
  });
});

describe("decoding", () => {
  it("decodes base64 to bytes and joins chunks before decoding UTF-8, so a split character survives", () => {
    const bytes = new TextEncoder().encode("caf\u{e9} \u{1F3B5}");
    expect([...decodeBase64(base64(bytes))]).toEqual([...bytes]);
    const parts = [bytes.slice(0, 4), bytes.slice(4, 7), bytes.slice(7)];
    expect(utf8(parts)).toBe("caf\u{e9} \u{1F3B5}");
    expect(parts.map((part) => new TextDecoder().decode(part)).join("")).not.toBe("caf\u{e9} \u{1F3B5}");
  });

  it("drops a byte order mark as TextDecoder does, and rejects malformed base64 without quoting it", () => {
    expect(utf8([new Uint8Array([0xef, 0xbb, 0xbf, 0x41])])).toBe("A");
    expect(() => decodeBase64("not base64!")).toThrow();
    try {
      decodeBase64("not base64!");
    } catch (error) {
      expect(String(error)).not.toContain("not base64!");
    }
  });

  it("reads Network.getResponseBody results, base64-encoded or not", () => {
    expect(responseBodyText({ body: "plain", base64Encoded: false })).toBe("plain");
    expect(responseBodyText({ body: base64("caf\u{e9}"), base64Encoded: true })).toBe("caf\u{e9}");
    expect(responseBodyText({ base64Encoded: false })).toBeUndefined();
    expect(responseBodyText(undefined)).toBeUndefined();
  });
});

describe("the three body paths", () => {
  const events = parseSse(STREAM);
  // Each message's data as an EventSource delivers it; JSON spread over lines like a multi-line `data:` field.
  const messages = events.map(({ event: eventName, data }) => ({ eventName, data: JSON.stringify(data, null, 1) }));

  it("rebuilds the stream from EventSource messages so parseSse sees what BL saw", () => {
    expect(messages.some((message) => message.data.includes("\n"))).toBe(true);
    expect(parseSse(sseFromEventSource(messages))).toEqual(events);
    expect(sseFromEventSource([{ eventName: "done", data: "{}" }])).toBe("event: done\ndata: {}\n\n");
  });

  it("chooses getResponseBody, else the streamed bytes, else EventSource, else nothing", () => {
    const streamed = [new TextEncoder().encode("event: x\n"), new TextEncoder().encode("data: {}\n\n")];
    expect(chooseBody({ responseBody: "body", streamed, eventSource: messages })).toEqual({ text: "body", bodySource: "getResponseBody" });
    expect(chooseBody({ responseBody: "", streamed, eventSource: messages })).toEqual({ text: "event: x\ndata: {}\n\n", bodySource: "stream" });
    expect(chooseBody({ streamed: [new Uint8Array(0)], eventSource: messages })?.bodySource).toBe("eventSource");
    expect(chooseBody({ eventSource: messages })?.bodySource).toBe("eventSource");
    expect(chooseBody({ responseBody: "", streamed: [], eventSource: [] })).toBeNull();
  });

  it("knows when a stream holds BL's closing done event", () => {
    expect(streamHasEnded(STREAM)).toBe(true);
    expect(streamHasEnded("event:done\r\ndata: {}\r\n\r\n")).toBe(true);
    expect(streamHasEnded(STREAM.slice(0, STREAM.indexOf("event: done")))).toBe(false);
    expect(streamHasEnded('data: {"event: done"}\n')).toBe(false);
  });
});
