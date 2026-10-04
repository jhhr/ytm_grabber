// One HTTPS server standing in for the three hosts the end-to-end test maps to 127.0.0.1 with
// Chromium's --host-resolver-rules, routed by the Host header:
//
//   music.youtube.com          GET /watch?v=<id>    the mock YouTube Music page (page/watch.html)
//                              GET /e2e/mock-ytm.js page/mockYtm.ts, bundled with esbuild at start
//   lyrics.api.dacubeking.com  POST /v2/lyrics      test/fixtures/synthetic-stream.txt as a
//                                                   text/event-stream, in delayed chunks
//   unison.betterlyrics.org    GET /lyrics?v=...    test/fixtures/synthetic-unison.json, or 404
//
// The page's requests to the other two hosts are cross-origin (Better Lyrics' content script
// fetches with the page's origin in MV3, and the mock page does the same from the page), so they
// get CORS headers and Unison's preflight (it sends `x-key-id`) is answered.
//
// Every request is recorded with its headers and body: the test checks that BL's fake secrets
// reached the server, which proves they passed the debugger the extension had attached.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LYRICS_HOST, UNISON_HOST, YTM_HOST, type Certificate } from "./certs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
export const STREAM_FIXTURE = readFileSync(path.join(root, "test/fixtures/synthetic-stream.txt"));
export const UNISON_FIXTURE = readFileSync(path.join(root, "test/fixtures/synthetic-unison.json"));

const YTM_ORIGIN = `https://${YTM_HOST}`;
/** Between two chunks of a stream: long enough for Chromium to hand each to the page on its own. */
export const CHUNK_DELAY_MS = 60;

