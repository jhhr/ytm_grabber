// The capture manager (PLAN.md section 3.3): reads Better Lyrics' lyrics stream and its Unison
// response through chrome.debugger, stores the capture and answers the content script over the
// `capture` port (shared/messages.ts).
//
// On demand (default): `start` -> attach -> Network.enable -> `ready` (the content script then
// clicks BL's refresh button) -> the first successful stream plus a short grace for Unison
// (networkWatcher.ts) -> detach, always, in a `finally` -> store -> `done`, or `error` at any
// point; 30 s overall. One capture per tab: a second `start` joins it, and when the last port
// that asked goes away the capture stops. Always attached (opt-in): every music.youtube.com tab
// stays attached with Network on and every stream is stored as it passes; a `start` then waits
// for the tab's next stream.
//
// Secrets (non-negotiable): BL's stream request body holds its Turnstile token and the Unison
// request an `x-key-id` header. Event params go straight to the watcher, which keeps only ids,
// paths, the video id and response data; reasons and log lines are fixed text plus numbers,
// Chrome's own error words and the video id, never request or response text.
//
// sw.ts registers the Chrome listeners at top level and forwards them here. Every Chrome API is
// injected so tests drive the manager with fakes (test/helpers/fakeDebugger.ts).

import { isVideoId } from "../shared/filenames";
import { isCapturePortRequest, type CapturePortReply } from "../shared/messages";
import type { CaptureMode, Settings, SettingsStore } from "../shared/settings";
import { byteLength } from "../shared/blRequests";
import { extractSources } from "../shared/sources";
import { parseSse } from "../shared/sse";
import { summarize, type CaptureSummary, type StoredCapture } from "../shared/summary";
import { NetworkWatcher, type CapturedStream, type Timers, type WatcherSink } from "./networkWatcher";
import type { CaptureStore } from "./store";

export const PROTOCOL_VERSION = "1.3";
/** Generous buffers so Chrome keeps a whole stream for Network.getResponseBody. */
export const NETWORK_ENABLE_PARAMS = { maxResourceBufferSize: 10 * 1024 * 1024, maxTotalBufferSize: 50 * 1024 * 1024 };
export const CAPTURE_TIMEOUT_MS = 30_000;
/** The tabs always-attached mode attaches to (a tabs.query pattern). */
export const YTM_TABS = "https://music.youtube.com/*";
const YTM_PREFIX = "https://music.youtube.com/";
const LOG_PREFIX = "[YTM Practice Grabber]";

const MODE_CHANGED = "The capture mode was changed; try again";
const BUSY = "A capture is running in this tab";
const STOPPED = "The capture was stopped";

// --- Seams: the slices of chrome.* the manager uses -------------------------------------------

export interface DebuggerTarget {
  tabId: number;
}

export interface DebuggerApi {
  attach(target: DebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: DebuggerTarget): Promise<void>;
  sendCommand(target: DebuggerTarget, method: string, commandParams?: { [key: string]: unknown }): Promise<unknown>;
  getTargets(): Promise<{ tabId?: number; attached: boolean; url: string }[]>;
}

export interface TabsApi {
  query(queryInfo: { url: string }): Promise<{ id?: number; url?: string }[]>;
}

/** The service worker's end of a `capture` port. */
export interface CapturePortLike {
  postMessage(message: CapturePortReply): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

export interface CaptureManagerDeps {
  debugger: DebuggerApi;
  tabs: TabsApi;
  store: Pick<CaptureStore, "put">;
  settings: Pick<SettingsStore, "getSettings">;
  log?: Pick<Console, "log" | "warn">;
  /** Milliseconds since the epoch (capturedAt, debug times). */
  now?: () => number;
  timers?: Timers;
}

/** Methods are bound: sw.ts passes them to addListener as they are. */
export interface CaptureManager {
  /** Reads the settings, detaches sessions an earlier service worker left, and in always mode attaches to the YTM tabs. */
  init(): Promise<void>;
  /** A `capture` port from the content script in `tabId`. */
  connect(port: CapturePortLike, tabId: number): void;
  /** chrome.debugger.onEvent */
  handleEvent(source: { tabId?: number }, method: string, params?: unknown): void;
  /** chrome.debugger.onDetach */
  handleDetach(source: { tabId?: number }, reason: string): void;
  /** chrome.tabs.onUpdated */
  handleTabUpdated(tabId: number, changeInfo: { status?: string }, tab: { url?: string }): void;
  /** SettingsStore.onSettingsChanged */
  settingsChanged(changed: Partial<Settings>): void;
  /** Dev helper: captures `tabId` (the user clicks BL's refresh button); resolves with the summary. */
  captureNow(tabId: number, videoId?: string): Promise<CaptureSummary>;
}

export function createCaptureManager(deps: CaptureManagerDeps): CaptureManager {
  return new Manager(deps);
}

/** An error whose message is meant for the user (it reaches the content script as `reason`). */
class CaptureError extends Error {
  /** Expected in normal operation: logged only in the debug log. */
  readonly quiet: boolean;

