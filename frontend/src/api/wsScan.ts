import type { Mutation } from "../contracts/history";
import { CONTRACT_VERSION, type Base4 } from "../contracts/ingest";
import {
  decodeFrame, type ServerMsg, type TelemetryFrame, type WsAnomalyAlert, type WsError, type WsHelloAck, type WsMutationResult,
  type WsProgress, type WsScanComplete, type WsScanReady, type WsStartScan,
} from "../contracts/ws";
import { ManagedSocket, wsUrl, type CloseInfo, type SocketState, type WebSocketCtor } from "./socket";

export interface ScanHandlers {
  onReady?(m: WsScanReady): void;
  onFrame?(f: TelemetryFrame): void | Promise<void>;
  onAlert?(m: WsAnomalyAlert): void;
  onProgress?(m: WsProgress): void;
  onComplete?(m: WsScanComplete): void;
  onMutation?(m: WsMutationResult): void;
  onError?(m: WsError): void;
  onPong?(rttMs: number): void;
  onState?(s: SocketState): void;
  onClose?(info: CloseInfo): void;
  onReconnected?(ack: WsHelloAck): void;
  onProtocolError?(e: Error): void;
}

export interface ScanClientOptions {
  url?: string;
  WebSocketImpl?: WebSocketCtor;
  clientName?: string;
  pingIntervalMs?: number;
  maxMissedPongs?: number;
  autoReconnect?: boolean;
  backoffMs?: readonly number[];
  mutationTimeoutMs?: number;
  handlers?: ScanHandlers;
}

export class ScanClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ScanClientError";
    this.code = code;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const isThenable = (x: unknown): x is Promise<void> => typeof x === "object" && x !== null && typeof (x as { then?: unknown }).then === "function";

export type StartScanRequest = Omit<WsStartScan, "type">;

export class ScanClient {
  helloAck: WsHelloAck | null = null;
  rttMs: number | null = null;
  private handlers: ScanHandlers;
  private readonly sock: ManagedSocket;
  private readonly opts: ScanClientOptions;
  private hello: Deferred<WsHelloAck> | null = null;
  private lastStart: StartScanRequest | null = null;
  private scanDone = true;
  private queue: TelemetryFrame[] = [];
  private draining = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private lastPingAt = 0;
  private seq = 0;
  private readonly pending = new Map<string, { d: Deferred<Mutation>; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: ScanClientOptions = {}) {
    this.opts = options;
    this.handlers = options.handlers ?? {};
    this.sock = new ManagedSocket({
      url: options.url ?? (() => wsUrl("/ws/scan")),
      ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
      ...(options.autoReconnect !== undefined ? { autoReconnect: options.autoReconnect } : {}),
      ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
      onOpen: (reconnected) => this.handleOpen(reconnected),
      onMessage: (d) => this.handleMessage(d),
      onClose: (info) => this.handleClose(info),
      onStateChange: (s) => this.handlers.onState?.(s),
    });
  }

  get state(): SocketState { return this.sock.state; }
  setHandlers(h: ScanHandlers): void { this.handlers = h; }

  connect(): Promise<WsHelloAck> {
    if (this.helloAck && this.sock.isOpen) return Promise.resolve(this.helloAck);
    if (!this.hello) this.hello = deferred<WsHelloAck>();
    this.sock.open();
    return this.hello.promise;
  }

  startScan(req: StartScanRequest): void {
    this.lastStart = req;
    this.scanDone = false;
    this.sendJson({ type: "start_scan", ...req });
  }

  stop(): void {
    this.scanDone = true;
    this.sendJson({ type: "stop" });
  }

  checkpoint(scanId: string, lastScannedPos: number): void {
    this.sendJson({ type: "checkpoint", scan_id: scanId, last_scanned_pos: Math.max(0, Math.floor(lastScannedPos)) });
  }

  ping(): void {
    this.lastPingAt = Date.now();
    this.sendJson({ type: "ping", t: this.lastPingAt });
  }

  mutate(scanId: string, position: number, alt: Base4, requestId = this.newRequestId()): string {
    this.sendJson({ type: "mutate", request_id: requestId, scan_id: scanId, position, alt });
    return requestId;
  }

