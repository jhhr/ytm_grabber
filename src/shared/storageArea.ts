// The slice of a chrome.storage area that our modules use. Chrome's areas are passed in by the
// entry points (chrome.storage.session for captures, chrome.storage.local for settings), so
// tests can pass in-memory fakes and src/shared/ never touches chrome.* itself.

export interface StorageAreaLike {
  /** The stored items among `keys`; a key with no item is absent from the result. */
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  /** All items in one write: Chrome stores all of them or, over the quota, none. */
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface StorageChange {
  newValue?: unknown;
  oldValue?: unknown;
}

export type StorageChangeListener = (changes: Record<string, StorageChange>) => void;

/** An area's own `onChanged` event (chrome.storage.local.onChanged): changes in that area only. */
export interface StorageChangedEvent {
  addListener(callback: StorageChangeListener): void;
  removeListener(callback: StorageChangeListener): void;
}

export interface ObservableStorageArea extends StorageAreaLike {
  onChanged: StorageChangedEvent;
}

/**
 * True for the error a write gets when the area is full. Chrome words it per area:
 * "Session storage quota bytes exceeded. Values were not stored." (session) and
 * "Resource::kQuotaBytes quota exceeded" (local, sync), so match the common word only.
 */
export function isQuotaError(error: unknown): boolean {
  return error instanceof Error && /quota/i.test(error.message);
}

/**
 * Bytes an item takes by the rule Chrome applies to the local and sync areas: the key's
 * length plus the length of the value's JSON, both in UTF-8. The session area counts a memory
 * estimate instead (roughly the UTF-8 length of each string plus a little per object), which
 * for string-heavy items is below this, since JSON escapes every quote and backslash.
 */
export function storedItemBytes(key: string, value: unknown): number {
  const encoder = new TextEncoder();
  return encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
}