  constructor(message: string, quiet = false) {
    super(message);
    this.name = "CaptureError";
    this.quiet = quiet;
  }
}

/** Someone waiting for a capture: a port's content script, or captureNow(). */
interface Client {
  ready(): void;
  done(summary: CaptureSummary): void;
  error(reason: string): void;
  /** Its port disconnected. */
  gone: boolean;
}

type SessionKind = "on-demand" | "always";

interface SessionOwner extends WatcherSink {
  /** Chrome ended the session (Cancel on its debugging bar, tab closed); `reason` is for the user. */
  onDetached(reason: string): void;
}

interface Waiter {
  client: Client;
  videoId?: string;
  timer: unknown;
}

interface TabState {
  tabId: number;
  /** The debugger session on the tab, from attach until detached. */
  session?: DebugSession;
  /** The on-demand capture until it settles (joinable until then). */
  capture?: OnDemandCapture;
  /** Always mode: `start`s waiting for the tab's next stream. */
  waiters: Set<Waiter>;
  always?: AlwaysOwner;
  /** Sessions are opened one after another per tab. */
  queue: Promise<unknown>;
}

/** What sessions and captures use of the manager. */
interface Host {
  readonly debugger: DebuggerApi;
  readonly timers: Timers;
  now(): number;
  debug(message: string): void;
  warn(message: string): void;
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// --- One debugger session -----------------------------------------------------------------------

/** One chrome.debugger session on one tab, with the Network domain on and a watcher reading it. */
class DebugSession {
  readonly tabId: number;
  readonly kind: SessionKind;
  readonly owner: SessionOwner;
  readonly watcher: NetworkWatcher;
  private readonly target: DebuggerTarget;
  private readonly host: Host;
  private readonly onClosed: (session: DebugSession) => void;
  private attached = false;
  private adopted = false;
  private detachedByChrome = false;
  private attaching: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(tabId: number, kind: SessionKind, owner: SessionOwner, host: Host, onClosed: (session: DebugSession) => void) {
    this.tabId = tabId;
    this.kind = kind;
    this.owner = owner;
    this.host = host;
    this.onClosed = onClosed;
    this.target = { tabId };
    this.watcher = new NetworkWatcher(
      {
        command: (method, params) => host.debugger.sendCommand(this.target, method, params),
        timers: host.timers,
        now: () => host.now(),
        debug: (message) => host.debug(`tab ${tabId}: ${message}`),
      },
      owner,
    );
  }

  get isClosing(): boolean {
    return this.closing !== undefined;
  }

  /** Attaches (or takes over a session an earlier service worker left) and turns Network on. Throws a CaptureError. */
  async open(): Promise<void> {
    this.attaching = this.attach();
    await this.attaching;
    if (this.closing !== undefined) throw new CaptureError(STOPPED, true);
    if (!this.adopted) {
      try {
        await this.host.debugger.sendCommand(this.target, "Network.enable", NETWORK_ENABLE_PARAMS);
      } catch {
        throw new CaptureError("Could not start watching the tab's network requests");
      }
    }
    this.host.debug(`tab ${this.tabId}: ${this.adopted ? "took over the session an earlier service worker left" : "attached"}, Network on (${this.kind})`);
  }

