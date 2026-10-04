// An in-memory chrome.storage area for tests (B5a; meant for reuse by later phases).
//
// What it copies from Chrome (checked in Chromium's extensions/browser/api/storage/
// session_storage_manager.cc and settings_storage_quota_enforcer.cc):
// - set() writes all of its items or, over the quota, none, and rejects with an Error whose
//   message is the area's: session "Session storage quota bytes exceeded. Values were not
//   stored." (fails when usage would REACH the quota), local "Resource::kQuotaBytes quota
//   exceeded" (fails when usage would EXCEED it);
// - values come back as copies (JSON round trip), so a caller cannot change what is stored;
// - onChanged fires for keys whose value changed, with oldValue / newValue.
// Usage is counted by the local-area rule for both kinds: key + JSON of the value, in UTF-8
// (storedItemBytes). Chrome's session area counts a memory estimate instead, a little lower
// for long strings; tests must not depend on the exact byte where the real session area fails.
// Events are dispatched synchronously, before the write's promise resolves (Chrome: later).
//
// Test hooks: `calls` logs every call (set items as copies, failed sets too), `writtenText()`
// is everything ever passed to set() for "this secret was never stored" checks, and
// `beforeSet` / `beforeRemove` may throw to make that call reject without changing anything.

import { storedItemBytes, type StorageChange } from "../../src/shared/storageArea";

export const QUOTA_BYTES = 10_485_760;
export const SESSION_QUOTA_ERROR = "Session storage quota bytes exceeded. Values were not stored.";
export const LOCAL_QUOTA_ERROR = "Resource::kQuotaBytes quota exceeded";

/** A chrome.events.Event stand-in: tests call dispatch() to fire it. */
export class FakeEvent<F extends (...args: never[]) => unknown> {
  private listeners: F[] = [];

  addListener(callback: F): void {
    if (!this.listeners.includes(callback)) this.listeners.push(callback);
  }

  removeListener(callback: F): void {
    this.listeners = this.listeners.filter((listener) => listener !== callback);
  }

  hasListener(callback: F): boolean {
    return this.listeners.includes(callback);
  }

  hasListeners(): boolean {
    return this.listeners.length > 0;
  }

  /** Calls every listener in the order added; returns what they returned. */
  dispatch(...args: Parameters<F>): ReturnType<F>[] {
    return [...this.listeners].map((listener) => listener(...args) as ReturnType<F>);
  }
}

export type FakeStorageCall =
  | { method: "get"; keys: string[] | null }
  | { method: "set"; items: Record<string, unknown>; ok: boolean }
  | { method: "remove"; keys: string[]; ok: boolean }
  | { method: "clear" };

export interface FakeStorageOptions {
  /** Which Chrome area to imitate: the quota error's wording and limit rule. Default "session". */
  kind?: "session" | "local";
  /** Default QUOTA_BYTES, as both areas have (local without "unlimitedStorage"). */
  quotaBytes?: number;
  /** Items present from the start (not logged, no events). */
  initial?: Record<string, unknown>;
}

export class FakeStorageArea {
  readonly kind: "session" | "local";
  readonly quotaBytes: number;
  readonly onChanged = new FakeEvent<(changes: Record<string, StorageChange>) => void>();
  readonly calls: FakeStorageCall[] = [];
  /** Throw from here to make a set() reject; it then writes nothing. */
  beforeSet?: (items: Record<string, unknown>) => void;
  /** Throw from here to make a remove() reject; it then removes nothing. */
  beforeRemove?: (keys: string[]) => void;
  /** Key -> the value's JSON text and the bytes the item counts for. */
  private readonly items = new Map<string, { json: string; bytes: number }>();

  constructor({ kind = "session", quotaBytes = QUOTA_BYTES, initial = {} }: FakeStorageOptions = {}) {
    this.kind = kind;
    this.quotaBytes = quotaBytes;
    for (const [key, value] of Object.entries(initial)) this.items.set(key, item(key, value));
  }

