// The extension's options (PLAN.md section 3.9), kept in chrome.storage.local, one item per
// setting: the options page and the service worker (which learns the download folder) write
// different settings, and separate items mean neither can overwrite the other's with a stale
// copy. The area is passed in: each entry point hands over chrome.storage.local.

import type { ObservableStorageArea, StorageChangeListener } from "./storageArea";

export type CaptureMode = "on-demand" | "always";

export interface Settings {
  /** Attach the debugger only when asked (default), or to every YTM tab and capture passively. */
  captureMode: CaptureMode;
  /** Save files as `<stem>/<stem><ext>` (lyrics) and into `<downloadDir>\<stem>\` (audio). */
  perSongSubfolder: boolean;
  /** Folder for audio downloads chosen in the options; "" uses the learned one. */
  downloadDirOverride: string;
  /** Log which way the capture read the lyrics response (bodySource). */
  debugCapture: boolean;
  /** Chrome's download folder, learned from a finished lyrics download; "" until then. */
  learnedDownloadDir: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  captureMode: "on-demand",
  perSongSubfolder: false,
  downloadDirOverride: "",
  debugCapture: false,
  learnedDownloadDir: "",
});

export interface SettingsStore {
  /** Stored values over the defaults; a stored value of the wrong type counts as not stored. */
  getSettings(): Promise<Settings>;
  /** Writes the given settings only. Throws a TypeError, writing nothing, for an unknown key or a wrong type. */
  setSettings(partial: Partial<Settings>): Promise<void>;
  /**
   * Calls `callback` with the settings that changed and their new values (the default when a
   * setting was removed or holds a wrong type). Returns a function that unsubscribes.
   */
  onSettingsChanged(callback: (changed: Partial<Settings>) => void): () => void;
}

type SettingKey = keyof Settings;

const VALID: { [K in SettingKey]: (value: unknown) => value is Settings[K] } = {
  captureMode: (value): value is CaptureMode => value === "on-demand" || value === "always",
  perSongSubfolder: isBoolean,
  downloadDirOverride: isString,
  debugCapture: isBoolean,
  learnedDownloadDir: isString,
};

const KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

export function createSettingsStore(area: ObservableStorageArea): SettingsStore {
  return {
    async getSettings() {
      const stored = await area.get(KEYS);
      const settings = { ...DEFAULT_SETTINGS };
      for (const key of KEYS) assign(settings, key, stored[key]);
      return settings;
    },

    async setSettings(partial) {
      const items: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(partial)) {
        // An optional property can be present and undefined: that sets nothing.
        if (value === undefined) continue;
        if (!isSettingKey(key)) throw new TypeError(`Unknown setting: ${key}`);
        if (!VALID[key](value)) throw new TypeError(`Wrong value for setting ${key}: ${JSON.stringify(value)}`);
        items[key] = value;
      }
      if (Object.keys(items).length > 0) await area.set(items);
    },

    onSettingsChanged(callback) {
      const listener: StorageChangeListener = (changes) => {
        const changed: Partial<Settings> = {};
        let any = false;
        for (const key of KEYS) {
          if (!Object.hasOwn(changes, key)) continue;
          assign(changed, key, changes[key].newValue);
          any = true;
        }
        if (any) callback(changed);
      };
      area.onChanged.addListener(listener);
      return () => area.onChanged.removeListener(listener);
    },
  };
}

/** Sets `target[key]` to `value` when it is valid for that setting, else to the default. */
function assign<K extends SettingKey>(target: Partial<Settings>, key: K, value: unknown): void {
  const valid = VALID[key];
  target[key] = valid(value) ? value : DEFAULT_SETTINGS[key];
}

function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(DEFAULT_SETTINGS, key);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
