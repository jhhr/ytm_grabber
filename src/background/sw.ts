// Service worker entry (dist/background.js, an ES module). Chrome only delivers events
// to listeners registered synchronously at top level, so every listener is added here, directly.
import { AUDIO_PORT, CAPTURE_PORT } from "../shared/messages";
import { createSettingsStore } from "../shared/settings";
import type { CaptureSummary } from "../shared/summary";
import { createAudioRelay } from "./audio";
import { createCaptureManager } from "./capture";
import { createLyricsDownloads } from "./downloads";
import { createMessageListener } from "./requests";
import { createCaptureStore } from "./store";

console.log("[YTM Practice Grabber] service worker loaded");

// One store for the worker's lifetime: it serialises its own writes, which only holds within
// one instance. Session storage is cleared when the browser closes and, by default, cannot be
// read by content scripts, so lyrics contents stay here.
const store = createCaptureStore({ area: chrome.storage.session });
const settings = createSettingsStore(chrome.storage.local);
const captures = createCaptureManager({ debugger: chrome.debugger, tabs: chrome.tabs, store, settings, log: console });
// Lyrics go where Chrome saves downloads; the downloadDirOverride option affects only the audio flow.
const lyrics = createLyricsDownloads({ downloads: chrome.downloads, store, settings, extensionId: chrome.runtime.id, log: console });
// Audio goes through the native host; chrome.runtime is reached at call time.
const audio = createAudioRelay({
  native: {
    connectNative: (application) => chrome.runtime.connectNative(application),
    sendNativeMessage: (application, message) => chrome.runtime.sendNativeMessage(application, message),
    lastError: () => chrome.runtime.lastError?.message,
  },
  settings,
  extensionId: chrome.runtime.id,
  log: console,
});

chrome.runtime.onMessage.addListener(createMessageListener({ store, downloadLyrics: lyrics.download, audio }));
// Learns Chrome's download folder when one of our lyrics downloads finishes. This wakes the worker
// for every download in the browser; anything not ours returns at once.
chrome.downloads.onChanged.addListener(lyrics.handleChanged);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CAPTURE_PORT && port.name !== AUDIO_PORT) return;
  // Only a content script, which runs in a tab, can ask for a capture of its tab or a song's audio.
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    port.disconnect();
    return;
  }
  if (port.name === AUDIO_PORT) audio.connect(port);
  else captures.connect(port, tabId);
});
chrome.debugger.onEvent.addListener(captures.handleEvent);
chrome.debugger.onDetach.addListener(captures.handleDetach);
// Always-attached mode attaches to YouTube Music tabs as they finish loading. Registered in every
// mode (a listener added later would not wake the worker); on demand it returns at once.
chrome.tabs.onUpdated.addListener(captures.handleTabUpdated);
settings.onSettingsChanged(captures.settingsChanged);
void captures.init();

// Dev helper for the service worker's console (PLAN.md section 4, Phase 3):
// `await captureNow(<tabId>)`, then click BL's refresh button; resolves with the capture summary.
(globalThis as { captureNow?: (tabId: number, videoId?: string) => Promise<CaptureSummary> }).captureNow = (tabId, videoId) =>
  captures.captureNow(tabId, videoId);
