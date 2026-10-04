import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Manifest {
  manifest_version: number;
  key: string;
  icons: Record<string, string>;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string; type: string };
  content_scripts: { matches: string[]; js?: string[]; css?: string[]; world?: string; run_at?: string }[];
  options_ui: { page: string; open_in_tab: boolean };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const staticManifestText = readFileSync(path.join(root, "static", "manifest.json"), "utf8");
const manifest: Manifest = JSON.parse(staticManifestText);
const outdir = mkdtempSync(path.join(tmpdir(), "ytm-build-"));

beforeAll(() => {
  const result = spawnSync(process.execPath, [path.join(root, "build.mjs"), "--outdir", outdir], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}, 60_000);
afterAll(() => rmSync(outdir, { recursive: true, force: true }));

describe("build output", () => {
  it("copies the manifest unchanged", () => {
    expect(readFileSync(path.join(outdir, "manifest.json"), "utf8")).toBe(staticManifestText);
  });

  it("contains every file the manifest references", () => {
    const referenced = [
      manifest.background.service_worker,
      ...manifest.content_scripts.flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]),
      manifest.options_ui.page,
      ...Object.values(manifest.icons),
    ];
    expect(referenced).toHaveLength(9);
    for (const file of referenced) expect(existsSync(path.join(outdir, file)), file).toBe(true);
  });

  it("contains every file options.html loads", () => {
    const html = readFileSync(path.join(outdir, "options.html"), "utf8");
    const loaded = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(loaded).toContain("options.js");
    for (const file of loaded) expect(existsSync(path.join(outdir, file)), file).toBe(true);
  });

  it("bundles the content scripts and the options script as classic scripts", () => {
    for (const file of ["content.js", "page-bridge.js", "options.js"]) {
      expect(readFileSync(path.join(outdir, file), "utf8"), file).not.toMatch(/^\s*(import|export)\b/m);
    }
  });

  it("has PNG icons of the declared sizes", () => {
    for (const [size, file] of Object.entries(manifest.icons)) {
      const png = readFileSync(path.join(outdir, file));
      expect(png.subarray(0, 8).toString("hex"), file).toBe("89504e470d0a1a0a");
      expect(png.subarray(12, 16).toString("ascii"), file).toBe("IHDR");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], file).toEqual([Number(size), Number(size)]);
    }
  });
});

describe("static/manifest.json", () => {
  it("declares exactly what spec 3.1 lists, plus icons and no toolbar action", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["debugger", "downloads", "nativeMessaging", "storage"]);
    expect(manifest.host_permissions).toEqual(["https://music.youtube.com/*"]);
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest.content_scripts).toEqual([
      { matches: ["https://music.youtube.com/*"], js: ["page-bridge.js"], world: "MAIN", run_at: "document_idle" },
      { matches: ["https://music.youtube.com/*"], js: ["content.js"], css: ["content.css"], run_at: "document_idle" },
    ]);
    expect(manifest.options_ui).toEqual({ page: "options.html", open_in_tab: true });
    expect(Object.keys(manifest.icons)).toEqual(["16", "32", "48", "128"]);
    expect(manifest).not.toHaveProperty("action");
    expect(manifest.key).toMatch(/^[A-Za-z0-9+/]{100,}={0,2}$/);
  });
});
