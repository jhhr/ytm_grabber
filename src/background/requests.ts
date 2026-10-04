// The service worker's answers to one-shot requests (chrome.runtime.sendMessage) from the
// content script. sw.ts registers createMessageListener() at top level; the handlers take
// their dependencies as arguments so tests can call them with fakes.

import {
  isExtensionRequest,
  type CaptureGetRequest,
  type CaptureGetResponse,
  type ExtensionRequest,
  type LyricsDownloadRequest,
  type LyricsDownloadResponse,
} from "../shared/messages";
import { summarize } from "../shared/summary";
import type { CaptureStore } from "./store";

export interface RequestDeps {
  store: Pick<CaptureStore, "get">;
  /** Saves a lyrics menu item's file (downloads.ts createLyricsDownloads().download). */
  downloadLyrics(request: LyricsDownloadRequest): Promise<LyricsDownloadResponse>;
}

/** The summary of the stored capture, or null when there is none (the content script then captures). */
export async function handleCaptureGet({ videoId }: CaptureGetRequest, { store }: Pick<RequestDeps, "store">): Promise<CaptureGetResponse> {
  const capture = await store.get(videoId);
  return { summary: capture && summarize(capture, capture.sources) };
}

export function handleRequest(request: ExtensionRequest, deps: RequestDeps): Promise<CaptureGetResponse | LyricsDownloadResponse> {
  switch (request.type) {
    case "capture:get":
      return handleCaptureGet(request, deps);
    case "lyrics:download":
      return deps.downloadLyrics(request);
  }
}

/**
 * A chrome.runtime.onMessage listener. A malformed request (wrong shape, bad video or item id) gets no
 * answer: the listener returns false and the sender's promise rejects. A valid one is answered
 * asynchronously, hence `true`, which keeps the channel open. A handler that fails still
 * answers, with "no capture" or the download's error, so the sender never waits forever.
 */
export function createMessageListener(deps: RequestDeps) {
  return (message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void): boolean => {
    if (!isExtensionRequest(message)) {
      console.warn("[YTM Practice Grabber] ignored a malformed message");
      return false;
    }
    handleRequest(message, deps).then(sendResponse, (error: unknown) => {
      console.error(`[YTM Practice Grabber] ${message.type} failed:`, error);
      sendResponse(failure(message, error));
    });
    return true;
  };
}

function failure(request: ExtensionRequest, error: unknown): CaptureGetResponse | LyricsDownloadResponse {
  switch (request.type) {
    case "capture:get":
      return { summary: null };
    case "lyrics:download":
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
