import { create } from "zustand";
import type { AnomalyRegion, Mutation } from "../contracts/history";
import type { Base4, ErrorBody, Molecule } from "../contracts/ingest";
import {
  CHANNEL, FRAME_TYPE, N_CHANNELS, type EvServerNotice, type EvWatcherStatus, type ModelScopeLike, type TelemetryFrame,
  type WsAnomalyAlert, type WsError, type WsProgress, type WsScanComplete, type WsScanReady,
} from "../contracts/ws";
import type { ScanHandlers, StartScanRequest } from "../api/wsScan";
import type { EventHandlers } from "../api/wsEvents";
import { DEFAULT_MORPH, MAX_WINDOW_BP, MIN_WINDOW_BP, type MorphOptions } from "../canvas/helixMath";
import type { LoadedWorkbench } from "../db/repo";

export type ScanStatus = "idle" | "connecting" | "analyzing" | "streaming" | "complete" | "error";

export interface ActiveSequence {
  sha256: string; scanId: string | null; codes: Uint8Array; length: number; molecule: Molecule; display: string;
}

export interface Overview {
  binSize: number; bins: number; channelIds: number[]; planes: (Float32Array | null)[];
}

export interface HudState {
  cvdPalette: boolean; reducedMotion: boolean; audio: boolean; view: "2d" | "3d"; tracks: Record<string, boolean>;
}
export interface HeadRef { pos: number; }
export interface OpenSequenceInput {
  sha256: string; scanId?: string | null; codes: Uint8Array; molecule: Molecule; display: string;
  planes?: (Float32Array | null)[]; regions?: AnomalyRegion[]; mutations?: Mutation[]; headPos?: number;
}

export interface ScanClientLike {
  connect(): Promise<unknown>;
  startScan(req: StartScanRequest): void; stop(): void; checkpoint(scanId: string, lastScannedPos: number): void;
  mutateAsync(scanId: string, position: number, alt: Base4): Promise<Mutation>;
  setHandlers(h: ScanHandlers): void;
}

export interface HelixServices { scan: ScanClientLike | null; persistMutation: ((m: Mutation) => Promise<void> | void) | null; checkpointDelayMs: number; }
const services: HelixServices = { scan: null, persistMutation: null, checkpointDelayMs: 1500 };
export function configureHelixServices(s: Partial<HelixServices>): void { Object.assign(services, s); }

export interface HelixState {
  active: ActiveSequence | null; status: ScanStatus; cache: "HIT" | "MISS" | null; paramsHash: string | null; modelScope: ModelScopeLike | null;
  scanError: ErrorBody | null; notices: ErrorBody[]; progress: number; filledUpTo: number; anomalyCount: number; durationMs: number | null;
  channelIds: number[]; planes: (Float32Array | null)[]; overview: Overview | null; regions: AnomalyRegion[]; mutations: Mutation[];
  pendingBase: number | null; selectedBase: number | null; hoveredBase: number | null; heatDomain: { min: number; max: number };
  headRef: HeadRef; headPos: number; speedBps: number; playing: boolean; windowBp: number; hud: HudState; morph: MorphOptions; morphVersion: number;
  watcher: EvWatcherStatus | null; lastHistoryRev: number;

  openSequence(input: OpenSequenceInput): void; closeSequence(): void; startScan(opts?: { force?: boolean; want?: number[] }): Promise<void>;
  stopScan(): void; beginScan(ready: WsScanReady): void; applyFrame(frame: TelemetryFrame): void; setProgress(p: WsProgress): void;
  addRegion(a: WsAnomalyAlert): void; completeScan(m: WsScanComplete): void; setScanError(e: WsError): void; seek(pos: number): void;
  tick(dtSec: number, nowMs: number): void; setPlaying(p: boolean): void; setSpeed(bps: number): void; setWindowBp(bp: number): void;
  selectBase(i: number | null): void; hoverBase(i: number | null): void; mutateBase(position: number, alt: Base4): Promise<Mutation>;
  addMutation(m: Mutation): void; removeMutation(id: string): void; setMorph(m: Partial<MorphOptions>): void; toggleCvd(): void;
  setReducedMotion(v: boolean): void; setTrack(name: string, on: boolean): void; setWatcherStatus(s: EvWatcherStatus): void;
  pushNotice(e: ErrorBody): void; setLastHistoryRev(rev: number): void;
}

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const emptyPlanes = (): (Float32Array | null)[] => new Array<Float32Array | null>(N_CHANNELS).fill(null);