  private async attach(): Promise<void> {
    try {
      await this.host.debugger.attach(this.target, PROTOCOL_VERSION);
      this.attached = true;
      return;
    } catch (error) {
      // A session an earlier service worker left open is still this extension's, and attaching
      // again fails with "Another debugger is already attached". Only the extension that attached
      // can send commands, so if one works the session is ours: take it over (Network is then on).
      try {
        await this.host.debugger.sendCommand(this.target, "Network.enable", NETWORK_ENABLE_PARAMS);
      } catch {
        throw new CaptureError(attachFailure(error));
      }
      this.attached = true;
      this.adopted = true;
    }
  }

  handleEvent(method: string, params: unknown): void {
    if (this.closing === undefined) this.watcher.handleEvent(method, params);
  }

  /** Chrome ended the session: no detach call is needed after this. */
  handleDetach(reason: string): void {
    if (this.detachedByChrome) return;
    this.detachedByChrome = true;
    this.host.debug(`tab ${this.tabId}: Chrome detached the debugger (${safeWord(reason)})`);
    if (this.closing === undefined) {
      // A stream already in hand is kept; only what was still to come is lost.
      this.watcher.flush();
      this.owner.onDetached(detachMessage(reason));
    }
    void this.close();
  }

  /** Detaches unless Chrome already did, after any attach still running has settled. Idempotent. */
  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    this.watcher.dispose();
    await this.attaching?.catch(() => undefined);
    if (this.attached && !this.detachedByChrome) {
      try {
        await this.host.debugger.detach(this.target);
        this.host.debug(`tab ${this.tabId}: detached`);
      } catch (error) {
        // "Debugger is not attached": Chrome detached it meanwhile, which is all we wanted.
        if (!/not attached/i.test(errorMessage(error))) this.host.warn(`could not detach the debugger from tab ${this.tabId}: ${errorMessage(error)}`);
      }
    }
    this.onClosed(this);
  }
}

// --- An on-demand capture -----------------------------------------------------------------------

class OnDemandCapture implements SessionOwner {
  readonly tab: TabState;
  private readonly manager: Manager;
  private readonly clients = new Set<Client>();
  private videoId: string | undefined;
  private settled = false;
  private isReady = false;
  private session: DebugSession | undefined;
  private stream: CapturedStream | undefined;
  private timer: unknown;
  private resolveStream: (stream: CapturedStream) => void = () => undefined;
  private readonly streamArrived: Promise<CapturedStream>;
  private stop: (error: CaptureError) => void = () => undefined;
  private readonly stopped: Promise<never>;

  constructor(manager: Manager, tab: TabState, videoId: string | undefined) {
    this.manager = manager;
    this.tab = tab;
    this.videoId = videoId;
    this.streamArrived = new Promise((resolve) => {
      this.resolveStream = resolve;
    });
    this.stopped = new Promise((_, reject) => {
      this.stop = reject;
    });
    // Raced only while the capture runs; a later stop needs no handler.
    this.stopped.catch(() => undefined);
  }

  join(client: Client, videoId: string | undefined): void {
    this.clients.add(client);
    this.videoId ??= videoId;
    if (this.isReady) client.ready();
  }

  leave(client: Client): void {
    if (!this.clients.delete(client) || this.clients.size > 0) return;
    // Nobody is waiting any more (the page navigated or closed): stop, which detaches.
    this.fail("The page that asked for the capture went away", true);
  }

  videoIdHint(): string | undefined {
    return this.videoId;
  }

  onCapture(stream: CapturedStream): void {
    // The first stream wins; the session is closed right after it.
    if (this.settled || this.stream !== undefined) return;
    this.stream = stream;
    this.manager.timers.clearTimeout(this.timer);
    this.resolveStream(stream);
  }

  onStreamFailed(reason: string): void {
    if (this.stream === undefined) this.fail(reason);
  }

  onDetached(reason: string): void {
    if (this.stream === undefined) this.fail(reason);
  }

