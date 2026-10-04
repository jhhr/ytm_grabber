import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSse, type SseEvent } from "../src/shared/sse";

// Read byte for byte and never normalised; CRLF variants are made here.
const fixture = readFileSync(new URL("./fixtures/synthetic-stream.txt", import.meta.url), "utf8");
const toCrlf = (text: string) => text.replace(/\n/g, "\r\n");

/** Deterministic PRNG (mulberry32) so a failing random case can be reproduced. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * BL's read loop (startStream in unified.ts): decode each chunk with a streaming
 * TextDecoder, split the buffer into messages, keep the last part for the next chunk, and
 * at the end parse what is left unless it is blank. Returns the messages BL would parse.
 */
function blMessages(bytes: Uint8Array, cuts: number[]): string[] {
  const decoder = new TextDecoder();
  const messages: string[] = [];
  let buffer = "";
  let start = 0;
  for (const cut of [...cuts, bytes.length]) {
    buffer += decoder.decode(bytes.subarray(start, cut), { stream: true });
    start = cut;
    const parts = buffer.split(/\n\n|\r\n\r\n/);
    buffer = parts.pop() || "";
    messages.push(...parts);
  }
  if (buffer.trim()) messages.push(buffer);
  return messages;
}

const summary = (events: SseEvent[]) =>
  events.map(({ event, data }) => [event, (data as { provider?: string } | null)?.provider ?? null]);

describe("parseSse on the synthetic stream", () => {
  it("reads every block in order and skips the comment-only header", () => {
    const events = parseSse(fixture);
    expect(summary(events)).toEqual([
      ["metadata", null],
      ["provider", "lrclib"],
      ["provider", "musixmatch"],
      ["provider", "golyrics"],
      ["provider", "qq"],
      ["provider", "kugou"],
      ["provider", "binimum"],
      ["done", null],
    ]);
    expect(events[0].data).toEqual({ song: "Northbound Kites", artist: "Marrow & Tin", album: "Weather Almanac", duration: 72 });
    expect(events[7].data).toEqual({});
    expect(events.some((event) => "error" in event)).toBe(false);
  });

  it("gives the same events with CRLF line ends", () => {
    expect(toCrlf(fixture)).not.toBe(fixture);
    expect(parseSse(toCrlf(fixture))).toEqual(parseSse(fixture));
  });

  it("gives the same events as BL's chunked reader, however the bytes are cut", () => {
    const next = random(20261004);
    for (const text of [fixture, toCrlf(fixture)]) {
      const bytes = new TextEncoder().encode(text);
      const whole = parseSse(text);
      // One byte at a time cuts inside every CRLF pair and every multi-byte character.
      const cutsList = [Array.from({ length: bytes.length - 1 }, (_, i) => i + 1)];
      for (let run = 0; run < 200; run++) {
        const count = 1 + Math.floor(next() * 40);
        cutsList.push(Array.from({ length: count }, () => Math.floor(next() * bytes.length)).sort((a, b) => a - b));
      }
      for (const cuts of cutsList) {
        expect(blMessages(bytes, cuts).flatMap((message) => parseSse(message)), JSON.stringify(cuts)).toEqual(whole);
      }
    }
  });
});

describe("parseSse rules (BL's parseSSEMessage)", () => {
  it("joins the data: values of a block with no separator, each value trimmed", () => {
    expect(parseSse('event: provider\ndata:   {"provider":  \ndata:  "lrclib"}   \n\n')).toEqual([
      { event: "provider", data: { provider: "lrclib" } },
    ]);
    // A newline between the values would have changed the string (and made it invalid JSON).
    expect(parseSse('data: {"text":"abc\ndata:def"}')).toEqual([{ event: "", data: { text: "abcdef" } }]);
  });

  it("keeps the last event: of a block", () => {
    expect(parseSse("event: metadata\nevent: provider\ndata: {}")).toEqual([{ event: "provider", data: {} }]);
  });

  it("reads values with or without a space after the colon", () => {
    expect(parseSse("event:done\ndata:{}")).toEqual([{ event: "done", data: {} }]);
  });

  it("ignores id:, retry:, comment and other lines, and lines that do not start with the field name", () => {
    const text = 'id: 7\nretry: 1000\n: data: {"no":1}\nfoo: bar\n data: {"no":2}\nEvent: x\nevent: done\ndata: {}';
    expect(parseSse(text)).toEqual([{ event: "done", data: {} }]);
  });

  it("skips blocks without data, with blank data or with [DONE]", () => {
    const text = "event: ping\n\nevent: provider\ndata:\n\ndata: [DONE]\n\nevent: done\ndata:    \n\n: only a comment\n\n\n\n";
    expect(parseSse(text)).toEqual([]);
    expect(parseSse("")).toEqual([]);
  });

  it("gives an empty event name to a block without event:", () => {
    expect(parseSse('data: {"x":1}')).toEqual([{ event: "", data: { x: 1 } }]);
  });

  it("keeps data that is valid JSON but not an object", () => {
    expect(parseSse("data: 42\n\ndata: null\n\ndata: \"s\"")).toEqual([
      { event: "", data: 42 },
      { event: "", data: null },
      { event: "", data: "s" },
    ]);
  });

  it("returns a malformed block with its error and raw data, and carries on", () => {
    const events = parseSse('event: provider\ndata: {"provider":"qq",\n\nevent: done\ndata: {}\n\n');
    expect(events).toEqual([
      { event: "provider", data: null, error: expect.any(String), rawData: '{"provider":"qq",' },
      { event: "done", data: {} },
    ]);
    expect(events[0].error).not.toBe("");
  });

  it("splits blocks on \\n\\n and \\r\\n\\r\\n in the same text, and parses a last block with no blank line after it", () => {
    const text = "event: a\r\ndata: 1\r\n\r\nevent: b\ndata: 2\n\nevent: c\r\ndata: 3";
    expect(parseSse(text)).toEqual([
      { event: "a", data: 1 },
      { event: "b", data: 2 },
      { event: "c", data: 3 },
    ]);
  });

  it("follows BL's separator regex exactly: \\r\\n\\n ends a block, \\n\\r\\n does not", () => {
    expect(parseSse("event: a\r\ndata: 1\r\n\nevent: b\r\ndata: 2")).toEqual([
      { event: "a", data: 1 },
      { event: "b", data: 2 },
    ]);
    // One block: the last event: wins and the data values join into "12".
    expect(parseSse("event: a\ndata: 1\n\r\nevent: b\ndata: 2")).toEqual([{ event: "b", data: 12 }]);
  });

  it("drops a leading byte order mark, as BL's TextDecoder does", () => {
    expect(parseSse("\u{FEFF}event: done\ndata: {}")).toEqual([{ event: "done", data: {} }]);
  });
});
