// Launches the Chromium that Playwright 1.56.1 installed (/opt/pw-browsers, found through
// PLAYWRIGHT_BROWSERS_PATH) with dist/ loaded as an unpacked extension, the three mock hosts
// mapped to the local server, and a download folder of its own.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { MOCK_HOSTS } from "./certs";

export const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

export interface ExtensionBrowser {
  context: BrowserContext;
  /** The extension's service worker. */
  sw: Worker;
  extensionId: string;
  /** Chrome's download folder in this profile. */
  downloadDir: string;
  close(): Promise<void>;
}

export async function launchWithExtension({ port, workDir }: { port: number; workDir: string }): Promise<ExtensionBrowser> {
  const userDataDir = path.join(workDir, "profile");
  const downloadDir = path.join(workDir, "downloads");
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
  // The download folder is the profile's own setting, as in a user's Chrome.
  writeFileSync(
    path.join(userDataDir, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } }),
  );

  // Linux Chromium takes its proxy from these variables, and a proxied request never meets
  // --host-resolver-rules: leave them out (and say --no-proxy-server). Under the C locale
  // Chromium refuses every non-ASCII download file name.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(https?|all|no)_proxy$/i.test(key)) env[key] = value;
  }
  env.LANG = "C.UTF-8";

  const context = await chromium.launchPersistentContext(userDataDir, {
    // The full Chromium build (headless shell cannot load extensions), in new headless mode.
    channel: "chromium",
    headless: true,
    env,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--no-proxy-server",
      `--host-resolver-rules=${MOCK_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(", ")}`,
      "--ignore-certificate-errors",
    ],
  });
  try {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent("serviceworker");
    const extensionId = new URL(sw.url()).host;

    // Playwright sets Browser.setDownloadBehavior "allowAndName": files saved under GUID names in
    // its own artifacts folder (and the extension then learns that folder). "default" gives the
    // downloads back to Chrome, which names them as chrome.downloads asked, in the profile's folder.
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    await cdp.detach();

    return { context, sw, extensionId, downloadDir, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Opens (or navigates `page` to) the mock watch page of `videoId`; `song` sets the title and artist YTM shows. */
export async function openWatchPage(page: Page, videoId: string, song: { title?: string; artist?: string } = {}): Promise<void> {
  const query = new URLSearchParams({ v: videoId, ...song });
  await page.goto(`https://music.youtube.com/watch?${query}`);
}
