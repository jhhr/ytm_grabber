// The capture summary of the synthetic fixture (all seven providers + Unison), as the service
// worker would send it to the content script, under any video id.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSources } from "../../src/shared/sources";
import { parseSse } from "../../src/shared/sse";
import { summarize, type CaptureSummary } from "../../src/shared/summary";

// Not `new URL("../fixtures/...", import.meta.url)`: in jsdom tests Vite rewrites that pattern
// into a web asset URL (http:), which readFileSync refuses.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const stream = readFileSync(join(fixtures, "synthetic-stream.txt"), "utf8");
const unison = readFileSync(join(fixtures, "synthetic-unison.json"), "utf8");
const { metadata, sources } = extractSources(parseSse(stream), unison);

/** Metadata: song "Northbound Kites", artist "Marrow & Tin". */
export function fixtureSummary(videoId: string): CaptureSummary {
  return summarize({ videoId, capturedAt: 1_700_000_000_000, metadata, rawStream: stream, bodySource: "getResponseBody" }, sources);
}