  async run(): Promise<void> {
    const { manager } = this;
    this.timer = manager.timers.setTimeout(() => this.timedOut(), CAPTURE_TIMEOUT_MS);
    let session: DebugSession | undefined;
    try {
      session = await manager.acquire(this.tab, "on-demand", this);
      this.session = session;
      if (this.settled) return;
      this.isReady = true;
      for (const client of this.clients) client.ready();
      await Promise.race([this.streamArrived, this.stopped]);
    } catch (error) {
      this.fail(reasonOf(error), isQuiet(error));
    } finally {
      manager.timers.clearTimeout(this.timer);
      // Detach as soon as the stream is in hand (or the capture failed): storing needs no debugger.
      if (session !== undefined) await session.close();
      manager.afterOnDemand(this.tab);
    }
    if (this.stream === undefined || this.settled) return;
    let summary: CaptureSummary;
    try {
      summary = await manager.save(this.stream);
    } catch (error) {
      this.fail(reasonOf(error));
      return;
    }
    // Stored either way; only a client still there is told.
    if (this.settled) return;
    this.settle();
    for (const client of this.clients) client.done(summary);
  }

  private timedOut(): void {
    if (this.settled || this.stream !== undefined) return;
    const watcher = this.session?.watcher;
    // A stream in hand still waiting for Unison: finish without it.
    if (watcher?.flush()) return;
    if (watcher === undefined) this.fail("Attaching the debugger took longer than 30 s");
    else if (watcher.lastFailure !== undefined) this.fail(watcher.lastFailure);
    else this.fail(watcher.sawStreamRequest ? "The lyrics response did not finish within 30 s" : "Better Lyrics made no lyrics request within 30 s");
  }

  private fail(reason: string, quiet = false): void {
    if (this.settled) return;
    this.settle();
    if (quiet) this.manager.debug(`capture stopped: ${reason}`);
    else this.manager.warn(`capture failed: ${reason}`);
    for (const client of this.clients) client.error(reason);
    this.stop(new CaptureError(reason, quiet));
  }

  private settle(): void {
    this.settled = true;
    // From now on a `start` for this tab begins a new capture (after this one's session closes).
    if (this.tab.capture === this) this.tab.capture = undefined;
  }
}

// --- Always-attached mode -------------------------------------------------------------------------

/** Owns a tab's always-mode session: stores every stream and hands it to the waiting `start`s. */
class AlwaysOwner implements SessionOwner {
  private readonly manager: Manager;
  private readonly tab: TabState;

  constructor(manager: Manager, tab: TabState) {
    this.manager = manager;
    this.tab = tab;
  }

  videoIdHint(): string | undefined {
    for (const waiter of this.tab.waiters) if (waiter.videoId !== undefined) return waiter.videoId;
    return undefined;
  }

  onCapture(stream: CapturedStream): void {
    void this.manager.storePassive(this.tab, stream);
  }

  onStreamFailed(reason: string): void {
    this.manager.failWaiters(this.tab, reason);
  }

  onDetached(reason: string): void {
    this.manager.failWaiters(this.tab, reason);
  }
}

// --- The manager ---------------------------------------------------------------------------------

class Manager implements CaptureManager, Host {
  readonly debugger: DebuggerApi;
  readonly timers: Timers;
  private readonly tabsApi: TabsApi;
  private readonly store: Pick<CaptureStore, "put">;
  private readonly settings: Pick<SettingsStore, "getSettings">;
  private readonly log: Pick<Console, "log" | "warn">;
  private readonly clock: () => number;
  private readonly tabs = new Map<number, TabState>();
  private mode: CaptureMode = "on-demand";
  private debugOn = false;
  private loading: Promise<void> | undefined;

  constructor({ debugger: debuggerApi, tabs, store, settings, log = console, now = Date.now, timers = realTimers }: CaptureManagerDeps) {
    this.debugger = debuggerApi;
    this.tabsApi = tabs;
    this.store = store;
    this.settings = settings;
    this.log = log;
    this.clock = now;
    this.timers = timers;
  }

  now(): number {
    return this.clock();
  }

  debug(message: string): void {
    if (this.debugOn) this.log.log(`${LOG_PREFIX} capture: ${message}`);
  }

  warn(message: string): void {
    this.log.warn(`${LOG_PREFIX} capture: ${message}`);
  }

  // --- Chrome listeners (bound) ---

  readonly init = async (): Promise<void> => {
    await this.ready();
    if (this.mode === "always") await this.attachAll();
  };