export function detectReducedMotion(): boolean {
  try { return typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

export function percentileDomain(a: Float32Array | null | undefined, lo = 0.02, hi = 0.98, maxSamples = 20_000): { min: number; max: number } {
  if (!a || a.length === 0) return { min: 0, max: 1 };
  const stride = Math.max(1, Math.floor(a.length / maxSamples));
  const v: number[] = [];
  for (let i = 0; i < a.length; i += stride) {
    const x = a[i]!; if (x === x) v.push(x);
  }
  if (v.length === 0) return { min: 0, max: 1 };
  v.sort((p, q) => p - q);
  const min = v[Math.floor(lo * (v.length - 1))]!;
  const max = v[Math.floor(hi * (v.length - 1))]!;
  return max > min ? { min, max } : { min, max: min + 1 };
}

const initialHud = (): HudState => ({
  cvdPalette: false, reducedMotion: detectReducedMotion(), audio: false, view: "2d",
  tracks: { gc: true, tm: true, dg: true, attention: true, promoter: true, cpg: true, splice: true, anomaly: true },
});

let lastSnapshotMs = 0;
let cpTimer: ReturnType<typeof setTimeout> | null = null;

export const useHelixStore = create<HelixState>()((set, get) => {
  function flushCheckpoint(): void {
    cpTimer = null; const s = get();
    if (!services.scan || !s.active?.scanId) return;
    try { services.scan.checkpoint(s.active.scanId, Math.floor(s.headRef.pos)); } catch {}
  }
  function scheduleCheckpoint(): void {
    if (!services.scan || !get().active?.scanId) return;
    if (cpTimer) clearTimeout(cpTimer);
    cpTimer = setTimeout(flushCheckpoint, services.checkpointDelayMs);
  }

  return {
    active: null, status: "idle", cache: null, paramsHash: null, modelScope: null, scanError: null, notices: [], progress: 0,
    filledUpTo: 0, anomalyCount: 0, durationMs: null, channelIds: [], planes: emptyPlanes(), overview: null, regions: [], mutations: [],
    pendingBase: null, selectedBase: null, hoveredBase: null, heatDomain: { min: 0, max: 1 }, headRef: { pos: 0 }, headPos: 0,
    speedBps: 50, playing: false, windowBp: 40, hud: initialHud(), morph: { ...DEFAULT_MORPH }, morphVersion: 0, watcher: null, lastHistoryRev: 0,

    openSequence(input) {
      const L = input.codes.length; const planes = input.planes ? input.planes.slice() : emptyPlanes();
      while (planes.length < N_CHANNELS) planes.push(null);
      const hasData = planes.some((p) => p !== null);
      const head = clamp(input.headPos ?? 0, 0, Math.max(0, L - 1));
      const ref = get().headRef; ref.pos = head;
      set((s) => ({
        active: { sha256: input.sha256, scanId: input.scanId ?? null, codes: input.codes, length: L, molecule: input.molecule, display: input.display },
        status: hasData ? "complete" : "idle", cache: null, paramsHash: null, modelScope: null, scanError: null, progress: hasData ? 1 : 0,
        filledUpTo: hasData ? L : 0, anomalyCount: input.regions?.length ?? 0, durationMs: null,
        channelIds: planes.flatMap((p, i) => (p ? [i] : [])), planes, overview: null, regions: input.regions ?? [],
        mutations: input.mutations ?? [], pendingBase: null, selectedBase: null, hoveredBase: null,
        heatDomain: percentileDomain(planes[CHANNEL.tm_c]), headPos: head, playing: false, morphVersion: s.morphVersion + 1,
      }));
    },
    closeSequence() {
      if (cpTimer) clearTimeout(cpTimer); cpTimer = null; get().headRef.pos = 0;
      set((s) => ({
        active: null, status: "idle", cache: null, paramsHash: null, scanError: null, progress: 0, filledUpTo: 0, anomalyCount: 0,
        channelIds: [], planes: emptyPlanes(), overview: null, regions: [], mutations: [], selectedBase: null, hoveredBase: null,
        pendingBase: null, headPos: 0, playing: false, morphVersion: s.morphVersion + 1,
      }));
    },
    async startScan(opts = {}) {
      const s = get(); if (!s.active) throw new Error("no active sequence");
      const client = services.scan; if (!client) throw new Error("no scan client configured");
      set({ status: "connecting", scanError: null });
      await client.connect();
      set({ status: "analyzing" });
      client.startScan({
        sha256: s.active.sha256, window_bp: get().windowBp, speed_bps: get().speedBps,
        ...(opts.want ? { want: opts.want } : {}), ...(opts.force ? { force_recompute: true } : {}),
      });
    },
    stopScan() {
      try { services.scan?.stop(); } catch {}
      if (get().status === "streaming" || get().status === "analyzing" || get().status === "connecting") set({ status: "idle" });
    },
    beginScan(ready) {
      const a = get().active;
      if (!a || ready.sha256 !== a.sha256) return;
      if (ready.length !== a.length) { set({ status: "error", scanError: { code: "PROTOCOL_ERROR", message: `server length ${ready.length} != local length ${a.length}` } }); return; }
      const planes = emptyPlanes();
      for (const c of ready.channels) planes[c.id] = new Float32Array(a.length).fill(NaN);
      set((s) => ({
        status: "streaming", cache: ready.cache, paramsHash: ready.params_hash, modelScope: ready.model_scope ?? null, scanError: null,
        channelIds: ready.channels.map((c) => c.id), planes, overview: null, regions: [], anomalyCount: 0, filledUpTo: 0, progress: 0,
        durationMs: null, heatDomain: { min: 0, max: 1 }, morphVersion: s.morphVersion + 1,
      }));
    },
    applyFrame(frame) {
      const s = get(); const a = s.active;
      if (!a || s.channelIds.length === 0) return;
      const ids = s.channelIds;
      if (frame.channelCount !== ids.length) { set({ status: "error", scanError: { code: "PROTOCOL_ERROR", message: `frame has ${frame.channelCount} channels, expected ${ids.length}` } }); return; }
      const n = frame.count;
      if (frame.frameType === FRAME_TYPE.OVERVIEW) {
        const planes = emptyPlanes();
        ids.forEach((id, row) => { planes[id] = frame.planes.subarray(row * n, (row + 1) * n); });
        set({ overview: { binSize: frame.startPos, bins: n, channelIds: ids.slice(), planes } });
        return;
      }
      const start = frame.startPos; const copy = Math.max(0, Math.min(n, a.length - start));
      for (let row = 0; row < ids.length; row++) {
        const dst = s.planes[ids[row]!];
        if (dst) dst.set(frame.planes.subarray(row * n, row * n + copy), start);
      }
      const upTo = start + copy;
      if (upTo > s.filledUpTo) set({ filledUpTo: upTo });
    },
    setProgress(p) { set({ progress: p.fraction }); },
    addRegion(a) { set((s) => (s.regions.some((r) => r.start === a.start && r.end === a.end) ? s : { regions: [...s.regions, { start: a.start, end: a.end, score: a.score, kind: a.kind }] })); },
    completeScan(m) {
      const s = get();
      set({ status: "complete", progress: 1, anomalyCount: m.anomaly_count, durationMs: m.duration_ms, heatDomain: percentileDomain(s.planes[CHANNEL.tm_c]) });
    },
    setScanError(e) {
      if (e.fatal) set({ status: "error", scanError: e.error });
      else get().pushNotice(e.error);
    },
    seek(pos) {
      const a = get().active; if (!a) return;
      const p = clamp(pos, 0, Math.max(0, a.length - 1));
      get().headRef.pos = p; set({ headPos: p });
      scheduleCheckpoint();
    },
    tick(dt, now) {
      const s = get(); if (!s.active || !s.playing) return;
      const last = s.active.length - 1;
      const limit = s.status === "streaming" ? Math.min(s.filledUpTo, last) : last;
      const next = s.headRef.pos + s.speedBps * dt;
      const p = next > limit ? limit : next;
      s.headRef.pos = p;
      const atEnd = p >= last && s.status !== "streaming";
      if (atEnd) { set({ headPos: p, playing: false }); scheduleCheckpoint(); }
      else if (now - lastSnapshotMs >= 100) { lastSnapshotMs = now; set({ headPos: p }); }
    },
    setPlaying(p) { if (!get().active) return; set({ playing: p, headPos: get().headRef.pos }); if (!p) scheduleCheckpoint(); },
    setSpeed(bps) { set({ speedBps: clamp(bps, 1, 2000) }); },
    setWindowBp(bp) { set({ windowBp: clamp(Math.round(bp / 2) * 2, MIN_WINDOW_BP, MAX_WINDOW_BP) }); },
    selectBase(i) { const a = get().active; set({ selectedBase: i === null || !a || i < 0 || i >= a.length ? null : i }); },
    hoverBase(i) { if (get().hoveredBase !== i) set({ hoveredBase: i }); },
    async mutateBase(position, alt) {
      const s = get();
      if (!s.active?.scanId) throw new Error("mutations need a scan id (open the sequence from History or ingest it first)");
      if (!services.scan) throw new Error("no scan client configured");
      set({ pendingBase: position });
      try {
        const m = await services.scan.mutateAsync(s.active.scanId, position, alt);
        get().addMutation(m);
        await services.persistMutation?.(m);
        return m;
      } catch (e) { get().pushNotice({ code: "INTERNAL", message: `mutation failed: ${(e as Error).message}` }); throw e; }
      finally { set({ pendingBase: null }); }
    },
    addMutation(m) { set((s) => (s.mutations.some((x) => x.mutation_id === m.mutation_id) ? s : { mutations: [...s.mutations, m] })); },
    removeMutation(id) { set((s) => ({ mutations: s.mutations.filter((m) => m.mutation_id !== id) })); },
    setMorph(m) { set((s) => ({ morph: { ...s.morph, ...m }, morphVersion: s.morphVersion + 1 })); },
    toggleCvd() { set((s) => ({ hud: { ...s.hud, cvdPalette: !s.hud.cvdPalette } })); },
    setReducedMotion(v) { set((s) => ({ hud: { ...s.hud, reducedMotion: v } })); },
    setTrack(name, on) { set((s) => ({ hud: { ...s.hud, tracks: { ...s.hud.tracks, [name]: on } } })); },
    setWatcherStatus(w) { set({ watcher: w }); },
    pushNotice(e) { set((s) => (s.notices.some((n) => n.code === e.code && n.message === e.message) ? s : { notices: [...s.notices.slice(-9), e] })); },
    setLastHistoryRev(rev) { set({ lastHistoryRev: rev }); },
  };
});

export function openFromWorkbench(w: LoadedWorkbench, scanId: string | null, headPos = 0): void {
  useHelixStore.getState().openSequence({
    sha256: w.sha256, scanId, codes: w.codes, molecule: w.molecule, display: w.display,
    ...(w.tensors ? { planes: w.tensors.planes, regions: w.tensors.regions } : {}), mutations: w.mutations, headPos,
  });
}

export function bindScanClient(client: Pick<ScanClientLike, "setHandlers">): () => void {
  const s = () => useHelixStore.getState();
  client.setHandlers({
    onReady: (m) => s().beginScan(m), onFrame: (f) => s().applyFrame(f), onAlert: (m) => s().addRegion(m),
    onProgress: (m) => s().setProgress(m), onComplete: (m) => s().completeScan(m), onError: (m) => s().setScanError(m),
    onMutation: (m) => s().addMutation(m.mutation),
    onClose: (info) => { if (!info.willReconnect && s().status === "streaming") s().setScanError({ type: "error", fatal: true, error: { code: "INTERNAL", message: `connection closed (${info.code})` } }); },
  });
  return () => client.setHandlers({});
}

export function bindEventsClient(client: { setHandlers(h: EventHandlers): void }, extra: EventHandlers = {}): () => void {
  const s = () => useHelixStore.getState();
  client.setHandlers({
    ...extra,
    onWatcherStatus: (w) => { s().setWatcherStatus(w); extra.onWatcherStatus?.(w); },
    onHistoryChanged: (rev) => { s().setLastHistoryRev(rev); extra.onHistoryChanged?.(rev); },
    onNotice: (n: EvServerNotice) => { s().pushNotice({ code: "INTERNAL", message: n.message }); extra.onNotice?.(n); },
  });
  return () => client.setHandlers({});
}

export function resetHelixStore(): void {
  if (cpTimer) clearTimeout(cpTimer);
  cpTimer = null; lastSnapshotMs = 0; services.scan = null; services.persistMutation = null; services.checkpointDelayMs = 1500;
  useHelixStore.setState(
    {
      active: null, status: "idle", cache: null, paramsHash: null, modelScope: null, scanError: null, notices: [], progress: 0,
      filledUpTo: 0, anomalyCount: 0, durationMs: null, channelIds: [], planes: emptyPlanes(), overview: null, regions: [], mutations: [],
      pendingBase: null, selectedBase: null, hoveredBase: null, heatDomain: { min: 0, max: 1 }, headRef: { pos: 0 }, headPos: 0,
      speedBps: 50, playing: false, windowBp: 40, hud: initialHud(), morph: { ...DEFAULT_MORPH }, morphVersion: 0, watcher: null, lastHistoryRev: 0,
    }, false
  );
}
