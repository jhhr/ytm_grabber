// Service worker entry (dist/background.js, an ES module). Chrome only delivers events
// to listeners registered synchronously at top level, so later wiring goes here directly.
import { createMessageListener } from "./requests";
import { createCaptureStore } from "./store";

console.log("[YTM Practice Grabber] service worker loaded");

// One store for the worker's lifetime: it serialises its own writes, which only holds within
// one instance. Session storage is cleared when the browser closes and, by default, cannot be
// read by content scripts, so lyrics contents stay here.
const store = createCaptureStore({ area: chrome.storage.session });

chrome.runtime.onMessage.addListener(createMessageListener({ store }));