  readonly connect = (port: CapturePortLike, tabId: number): void => {
    const client = portClient(port);
    port.onMessage.addListener((message) => {
      if (!isCapturePortRequest(message)) {
        this.warn("ignored a malformed capture message");
        return;
      }
      this.startFor(tabId, message.videoId, client);
    });
    port.onDisconnect.addListener(() => this.leave(tabId, client));
  };

  readonly handleEvent = (source: { tabId?: number }, method: string, params?: unknown): void => {
    if (source.tabId === undefined) return;
    this.tabs.get(source.tabId)?.session?.handleEvent(method, params);
  };

  readonly handleDetach = (source: { tabId?: number }, reason: string): void => {
    if (source.tabId === undefined) return;
    this.tabs.get(source.tabId)?.session?.handleDetach(reason);
  };

  readonly handleTabUpdated = (tabId: number, changeInfo: { status?: string }, tab: { url?: string }): void => {
    if (changeInfo.status !== "complete") return;
    const onYtm = isYtmUrl(tab.url);
    void this.ready().then(() => {
      if (this.mode !== "always") return;
      if (onYtm) {
        this.ensureAlways(this.tab(tabId)).catch((error: unknown) => this.attachFailed(tabId, error));
        return;
      }
      // Navigated away from YouTube Music: let go of it.
      const state = this.tabs.get(tabId);
      if (state?.session?.kind === "always") {
        this.failWaiters(state, "The tab left YouTube Music");
        void state.session.close();
      }
    });
  };

  readonly settingsChanged = (changed: Partial<Settings>): void => {
    void this.ready().then(() => this.applySettings(changed));
  };

  readonly captureNow = (tabId: number, videoId?: string): Promise<CaptureSummary> => {
    if (!Number.isInteger(tabId)) return Promise.reject(new TypeError("captureNow(tabId, videoId?): tabId must be a tab id"));
    if (videoId !== undefined && !isVideoId(videoId)) return Promise.reject(new TypeError("captureNow(tabId, videoId?): not a video id"));
    return new Promise((resolve, reject) => {
      const client: Client = {
        gone: false,
        ready: () => this.log.log(`${LOG_PREFIX} Attached to tab ${tabId}: click Better Lyrics' refresh button (in its lyrics dock) now.`),
        done: resolve,
        error: (reason) => reject(new CaptureError(reason)),
      };
      this.startFor(tabId, videoId, client);
    });
  };

  // --- Settings and modes ---