export interface ReceivedRequest {
  host: string;
  method: string;
  /** Path and query. */
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface StreamPlan {
  /** Answer this many stream requests with HTTP 403 before streaming (BL retries once). */
  refuse: number;
  /** The stream to send: the fixture, or one whose raw text is over 1.5 MB (see largeStream()). */
  body: "fixture" | "large";
  /** Unison's answer. */
  unison: "fixture" | 404;
  /** Hold each stream response this long before answering (a capture caught while it runs). */
  holdMs: number;
}

export interface MockServer {
  port: number;
  /** Every request, in arrival order. */
  received: ReceivedRequest[];
  /** What the next requests get; tests change it between scenarios. */
  plan: StreamPlan;
  /** Exactly what each successful stream response sent, in order. */
  streamsSent: Buffer[];
  close(): Promise<void>;
}

export const DEFAULT_PLAN: Readonly<StreamPlan> = Object.freeze({ refuse: 0, body: "fixture", unison: "fixture", holdMs: 0 });

export async function startMockServer(certificate: Certificate): Promise<MockServer> {
  const pageHtml = readFileSync(path.join(here, "page/watch.html"));
  const pageScript = await bundlePageScript();
  const received: ReceivedRequest[] = [];
  const streamsSent: Buffer[] = [];
  const state: MockServer = {
    port: 0,
    received,
    plan: { ...DEFAULT_PLAN },
    streamsSent,
    close: () => Promise.resolve(),
  };

  const server = createServer({ ...certificate, noDelay: true }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ host, method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      try {
        route(host, req, res);
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain" }).end(String(error));
      }
    });
  });

  function route(host: string, req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `https://${host}`);
    if (host === YTM_HOST) {
      if (req.method === "GET" && url.pathname === "/watch") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(pageHtml);
        return;
      }
      if (req.method === "GET" && url.pathname === "/e2e/mock-ytm.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(pageScript);
        return;
      }
      if (url.pathname === "/favicon.ico") {
        // Answered so that the page's console holds nothing but what the page and extension write.
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    if (host === LYRICS_HOST && url.pathname === "/v2/lyrics") {
      // A form POST is a "simple" request: no preflight, but the page may read the answer only
      // with this header.
      const cors = { "access-control-allow-origin": YTM_ORIGIN, "cache-control": "no-store" };
      if (req.method !== "POST") {
        res.writeHead(405, cors).end();
        return;
      }
      const { refuse, body, holdMs } = state.plan;
      if (refuse > 0) state.plan.refuse--;
      setTimeout(() => {
        if (res.destroyed) return;
        if (refuse > 0) {
          res.writeHead(403, { ...cors, "content-type": "application/json" }).end('{"error":"forbidden"}');
          return;
        }
        const bytes = body === "large" ? largeStream() : STREAM_FIXTURE;
        streamsSent.push(bytes);
        res.writeHead(200, { ...cors, "content-type": "text/event-stream; charset=utf-8" });
        res.flushHeaders();
        void sendInChunks(res, bytes);
      }, holdMs);
      return;
    }
    if (host === UNISON_HOST && url.pathname === "/lyrics") {
      const cors = { "access-control-allow-origin": YTM_ORIGIN, "cache-control": "no-store" };
      if (req.method === "OPTIONS") {
        res
          .writeHead(204, {
            ...cors,
            "access-control-allow-methods": "GET",
            "access-control-allow-headers": "x-key-id",
            "access-control-max-age": "0",
          })
          .end();
        return;
      }
      if (req.method === "GET" && state.plan.unison === "fixture") {
        res.writeHead(200, { ...cors, "content-type": "application/json; charset=utf-8" }).end(UNISON_FIXTURE);
        return;
      }
      res.writeHead(404, { ...cors, "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

/**
 * Where a stream is cut into chunks: inside the metadata block's data line, inside a provider
 * block, between the three bytes of the first multi-byte character (the fixture's full-width
 * colon in the QQ block), and every 64 KiB of a large stream.
 */
export function chunkBoundaries(bytes: Buffer): number[] {
  const cuts = new Set<number>();
  const metadata = bytes.indexOf("event: metadata");
  if (metadata >= 0) cuts.add(metadata + 40);
  const golyrics = bytes.indexOf('"provider":"golyrics"');
  if (golyrics >= 0) cuts.add(golyrics + 500);
  const multiByte = bytes.findIndex((byte) => byte >= 0x80);
  if (multiByte >= 0) cuts.add(multiByte + 1);
  for (let at = 64 * 1024; at < bytes.length; at += 64 * 1024) cuts.add(at);
  cuts.add(Math.floor(bytes.length * 0.9));
  return [...cuts].filter((cut) => cut > 0 && cut < bytes.length).sort((a, b) => a - b);
}

async function sendInChunks(res: ServerResponse, bytes: Buffer): Promise<void> {
  let from = 0;
  for (const cut of [...chunkBoundaries(bytes), bytes.length]) {
    if (res.destroyed) return;
    res.write(bytes.subarray(from, cut));
    from = cut;
    await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
  }
  res.end();
}

/** Raw text over this many bytes makes a base64 data URL longer than Chrome's 2 MiB URL limit. */
export const LARGE_STREAM_BYTES = 1_750_000;

/**
 * The fixture with one more provider block before `done`, from an unknown provider whose results
 * are padding, so that the whole stream is LARGE_STREAM_BYTES: its raw download is a data URL of
 * about 2.33 million characters (Chrome caps URLs at 2 MiB, 2,097,152).
 */
export function largeStream(): Buffer {
  const text = STREAM_FIXTURE.toString("utf8");
  const done = text.lastIndexOf("event: done");
  const head = text.slice(0, done);
  const tail = text.slice(done);
  const shell = (padding: string) => `event: provider\ndata: {"provider":"e2e-padding","results":{"padding":"${padding}"}}\n\n`;
  const room = LARGE_STREAM_BYTES - Buffer.byteLength(head + shell("") + tail);
  const line = "Invented padding for a large stream. ";
  const padding = line.repeat(Math.ceil(room / line.length)).slice(0, room);
  return Buffer.from(head + shell(padding) + tail, "utf8");
}

async function bundlePageScript(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(here, "page/mockYtm.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}
