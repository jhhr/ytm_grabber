// Content script entry (dist/content.js), isolated world on music.youtube.com.
import { createSettingsStore } from "../shared/settings";
import { mountLyricsButton } from "./lyricsButton";
import { createLyricsFlow } from "./lyricsFlow";
import { createToaster } from "./toast";

const LOG_PREFIX = "[YTM Practice Grabber]";
/** Set on <html> by the first copy of this script in a page. */
const LOADED_ATTRIBUTE = "data-pg-grabber";

// Chrome injects this once per page load, but a second copy (injected again by hand, or by a
// test) would add a second button and observer: the first copy marks the page, later ones stop.
const html = document.documentElement;
if (html.hasAttribute(LOADED_ATTRIBUTE)) {
  console.log(`${LOG_PREFIX} content script already running in this page`);
} else {
  html.setAttribute(LOADED_ATTRIBUTE, "");
  // chrome.* is reached through these wrappers at call time: after the extension is reloaded
  // they throw "Extension context invalidated", which the flow turns into a message.
  const lyrics = createLyricsFlow({
    runtime: {
      sendMessage: (message) => chrome.runtime.sendMessage(message),
      connect: (connectInfo) => chrome.runtime.connect(connectInfo),
      lastError: () => chrome.runtime.lastError?.message,
    },
    // Content scripts may read chrome.storage.local, where the options are kept.
    settings: createSettingsStore(chrome.storage.local),
    // One toaster for the page: every part that talks to the user should share it.
    toaster: createToaster(),
  });
  mountLyricsButton({ onClick: (button) => lyrics.onClick(button) });
  console.log(`${LOG_PREFIX} content script loaded`);
}
