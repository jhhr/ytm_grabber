// chrome.runtime's native messaging for tests (B10). connectNative() hands out FakePorts (the
// code under test holds one end, the test plays the host with reply() and exit()); as in Chrome,
// `lastError` is set only while a port's onDisconnect listeners run. sendNativeMessage is a mock
// the test gives a reply or a rejection.

import { vi } from "vitest";
import type { NativeMessagingApi } from "../../src/background/audio";
import { FakePort } from "./fakePort";

export class FakeNative implements NativeMessagingApi {
  /** Every port opened, oldest first. */
  readonly ports: FakePort[] = [];
  readonly connectNative = vi.fn((application: string) => {
    const port = new FakePort(application);
    this.ports.push(port);
    return port;
  });
  readonly sendNativeMessage = vi.fn(async (_application: string, _message: unknown): Promise<unknown> => undefined);
  private lastErrorMessage: string | undefined;

  lastError(): string | undefined {
    return this.lastErrorMessage;
  }

  /** The newest port. */
  get port(): FakePort {
    return this.ports.at(-1)!;
  }

  /** The ports still connected. */
  open(): FakePort[] {
    return this.ports.filter((port) => port.connected);
  }

  /** The host posts `message`. */
  reply(message: unknown, port: FakePort = this.port): void {
    port.deliver(message);
  }

  /** The host's end goes away; Chrome's lastError reads `message` while onDisconnect runs. */
  exit(message?: string, port: FakePort = this.port): void {
    this.lastErrorMessage = message;
    try {
      port.remoteDisconnect();
    } finally {
      this.lastErrorMessage = undefined;
    }
  }
}