  mutateAsync(scanId: string, position: number, alt: Base4): Promise<Mutation> {
    const id = this.newRequestId();
    const d = deferred<Mutation>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      d.reject(new ScanClientError("TIMEOUT", `mutation ${id} timed out`));
    }, this.opts.mutationTimeoutMs ?? 15_000);
    this.pending.set(id, { d, timer });
    try {
      this.mutate(scanId, position, alt, id);
    } catch (e) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw e;
    }
    return d.promise;
  }

  close(): void {
    this.stopPing();
    this.sock.close(1000, "client closed");
    this.rejectPending(new ScanClientError("CLOSED", "client closed"));
  }

  private newRequestId(): string { return `m${++this.seq}-${Date.now().toString(36)}`; }
  private sendJson(msg: object): void { this.sock.send(JSON.stringify(msg)); }

  private handleOpen(reconnected: boolean): void {
    this.hello ??= deferred<WsHelloAck>();
    this.sendJson({ type: "hello", contract: CONTRACT_VERSION, client: this.opts.clientName ?? "web" });
    this.reconnectedPending = reconnected;
  }
  private reconnectedPending = false;

  private handleClose(info: CloseInfo): void {
    this.stopPing();
    this.helloAck = null;
    this.queue.length = 0;
    this.handlers.onClose?.(info);
    if (!info.willReconnect) {
      const err = new ScanClientError(`CLOSED_${info.code}`, `socket closed (${info.code} ${info.reason})`.trim());
      this.hello?.reject(err);
      this.hello = null;
      this.rejectPending(err);
    }
  }

  private rejectPending(err: Error): void {
    for (const { d, timer } of this.pending.values()) {
      clearTimeout(timer);
      d.reject(err);
    }
    this.pending.clear();
  }

  private startPing(): void {
    this.stopPing();
    this.missedPongs = 0;
    const every = this.opts.pingIntervalMs ?? 15_000;
    const max = this.opts.maxMissedPongs ?? 3;
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= max) {
        this.stopPing();
        this.sock.close(4408, "pong timeout");
        return;
      }
      this.missedPongs++;
      try { this.ping(); } catch {}
    }, every);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      let frame: TelemetryFrame;
      try { frame = decodeFrame(data); } catch (e) { this.handlers.onProtocolError?.(e as Error); return; }
      this.queue.push(frame);
      void this.drain();
      return;
    }
    let msg: ServerMsg;
    try { msg = JSON.parse(data) as ServerMsg; } catch (e) { this.handlers.onProtocolError?.(e as Error); return; }
    switch (msg.type) {
      case "hello_ack":
        this.helloAck = msg;
        this.startPing();
        this.hello?.resolve(msg);
        this.hello = null;
        if (this.reconnectedPending) {
          this.reconnectedPending = false;
          if (this.lastStart && !this.scanDone) this.sendJson({ type: "start_scan", ...this.lastStart });
          this.handlers.onReconnected?.(msg);
        }
        break;
      case "scan_ready": this.handlers.onReady?.(msg); break;
      case "anomaly_alert": this.handlers.onAlert?.(msg); break;
      case "progress": this.handlers.onProgress?.(msg); break;
      case "scan_complete": this.scanDone = true; this.handlers.onComplete?.(msg); break;
      case "mutation_result":
        const p = this.pending.get(msg.request_id);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.request_id); p.d.resolve(msg.mutation); }
        this.handlers.onMutation?.(msg);
        break;
      case "error":
        const rid = msg.error.detail?.["request_id"];
        const p2 = typeof rid === "string" ? this.pending.get(rid) : undefined;
        if (p2 && typeof rid === "string") { clearTimeout(p2.timer); this.pending.delete(rid); p2.d.reject(new ScanClientError(msg.error.code, msg.error.message)); }
        if (msg.fatal) { this.hello?.reject(new ScanClientError(msg.error.code, msg.error.message)); this.hello = null; }
        this.handlers.onError?.(msg);
        break;
      case "pong":
        this.missedPongs = 0;
        this.rttMs = Date.now() - msg.t;
        this.handlers.onPong?.(this.rttMs);
        break;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const f = this.queue.shift()!;
        try {
          const r = this.handlers.onFrame?.(f);
          if (isThenable(r)) await r;
        } catch (e) { this.handlers.onProtocolError?.(e as Error); }
        try { this.sendJson({ type: "ack", stream_seq: f.streamSeq }); } catch { this.queue.length = 0; }
      }
    } finally { this.draining = false; }
  }
}
