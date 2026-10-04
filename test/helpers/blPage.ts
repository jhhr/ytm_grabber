// Better Lyrics' page parts in jsdom, built the way BL 3.0.0.4 builds them (PLAN.md 1.4;
// src/modules/ui/dom.ts mountDock(), mountVotingSegment(), unmountDock(), createLyricsWrapper()).

/** `#page > #main-panel + #side-panel > #tab-renderer`, appended to the body. */
export function addPlayerPage(doc: Document = document): { page: HTMLElement; mainPanel: HTMLElement; sidePanel: HTMLElement } {
  const page = doc.createElement("div");
  page.id = "page";
  const mainPanel = doc.createElement("div");
  mainPanel.id = "main-panel";
  const sidePanel = doc.createElement("div");
  sidePanel.id = "side-panel";
  const tabRenderer = doc.createElement("div");
  tabRenderer.id = "tab-renderer";
  tabRenderer.setAttribute("page-type", "MUSIC_PAGE_TYPE_TRACK_LYRICS");
  sidePanel.append(tabRenderer);
  page.append(mainPanel, sidePanel);
  doc.body.append(page);
  return { page, mainPanel, sidePanel };
}

/** A fresh control set: source name, a toggle and the refresh button. */
export function buildControls(doc: Document = document, sourceName = "Better Lyrics"): HTMLElement {
  const controls = doc.createElement("div");
  controls.className = "blyrics-dock__controls";
  const source = doc.createElement("div");
  source.className = "blyrics-dock__source";
  const name = doc.createElement("span");
  name.className = "blyrics-dock__source-name";
  name.textContent = sourceName;
  source.append(name);
  const toggle = doc.createElement("button");
  toggle.className = "blyrics-dock__control";
  const refresh = doc.createElement("button");
  refresh.className = "blyrics-dock__control blyrics-dock__refresh";
  controls.append(source, toggle, refresh);
  return controls;
}

/**
 * BL's mountDock(): makes `.blyrics-dock > .blyrics-dock__inner` in `#side-panel` if there is none,
 * then replaces the controls (`replaceWith`) or prepends them. `controls: false` mounts the dock
 * with an empty inner, as no song has loaded yet.
 */
export function mountDock({ doc = document, position = "bottom-right", controls = true }: { doc?: Document; position?: string; controls?: boolean } = {}): HTMLElement {
  let dock = doc.querySelector<HTMLElement>(".blyrics-dock");
  if (!dock) {
    dock = doc.createElement("div");
    dock.className = "blyrics-dock";
    const inner = doc.createElement("div");
    inner.className = "blyrics-dock__inner";
    dock.append(inner);
    doc.querySelector("#side-panel")!.append(dock);
  }
  dock.dataset.position = position;
  const inner = dock.querySelector<HTMLElement>(".blyrics-dock__inner")!;
  if (controls) {
    const fresh = buildControls(doc);
    const existing = inner.querySelector(".blyrics-dock__controls");
    if (existing) existing.replaceWith(fresh);
    else inner.prepend(fresh);
  }
  return inner;
}

/** BL's mountVotingSegment() for Unison lyrics: appended to the inner. */
export function mountVoting(doc: Document = document): HTMLElement {
  const voting = doc.createElement("div");
  voting.className = "blyrics-dock__voting";
  doc.querySelector(".blyrics-dock__inner")!.append(voting);
  return voting;
}

export function unmountDock(doc: Document = document): void {
  doc.querySelector(".blyrics-dock")?.remove();
}

/** BL's rendered lyrics: `#blyrics-wrapper > .blyrics-container > div` in the tab renderer. */
export function showLyrics(doc: Document = document): HTMLElement {
  let wrapper = doc.querySelector<HTMLElement>("#blyrics-wrapper");
  if (!wrapper) {
    wrapper = doc.createElement("div");
    wrapper.id = "blyrics-wrapper";
    doc.querySelector("#tab-renderer")!.append(wrapper);
  }
  const container = doc.createElement("div");
  container.className = "blyrics-container";
  const line = doc.createElement("div");
  line.textContent = "Paper kites go north tonight";
  container.append(line);
  wrapper.replaceChildren(container);
  return container;
}

/** BL clearing its lyrics on a song change: the wrapper stays, emptied. */
export function clearLyrics(doc: Document = document): void {
  doc.querySelector("#blyrics-wrapper")?.replaceChildren();
}
