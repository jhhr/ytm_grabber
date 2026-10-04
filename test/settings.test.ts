import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSettingsStore, DEFAULT_SETTINGS, type Settings } from "../src/shared/settings";
import type { ObservableStorageArea, StorageAreaLike } from "../src/shared/storageArea";
import { FakeStorageArea } from "./helpers/fakeStorage";

function setup(initial: Record<string, unknown> = {}) {
  const area = new FakeStorageArea({ kind: "local", initial });
  return { area, settings: createSettingsStore(area) };
}

describe("settings", () => {
  it("defaults to on-demand capture, no subfolder, no override, no debug log, no learned folder", async () => {
    expect(DEFAULT_SETTINGS).toEqual({
      captureMode: "on-demand",
      perSongSubfolder: false,
      downloadDirOverride: "",
      debugCapture: false,
      learnedDownloadDir: "",
    });
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(await setup().settings.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("merges stored values over the defaults", async () => {
    const { settings } = setup({ captureMode: "always", learnedDownloadDir: "C:\\Users\\me\\Downloads" });
    expect(await settings.getSettings()).toEqual({ ...DEFAULT_SETTINGS, captureMode: "always", learnedDownloadDir: "C:\\Users\\me\\Downloads" });
  });

  it("ignores stored values of the wrong type and keys it does not know", async () => {
    const { settings } = setup({
      captureMode: "sometimes",
      perSongSubfolder: "true",
      downloadDirOverride: 42,
      debugCapture: 1,
      learnedDownloadDir: null,
      somethingElse: "x",
    });
    expect(await settings.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("returns a fresh object each time", async () => {
    const { settings } = setup();
    const first = await settings.getSettings();
    first.captureMode = "always";
    expect((await settings.getSettings()).captureMode).toBe("on-demand");
  });

  it("writes only the settings given, one item each", async () => {
    const { area, settings } = setup({ learnedDownloadDir: "D:\\dl" });
    await settings.setSettings({ perSongSubfolder: true, captureMode: undefined });
    expect(area.snapshot()).toEqual({ learnedDownloadDir: "D:\\dl", perSongSubfolder: true });
    expect(await settings.getSettings()).toEqual({ ...DEFAULT_SETTINGS, perSongSubfolder: true, learnedDownloadDir: "D:\\dl" });
    await settings.setSettings({});
    expect(area.calls.filter((call) => call.method === "set")).toHaveLength(1);
  });

  it("refuses unknown keys and values of the wrong type, writing nothing", async () => {
    const { area, settings } = setup();
    await expect(settings.setSettings({ captureMode: "sometimes" } as unknown as Partial<Settings>)).rejects.toThrow(TypeError);
    await expect(settings.setSettings({ debugCapture: true, perSongSubfolder: "yes" } as unknown as Partial<Settings>)).rejects.toThrow(TypeError);
    await expect(settings.setSettings({ debugCapture: true, colour: "red" } as unknown as Partial<Settings>)).rejects.toThrow("Unknown setting: colour");
    expect(area.keys()).toEqual([]);
  });

  it("reports changed settings with their new values, defaults for removed or wrong ones", async () => {
    const { area, settings } = setup({ captureMode: "always" });
    const callback = vi.fn();
    const unsubscribe = settings.onSettingsChanged(callback);

    await settings.setSettings({ debugCapture: true, learnedDownloadDir: "/home/me/Downloads" });
    await area.remove("captureMode");
    await area.set({ perSongSubfolder: "yes" });
    await area.set({ unrelated: 1 });
    expect(callback.mock.calls).toEqual([
      [{ debugCapture: true, learnedDownloadDir: "/home/me/Downloads" }],
      [{ captureMode: "on-demand" }],
      [{ perSongSubfolder: false }],
    ]);

    unsubscribe();
    expect(area.onChanged.hasListeners()).toBe(false);
    await settings.setSettings({ debugCapture: false });
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("takes Chrome's storage areas as they are (compile-time check)", () => {
    expectTypeOf<typeof chrome.storage.local>().toExtend<ObservableStorageArea>();
    expectTypeOf<typeof chrome.storage.session>().toExtend<StorageAreaLike>();
    expectTypeOf<FakeStorageArea>().toExtend<ObservableStorageArea>();
  });
});
