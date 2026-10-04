// Content script entry (dist/content.js), isolated world on music.youtube.com.
import { mountLyricsButton } from "./lyricsButton";
import { getNowPlaying, stemFor } from "./nowPlaying";

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
  mountLyricsButton({ onClick: () => void logClick() });
  console.log(`${LOG_PREFIX} content script loaded`);
}

// Until the lyrics menu (B7b): shows what the files would be named after.
async function logClick(): Promise<void> {
  const nowPlaying = await getNowPlaying();
  const result = stemFor(nowPlaying);
  console.log(`${LOG_PREFIX} lyrics button clicked; now playing (from the ${nowPlaying.from}):`, result.stem !== null ? result.stem : result.reason);
}