  /** As chrome.storage: a key, a list of keys, an object of keys with defaults, or null for all. */
  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      this.calls.push({ method: "get", keys: null });
      for (const [key, { json }] of this.items) result[key] = JSON.parse(json);
      return result;
    }
    const defaults = typeof keys === "object" && !Array.isArray(keys) ? keys : {};
    const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    this.calls.push({ method: "get", keys: [...names] });
    for (const key of names) {
      const stored = this.items.get(key);
      if (stored !== undefined) result[key] = JSON.parse(stored.json);
      else if (Object.hasOwn(defaults, key)) result[key] = copy(defaults[key]);
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const call = { method: "set" as const, items: copy(items) as Record<string, unknown>, ok: false };
    this.calls.push(call);
    this.beforeSet?.(copy(items) as Record<string, unknown>);
    // As JSON: an undefined value is no value.
    const incoming = new Map<string, { json: string; bytes: number }>();
    for (const [key, value] of Object.entries(items)) if (value !== undefined) incoming.set(key, item(key, value));
    let usage = this.usage();
    for (const [key, next] of incoming) usage += next.bytes - (this.items.get(key)?.bytes ?? 0);
    if (this.kind === "session" ? usage >= this.quotaBytes : usage > this.quotaBytes) {
      throw new Error(this.kind === "session" ? SESSION_QUOTA_ERROR : LOCAL_QUOTA_ERROR);
    }
    const changes: Record<string, StorageChange> = {};
    for (const [key, next] of incoming) {
      const old = this.items.get(key);
      if (old?.json === next.json) continue;
      changes[key] = { ...(old === undefined ? {} : { oldValue: JSON.parse(old.json) }), newValue: JSON.parse(next.json) };
      this.items.set(key, next);
    }
    call.ok = true;
    if (Object.keys(changes).length > 0) this.onChanged.dispatch(changes);
  }

  async remove(keys: string | string[]): Promise<void> {
    const names = typeof keys === "string" ? [keys] : [...keys];
    const call = { method: "remove" as const, keys: names, ok: false };
    this.calls.push(call);
    this.beforeRemove?.([...names]);
    const changes: Record<string, StorageChange> = {};
    for (const key of names) {
      const old = this.items.get(key);
      if (old === undefined) continue;
      changes[key] = { oldValue: JSON.parse(old.json) };
      this.items.delete(key);
    }
    call.ok = true;
    if (Object.keys(changes).length > 0) this.onChanged.dispatch(changes);
  }

  async clear(): Promise<void> {
    this.calls.push({ method: "clear" });
    const changes: Record<string, StorageChange> = {};
    for (const [key, { json }] of this.items) changes[key] = { oldValue: JSON.parse(json) };
    this.items.clear();
    if (Object.keys(changes).length > 0) this.onChanged.dispatch(changes);
  }

  async getBytesInUse(keys?: string | string[] | null): Promise<number> {
    if (keys === null || keys === undefined) return this.usage();
    let total = 0;
    for (const key of typeof keys === "string" ? [keys] : keys) total += this.items.get(key)?.bytes ?? 0;
    return total;
  }

  async getKeys(): Promise<string[]> {
    return [...this.items.keys()];
  }

  // --- Synchronous helpers for assertions -------------------------------------------------

  /** A copy of everything stored now. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.items].map(([key, { json }]) => [key, JSON.parse(json)]));
  }

  keys(): string[] {
    return [...this.items.keys()];
  }

  usage(): number {
    let total = 0;
    for (const { bytes } of this.items.values()) total += bytes;
    return total;
  }

  /** Every item ever passed to set(), stored or not, as JSON text. */
  writtenText(): string {
    return this.calls
      .filter((call) => call.method === "set")
      .map((call) => JSON.stringify(call.items))
      .join("\n");
  }
}

function item(key: string, value: unknown): { json: string; bytes: number } {
  return { json: JSON.stringify(value), bytes: storedItemBytes(key, value) };
}

function copy(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
