import { describe, expect, it, vi } from "vitest";
import { isQuotaError, storedItemBytes } from "../src/shared/storageArea";
import { FakeStorageArea, LOCAL_QUOTA_ERROR, QUOTA_BYTES, SESSION_QUOTA_ERROR } from "./helpers/fakeStorage";

// The fake is what the store's quota handling is tested against, so its own rules are checked here.
describe("FakeStorageArea", () => {
  it("counts key + JSON in UTF-8 and has Chrome's 10 MiB quota by default", async () => {
    const area = new FakeStorageArea();
    await area.set({ "k\u{E9}": "\u{E9}\"" });
    // key: 1 + 2 bytes; JSON text: quote, e-acute (2 bytes), backslash-quote, quote = 6 bytes
    expect(area.usage()).toBe(3 + 6);
    expect(area.usage()).toBe(storedItemBytes("k\u{E9}", "\u{E9}\""));
    expect(await area.getBytesInUse(null)).toBe(9);
    expect(area.quotaBytes).toBe(QUOTA_BYTES);
  });

  it("session: rejects a write that would reach the quota, with Chrome's Error, writing none of its items", async () => {
    const area = new FakeStorageArea({ quotaBytes: storedItemBytes("a", "x") + storedItemBytes("b", "y") });
    await area.set({ a: "x" });
    const write = area.set({ b: "y", c: "" });
    await expect(write).rejects.toThrow(new Error(SESSION_QUOTA_ERROR));
    await write.catch((error: unknown) => expect(error).toBeInstanceOf(Error));
    expect(area.snapshot()).toEqual({ a: "x" });
    // Exactly at the quota is also refused; one byte below it is not.
    await expect(area.set({ b: "y" })).rejects.toThrow(SESSION_QUOTA_ERROR);
    await area.set({ b: "" });
    expect(area.snapshot()).toEqual({ a: "x", b: "" });
  });

  it("local: allows usage up to the quota and words the error as the local area does", async () => {
    const area = new FakeStorageArea({ kind: "local", quotaBytes: storedItemBytes("a", "xy") });
    await area.set({ a: "xy" });
    await expect(area.set({ a: "xyz" })).rejects.toThrow(LOCAL_QUOTA_ERROR);
    expect(area.snapshot()).toEqual({ a: "xy" });
  });

  it("counts a replaced item once", async () => {
    const area = new FakeStorageArea({ quotaBytes: storedItemBytes("a", "12345") + 1 });
    await area.set({ a: "12345" });
    await area.set({ a: "54321" });
    expect(area.snapshot()).toEqual({ a: "54321" });
  });

  it("returns copies, gets by key, keys or defaults, and removes", async () => {
    const area = new FakeStorageArea({ initial: { a: { n: 1 }, b: 2 } });
    const got = await area.get("a");
    (got.a as { n: number }).n = 99;
    expect(await area.get(["a", "missing"])).toEqual({ a: { n: 1 } });
    expect(await area.get({ b: 0, c: "default" })).toEqual({ b: 2, c: "default" });
    expect(await area.get(null)).toEqual({ a: { n: 1 }, b: 2 });
    await area.remove(["a", "missing"]);
    expect(area.keys()).toEqual(["b"]);
  });

  it("fires onChanged for changed keys only, with old and new values", async () => {
    const area = new FakeStorageArea({ initial: { a: 1 } });
    const listener = vi.fn();
    area.onChanged.addListener(listener);
    await area.set({ a: 1, b: 2 });
    await area.set({ a: 3 });
    await area.remove("b");
    expect(listener.mock.calls).toEqual([[{ b: { newValue: 2 } }], [{ a: { oldValue: 1, newValue: 3 } }], [{ b: { oldValue: 2 } }]]);
  });

  it("logs every write, failed ones too, and lets a test make a call fail", async () => {
    const area = new FakeStorageArea();
    area.beforeSet = (items) => {
      if ("bad" in items) throw new Error("injected");
    };
    await area.set({ good: "secret-1" });
    await expect(area.set({ bad: "secret-2" })).rejects.toThrow("injected");
    expect(area.snapshot()).toEqual({ good: "secret-1" });
    expect(area.writtenText()).toContain("secret-1");
    expect(area.writtenText()).toContain("secret-2");
    expect(area.calls.filter((call) => call.method === "set").map((call) => call.ok)).toEqual([true, false]);
  });

  it("isQuotaError() recognises both of Chrome's wordings and nothing else", () => {
    expect(isQuotaError(new Error(SESSION_QUOTA_ERROR))).toBe(true);
    expect(isQuotaError(new Error(LOCAL_QUOTA_ERROR))).toBe(true);
    expect(isQuotaError(new Error("Extension context invalidated."))).toBe(false);
    expect(isQuotaError(SESSION_QUOTA_ERROR)).toBe(false);
  });
});
