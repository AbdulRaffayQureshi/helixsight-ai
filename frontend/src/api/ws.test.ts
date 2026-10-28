import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, HelixApi } from "./client";
import type { WebSocketLike } from "./socket";
import { ScanClient, ScanClientError } from "./wsScan";
import { EventsClient } from "./wsEvents";
import type { TelemetryFrame } from "../contracts/ws";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  binaryType = "blob";
  readyState = 0;
  sent: string[] = [];
  closedWith: [number | undefined, string | undefined] | null = null;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(d: string | ArrayBufferLike | ArrayBufferView): void { this.sent.push(d as string); }
  close(code = 1000, reason = ""): void { this.readyState = 3; this.onclose?.({ code, reason, wasClean: true }); }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  server(data: unknown): void { this.onmessage?.({ data: typeof data === "object" && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data }); }
  drop(code = 1006): void { this.readyState = 3; this.onclose?.({ code, reason: "", wasClean: false }); }
  json(): Record<string, unknown>[] { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>); }
}
const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

const ACK = { type: "hello_ack", session_id: "s", contract: 1, core_version: "0.1.0", model_version: "m" };

beforeEach(() => { FakeSocket.instances = []; });
afterEach(() => { vi.useRealTimers(); });

describe("ScanClient", () => {
  it("sending while closed throws", () => {
    const c = new ScanClient({ url: "ws://t", WebSocketImpl: FakeSocket });
    expect(() => c.startScan({ sha256: "a" })).toThrow(/not open/);
  });
});
