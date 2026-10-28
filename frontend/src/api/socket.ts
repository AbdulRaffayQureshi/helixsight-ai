export type SocketState = "idle" | "connecting" | "open" | "closing" | "closed" | "reconnecting";

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface CloseInfo {
  code: number;
  reason: string;
  willReconnect: boolean;
}

export interface ManagedSocketOptions {
  url: string | (() => string);
  WebSocketImpl?: WebSocketCtor;
  autoReconnect?: boolean;
  backoffMs?: readonly number[];
  fatalCloseCodes?: readonly number[];
  onOpen?: (reconnected: boolean) => void;
  onMessage?: (data: string | ArrayBuffer) => void;
  onClose?: (info: CloseInfo) => void;
  onStateChange?: (state: SocketState) => void;
}

export class SocketNotOpenError extends Error {
  constructor() {
    super("WebSocket is not open");
    this.name = "SocketNotOpenError";
  }
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 15000];
export const DEFAULT_FATAL_CODES: readonly number[] = [1000, 4400, 4403];

export function wsUrl(path: string, loc: { protocol: string; host: string } | undefined = globalThis.location): string {
  if (!loc) throw new Error("no location available: pass an explicit WebSocket url");
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${path}`;
}

export class ManagedSocket {
  state: SocketState = "idle";
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private userClosed = false;
  private everOpened = false;
  private readonly o: ManagedSocketOptions;

  constructor(options: ManagedSocketOptions) { this.o = options; }

  get isOpen(): boolean { return this.ws !== null && this.ws.readyState === 1; }

  open(): void {
    if (this.ws || this.timer) return;
    this.userClosed = false;
    this.dial();
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (!this.ws || this.ws.readyState !== 1) throw new SocketNotOpenError();
    this.ws.send(data);
  }

  close(code = 1000, reason = ""): void {
    this.userClosed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ws) {
      this.setState("closing");
      this.ws.close(code, reason);
    } else {
      this.setState("closed");
    }
  }

  private setState(s: SocketState): void {
    if (this.state !== s) {
      this.state = s;
      this.o.onStateChange?.(s);
    }
  }

  private dial(): void {
    this.setState(this.everOpened ? "reconnecting" : "connecting");
    const Impl = this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    const ws = new Impl(typeof this.o.url === "function" ? this.o.url() : this.o.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.setState("open");
      this.o.onOpen?.(reconnected);
    };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === "string") this.o.onMessage?.(d);
      else if (d instanceof ArrayBuffer) this.o.onMessage?.(d);
      else if (ArrayBuffer.isView(d)) this.o.onMessage?.(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      const fatal = (this.o.fatalCloseCodes ?? DEFAULT_FATAL_CODES).includes(ev.code);
      const willReconnect = !this.userClosed && (this.o.autoReconnect ?? true) && !fatal;
      this.setState(willReconnect ? "reconnecting" : "closed");
      this.o.onClose?.({ code: ev.code, reason: ev.reason, willReconnect });
      if (willReconnect) {
        const backoff = this.o.backoffMs ?? DEFAULT_BACKOFF_MS;
        const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 1000;
        this.attempt++;
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.userClosed) this.dial();
        }, delay);
      }
    };
  }
}