  /** Settings read and stale sessions swept; everything else waits for this. Never rejects. */
  private ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      const settings = await this.settings.getSettings();
      this.mode = settings.captureMode;
      this.debugOn = settings.debugCapture;
    } catch {
      this.warn("could not read the settings; capturing on demand");
    }
    await this.sweep();
  }

  /**
   * A service worker that stopped while attached leaves its session open, and Chrome's debugging
   * bar with it. Detach every tab this extension may hold, except the YouTube Music tabs that
   * always-attached mode keeps (attachAll() takes those over, see DebugSession.attach()). A
   * detach only ever touches this extension's own session; for any other it fails, harmlessly.
   */
  private async sweep(): Promise<void> {
    let targets: Awaited<ReturnType<DebuggerApi["getTargets"]>>;
    try {
      targets = await this.debugger.getTargets();
    } catch {
      return;
    }
    await Promise.all(
      targets.map(async ({ tabId, attached, url }) => {
        if (!attached || tabId === undefined) return;
        if (this.mode === "always" && isYtmUrl(url)) return;
        if (this.tabs.get(tabId)?.session !== undefined) return;
        try {
          await this.debugger.detach({ tabId });
          this.debug(`detached the session an earlier service worker left on tab ${tabId}`);
        } catch {
          // Not ours (DevTools, another extension) or already gone.
        }
      }),
    );
  }

  private applySettings(changed: Partial<Settings>): void {
    if (changed.debugCapture !== undefined) this.debugOn = changed.debugCapture;
    const mode = changed.captureMode;
    if (mode === undefined || mode === this.mode) return;
    this.mode = mode;
    if (mode === "always") {
      void this.attachAll();
      return;
    }
    // On demand: every always-attached tab lets go, and `start`s waiting on one are told.
    for (const tab of this.tabs.values()) {
      this.failWaiters(tab, MODE_CHANGED);
      if (tab.session?.kind === "always") void tab.session.close();
    }
  }

  private async attachAll(): Promise<void> {
    let tabs: { id?: number }[];
    try {
      tabs = await this.tabsApi.query({ url: YTM_TABS });
    } catch {
      return;
    }
    await Promise.all(
      tabs.map(async ({ id }) => {
        if (id === undefined) return;
        await this.ensureAlways(this.tab(id)).catch((error: unknown) => this.attachFailed(id, error));
      }),
    );
  }

  private attachFailed(tabId: number, error: unknown): void {
    if (isQuiet(error)) this.debug(`tab ${tabId} not attached: ${reasonOf(error)}`);
    else this.warn(`could not attach to tab ${tabId}: ${reasonOf(error)}`);
  }

  // --- Sessions ---

  private tab(tabId: number): TabState {
    let state = this.tabs.get(tabId);
    if (state === undefined) {
      state = { tabId, waiters: new Set(), queue: Promise.resolve() };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  /**
   * An open session on the tab for `owner`, one tab at a time. Always mode reuses the tab's open
   * always-mode session. Whatever session is left on the tab (an ended capture's, or always
   * mode's after a switch to on demand) is closed first, but never a running capture's.
   */
  acquire(tab: TabState, kind: SessionKind, owner: SessionOwner): Promise<DebugSession> {
    const task = async (): Promise<DebugSession> => {
      if (kind === "always") {
        if (this.mode !== "always") throw new CaptureError(MODE_CHANGED, true);
        const current = tab.session;
        if (current?.kind === "always" && !current.isClosing) return current;
        // afterOnDemand() attaches this way once that capture is over.
        if (current !== undefined && tab.capture !== undefined && current.owner === tab.capture) throw new CaptureError(BUSY, true);
      }
      if (tab.session !== undefined) await tab.session.close();
      const session = new DebugSession(tab.tabId, kind, owner, this, (closed) => {
        if (tab.session === closed) tab.session = undefined;
      });
      tab.session = session;
      try {
        await session.open();
        if (kind === "always" && this.mode !== "always") throw new CaptureError(MODE_CHANGED, true);
        return session;
      } catch (error) {
        await session.close();
        throw error;
      }
    };
    const result = tab.queue.then(task);
    tab.queue = result.catch(() => undefined);
    return result;
  }

  private ensureAlways(tab: TabState): Promise<DebugSession> {
    tab.always ??= new AlwaysOwner(this, tab);
    return this.acquire(tab, "always", tab.always);
  }

  /** After an on-demand capture's session closed: back to always-attached if the mode changed meanwhile. */
  afterOnDemand(tab: TabState): void {
    if (this.mode === "always") this.ensureAlways(tab).catch((error: unknown) => this.attachFailed(tab.tabId, error));
  }

  // --- Captures ---

  /** start(), which handles its own failures; anything unexpected still reaches the client. */
  private startFor(tabId: number, videoId: string | undefined, client: Client): void {
    this.start(tabId, videoId, client).catch((error: unknown) => {
      this.warn(`capture failed unexpectedly: ${reasonOf(error)}`);
      client.error(reasonOf(error));
    });
  }

  private async start(tabId: number, videoId: string | undefined, client: Client): Promise<void> {
    await this.ready();
    if (client.gone) return;
    const tab = this.tab(tabId);
    if (tab.capture !== undefined) {
      tab.capture.join(client, videoId);
      return;
    }
    if (this.mode === "always") {
      await this.waitForNextStream(tab, videoId, client);
      return;
    }
    const capture = new OnDemandCapture(this, tab, videoId);
    tab.capture = capture;
    capture.join(client, videoId);
    await capture.run();
  }

  private leave(tabId: number, client: Client): void {
    client.gone = true;
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return;
    tab.capture?.leave(client);
    for (const waiter of tab.waiters) {
      if (waiter.client !== client) continue;
      this.timers.clearTimeout(waiter.timer);
      tab.waiters.delete(waiter);
    }
  }

  /** Always mode: `ready` at once (once attached), then the tab's next stream. */
  private async waitForNextStream(tab: TabState, videoId: string | undefined, client: Client): Promise<void> {
    try {
      await this.ensureAlways(tab);
    } catch (error) {
      client.error(reasonOf(error));
      return;
    }
    if (client.gone) return;
    const waiter: Waiter = { client, ...(videoId === undefined ? {} : { videoId }), timer: undefined };
    // (The watcher's lastFailure is not used here: in this mode it may be an earlier song's.)
    waiter.timer = this.timers.setTimeout(() => {
      if (tab.waiters.delete(waiter)) client.error("No lyrics stream from Better Lyrics within 30 s");
    }, CAPTURE_TIMEOUT_MS);
    tab.waiters.add(waiter);
    client.ready();
  }

  async storePassive(tab: TabState, stream: CapturedStream): Promise<void> {
    // The waiters now get this capture; a `start` from here on waits for the next one.
    const waiters = [...tab.waiters];
    tab.waiters.clear();
    for (const waiter of waiters) this.timers.clearTimeout(waiter.timer);
    let summary: CaptureSummary;
    try {
      summary = await this.save(stream);
    } catch (error) {
      this.warn(`could not store a capture: ${reasonOf(error)}`);
      for (const waiter of waiters) waiter.client.error(reasonOf(error));
      return;
    }
    for (const waiter of waiters) waiter.client.done(summary);
  }

  failWaiters(tab: TabState, reason: string): void {
    for (const waiter of tab.waiters) {
      this.timers.clearTimeout(waiter.timer);
      waiter.client.error(reason);
    }
    tab.waiters.clear();
  }

  /** Stores the stream under its own video id (which may not be the one asked for) and summarises it. */
  async save(stream: CapturedStream): Promise<CaptureSummary> {
    const { videoId, rawStream, bodySource, unisonRaw } = stream;
    if (videoId === undefined) throw new CaptureError("Could not tell which video the lyrics are for");
    const { metadata, sources } = extractSources(parseSse(rawStream), unisonRaw);
    const capture: StoredCapture = { videoId, capturedAt: this.now(), metadata, rawStream, bodySource };
    if (unisonRaw !== undefined) capture.unisonRaw = unisonRaw;
    await this.store.put(capture);
    this.debug(
      `stored a capture: ${sources.length} sources, body from ${bodySource}, ${byteLength(rawStream)} B` +
        (unisonRaw === undefined ? ", no Unison" : `, Unison ${byteLength(unisonRaw)} B`),
    );
    return summarize(capture, sources);
  }
}

// --- Helpers ---------------------------------------------------------------------------------------

function portClient(port: CapturePortLike): Client {
  const post = (message: CapturePortReply) => {
    try {
      port.postMessage(message);
    } catch {
      // Disconnected meanwhile: nobody to tell.
    }
  };
  return {
    gone: false,
    ready: () => post({ type: "ready" }),
    done: (summary) => post({ type: "done", summary }),
    error: (reason) => post({ type: "error", reason }),
  };
}

function isYtmUrl(url: string | undefined): boolean {
  return url !== undefined && url.startsWith(YTM_PREFIX);
}

function attachFailure(error: unknown): string {
  const message = errorMessage(error);
  if (/already attached/i.test(message)) {
    return "Another debugger is already attached to this tab. Close other debugging tools on it (or reload the tab) and try again.";
  }
  return `Could not attach the debugger to this tab: ${message}`;
}

function detachMessage(reason: string): string {
  switch (reason) {
    case "canceled_by_user":
      return "Debugging was cancelled (Cancel on Chrome's debugging bar)";
    case "target_closed":
      return "The tab was closed or navigated away";
    default:
      return `The debugger was detached from the tab (${safeWord(reason)})`;
  }
}

/** Chrome's detach reasons are words; anything else is not echoed. */
function safeWord(value: string): string {
  return /^[a-z_]{1,40}$/i.test(value) ? value : "unknown reason";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reason a client is told: a CaptureError's or the store's message (both are ours), else a generic one. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "The capture failed";
}

function isQuiet(error: unknown): boolean {
  return error instanceof CaptureError && error.quiet;
}
