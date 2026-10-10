// A chrome.runtime.Port stand-in (B5b): the end the code under test holds. The test plays the
// other end with deliver() and remoteDisconnect(). As in Chrome, messages are JSON copies,
// posting on a disconnected port throws, and disconnect() on this end fires no onDisconnect here.

import { FakeEvent } from "./fakeStorage";

export interface FakePortSender {
  tab?: { id?: number };
  url?: string;
}

export class FakePort {
  readonly name: string;
  readonly sender?: FakePortSender;
  readonly onMessage = new FakeEvent<(message: unknown, port: FakePort) => void>();
  readonly onDisconnect = new FakeEvent<(port: FakePort) => void>();
  /** What the code under test posted, as copies, in order. */
  readonly posted: unknown[] = [];
  connected = true;

  constructor(name: string, sender?: FakePortSender) {
    this.name = name;
    if (sender !== undefined) this.sender = sender;
  }

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error("Attempting to use a disconnected port object");
    this.posted.push(JSON.parse(JSON.stringify(message)));
  }

  disconnect(): void {
    this.connected = false;
  }

  /** The other end posts `message`. */
  deliver(message: unknown): void {
    if (this.connected) this.onMessage.dispatch(JSON.parse(JSON.stringify(message)), this);
  }

  /** The other end goes away (its page navigated or closed). */
  remoteDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.onDisconnect.dispatch(this);
  }

  /** The types of the posted messages, e.g. ["ready", "done"]. */
  types(): string[] {
    return this.posted.map((message) => (message as { type: string }).type);
  }
}
