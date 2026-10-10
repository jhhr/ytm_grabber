// Options page entry (dist/options.js), loaded at the end of options.html: wires chrome.* into the
// page (optionsPage.ts). The settings are kept in chrome.storage.local, as everywhere else.
import { createSettingsStore } from "../shared/settings";
import { mountOptions } from "./optionsPage";

try {
  mountOptions({
    settings: createSettingsStore(chrome.storage.local),
    // Looked up at call time, as the content script does.
    runtime: { sendMessage: (message) => chrome.runtime.sendMessage(message) },
    extensionId: chrome.runtime.id,
  });
} catch (error) {
  // Only a page whose markup does not match the script gets here.
  console.error("[YTM Practice Grabber] options page:", error);
}
