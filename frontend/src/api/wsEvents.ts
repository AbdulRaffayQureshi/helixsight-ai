import type { IngestItem } from "../contracts/history";
import type { EvServerNotice, EvWatcherStatus, EventMsg } from "../contracts/ws";
import { ManagedSocket, wsUrl, type CloseInfo, type SocketState, type WebSocketCtor } from "./socket";

export interface EventHandlers {
  onIngestComplete?(item: IngestItem): void;
  onHistoryChanged?(latestRev: number): void;
  onWatcherStatus?(s: EvWatcherStatus): void;
  onNotice?(n: EvServerNotice): void;
  onState?(s: SocketState): void;
  onClose?(info: CloseInfo): void;
  onSyncError?(e: unknown): void;
}

export interface SyncerLike {
  sync(): Promise<unknown>;
}

export interface EventsClientOptions {
  url?: string;
  WebSocketImpl?: WebSocketCtor;
  syncer?: SyncerLike;
  syncDebounceMs?: number;
  backoffMs?: readonly number[];
  handlers?: EventHandlers;
}

export class EventsClient {
  private handlers: EventHandlers;
  private readonly sock: ManagedSocket;
  private readonly o: EventsClientOptions;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EventsClientOptions = {}) {
    this.o = options;
    this.handlers = options.handlers ?? {};
    this.sock = new ManagedSocket({
      url: options.url ?? (() => wsUrl("/ws/events")),
      ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
      ...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
      onOpen: () => this.scheduleSync(0),
      onMessage: (d) => typeof d === "string" && this.handle(d),
      onClose: (info) => this.handlers.onClose?.(info),
      onStateChange: (s) => this.handlers.onState?.(s),
    });
  }

  get state(): SocketState { return this.sock.state; }
  setHandlers(h: EventHandlers): void { this.handlers = h; }
  connect(): void { this.sock.open(); }
  close(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.sock.close(1000, "client closed");
  }

  private scheduleSync(delay = this.o.syncDebounceMs ?? 150): void {
    const syncer = this.o.syncer;
    if (!syncer) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      syncer.sync().catch((e: unknown) => this.handlers.onSyncError?.(e));
    }, delay);
  }

  private handle(raw: string): void {
    let msg: EventMsg;
    try { msg = JSON.parse(raw) as EventMsg; } catch { return; }
    switch (msg.type) {
      case "history_changed": this.handlers.onHistoryChanged?.(msg.latest_rev); this.scheduleSync(); break;
      case "ingest_complete": this.handlers.onIngestComplete?.(msg.item); this.scheduleSync(); break;
      case "watcher_status": this.handlers.onWatcherStatus?.(msg); break;
      case "server_notice": this.handlers.onNotice?.(msg); break;
    }
  }
}
