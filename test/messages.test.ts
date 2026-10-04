import { describe, expect, it } from "vitest";
import { CAPTURE_PORT, isCapturePortRequest, isExtensionRequest } from "../src/shared/messages";

const ID = "Synth3t1cK1";
// Not video ids: wrong length, a character outside [A-Za-z0-9_-], a trailing newline, not a string.
const BAD_IDS: unknown[] = ["", "Synth3t1cK", "Synth3t1cK12", "Synth3t1c K", "Synth3t1c/1", `${ID}\n`, "capture:idx", 12345678901, null, undefined, [ID]];

describe("isExtensionRequest", () => {
  it("accepts capture:get with a video id", () => {
    expect(isExtensionRequest({ type: "capture:get", videoId: ID })).toBe(true);
    // Extra fields are ignored by the handlers, not refused.
    expect(isExtensionRequest({ type: "capture:get", videoId: ID, extra: 1 })).toBe(true);
  });

  it("refuses capture:get without a valid video id", () => {
    for (const videoId of BAD_IDS) expect(isExtensionRequest({ type: "capture:get", videoId }), JSON.stringify(videoId)).toBe(false);
    expect(isExtensionRequest({ type: "capture:get" })).toBe(false);
  });

  it("accepts lyrics:download with a video id, an item id and a stem", () => {
    expect(isExtensionRequest({ type: "lyrics:download", videoId: ID, itemId: "tony", stem: `Marrow & Tin - Northbound Kites [${ID}]` })).toBe(true);
  });

  it("refuses lyrics:download with a bad video id or a missing, empty or non-string item id or stem", () => {
    const good = { type: "lyrics:download", videoId: ID, itemId: "tony", stem: "stem" };
    for (const videoId of BAD_IDS) expect(isExtensionRequest({ ...good, videoId })).toBe(false);
    for (const key of ["itemId", "stem"]) {
      for (const value of [undefined, "", 1, null, ["x"], { toString: () => "x" }]) {
        expect(isExtensionRequest({ ...good, [key]: value }), `${key} = ${String(value)}`).toBe(false);
      }
    }
  });

  it("refuses what is not a request", () => {
    for (const value of [null, undefined, "capture:get", 1, [], [{ type: "capture:get", videoId: ID }], { videoId: ID }, { type: "capture:start", videoId: ID }, { type: "CAPTURE:GET", videoId: ID }]) {
      expect(isExtensionRequest(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("the capture port", () => {
  it("is named capture", () => {
    expect(CAPTURE_PORT).toBe("capture");
  });

  it("accepts start with a video id and nothing else", () => {
    expect(isCapturePortRequest({ type: "start", videoId: ID })).toBe(true);
    for (const videoId of BAD_IDS) expect(isCapturePortRequest({ type: "start", videoId })).toBe(false);
    for (const value of [null, "start", { type: "ready" }, { type: "done", summary: {} }, { type: "capture:get", videoId: ID }, [{ type: "start", videoId: ID }]]) {
      expect(isCapturePortRequest(value), JSON.stringify(value)).toBe(false);
    }
  });
});
