import type { Base4, ErrorBody } from "./ingest";
import type { AnomalyKind, IngestItem, ModelScope, Mutation } from "./history";

export interface ChannelInfo {
  id: number;
  name: string;
  unit: string;
  min: number;
  max: number;
}

export const CHANNEL = {
  gc_pct: 0,
  gc_skew: 1,
  tm_c: 2,
  dg_kcal: 3,
  z_propensity: 4,
  cgr_x: 5,
  cgr_y: 6,
  attention: 7,
  p_promoter: 8,
  p_cpg_island: 9,
  p_splice_donor: 10,
  p_splice_acceptor: 11,
  anomaly_score: 12,
} as const;
export type ChannelName = keyof typeof CHANNEL;
export type ChannelId = (typeof CHANNEL)[ChannelName];
export const N_CHANNELS = 13 as const;
export const DEFAULT_WANT: readonly number[] = Array.from({ length: N_CHANNELS }, (_, i) => i);

export const CHANNELS: readonly ChannelInfo[] = [
  { id: 0, name: "gc_pct", unit: "%", min: 0, max: 100 },
  { id: 1, name: "gc_skew", unit: "(G-C)/(G+C)", min: -1, max: 1 },
  { id: 2, name: "tm_c", unit: "degC", min: 0, max: 120 },
  { id: 3, name: "dg_kcal", unit: "kcal/mol", min: -60, max: 0 },
  { id: 4, name: "z_propensity", unit: "0-1", min: 0, max: 1 },
  { id: 5, name: "cgr_x", unit: "0-1", min: 0, max: 1 },
  { id: 6, name: "cgr_y", unit: "0-1", min: 0, max: 1 },
  { id: 7, name: "attention", unit: "0-1", min: 0, max: 1 },
  { id: 8, name: "p_promoter", unit: "0-1", min: 0, max: 1 },
  { id: 9, name: "p_cpg_island", unit: "0-1", min: 0, max: 1 },
  { id: 10, name: "p_splice_donor", unit: "0-1", min: 0, max: 1 },
  { id: 11, name: "p_splice_acceptor", unit: "0-1", min: 0, max: 1 },
  { id: 12, name: "anomaly_score", unit: "0-1", min: 0, max: 1 },
];

export interface WsHello {
  type: "hello";
  contract: number;
  client: string;
}
export interface WsStartScan {
  type: "start_scan";
  sha256: string;
  window_bp?: number;
  speed_bps?: number;
  want?: number[];
  force_recompute?: boolean;
}
export interface WsAck {
  type: "ack";
  stream_seq: number;
}
export interface WsCheckpoint {
  type: "checkpoint";
  scan_id: string;
  last_scanned_pos: number;
}
export interface WsMutate {
  type: "mutate";
  request_id: string;
  scan_id: string;
  position: number;
  alt: Base4;
}
export interface WsStop {
  type: "stop";
}
export interface WsPing {
  type: "ping";
  t: number;
}
export type ClientMsg = WsHello | WsStartScan | WsAck | WsCheckpoint | WsMutate | WsStop | WsPing;

export interface WsHelloAck {
  type: "hello_ack";
  session_id: string;
  contract: number;
  core_version: string;
  model_version: string;
}
export interface WsScanReady {
  type: "scan_ready";
  sha256: string;
  length: number;
  channels: ChannelInfo[];
  chunk_positions: number;
  cache: "HIT" | "MISS";
  params_hash: string;
  overview_bins: number;
  model_scope?: ModelScope | null;
}
export interface WsProgress {
  type: "progress";
  pos: number;
  fraction: number;
}
export interface WsAnomalyAlert {
  type: "anomaly_alert";
  start: number;
  end: number;
  score: number;
  kind: AnomalyKind;
}
export interface WsScanComplete {
  type: "scan_complete";
  anomaly_count: number;
  duration_ms: number;
}
export interface WsMutationResult {
  type: "mutation_result";
  request_id: string;
  mutation: Mutation;
}
export interface WsError {
  type: "error";
  error: ErrorBody;
  fatal: boolean;
}
export interface WsPong {
  type: "pong";
  t: number;
}
export type ServerMsg =
  | WsHelloAck
  | WsScanReady
  | WsProgress
  | WsAnomalyAlert
  | WsScanComplete
  | WsMutationResult
  | WsError
  | WsPong;

export interface EvIngestComplete {
  type: "ingest_complete";
  item: IngestItem;
}
export interface EvHistoryChanged {
  type: "history_changed";
  latest_rev: number;
}
export interface EvWatcherStatus {
  type: "watcher_status";
  watching: boolean;
  path: string;
  mode: "inotify" | "polling";
}
export interface EvServerNotice {
  type: "server_notice";
  level: string;
  message: string;
}
export type EventMsg = EvIngestComplete | EvHistoryChanged | EvWatcherStatus | EvServerNotice;

export const FRAME_MAGIC = [0x48, 0x53] as const;
export const FRAME_VERSION = 1 as const;
export const FRAME_HEADER_BYTES = 24 as const;
export const FRAME_TYPE = { TELEMETRY_CHUNK: 0x01, OVERVIEW: 0x02 } as const;
export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];
export const FLAG = { FINAL: 1 << 0, FROM_CACHE: 1 << 1, HAS_NAN: 1 << 2 } as const;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export interface TelemetryFrame {
  frameType: FrameType;
  streamSeq: number;
  startPos: number;
  count: number;
  channelCount: number;
  flags: number;
  planes: Float32Array;
}

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function decodeFrame(input: ArrayBuffer | ArrayBufferView): TelemetryFrame {
  if (!HOST_IS_LITTLE_ENDIAN) throw new FrameError("big-endian hosts are not supported");
  const buf = input instanceof ArrayBuffer ? input : (input.buffer as ArrayBuffer);
  const byteOffset = input instanceof ArrayBuffer ? 0 : input.byteOffset;
  const byteLength = input instanceof ArrayBuffer ? input.byteLength : input.byteLength;
  if (byteLength < FRAME_HEADER_BYTES) {
    throw new FrameError(`frame is ${byteLength} bytes, shorter than the ${FRAME_HEADER_BYTES}-byte header`);
  }
  const dv = new DataView(buf, byteOffset, byteLength);
  if (dv.getUint8(0) !== FRAME_MAGIC[0] || dv.getUint8(1) !== FRAME_MAGIC[1]) throw new FrameError("bad frame magic");
  if (dv.getUint8(2) !== FRAME_VERSION) throw new FrameError(`unsupported frame version ${dv.getUint8(2)}`);
  const frameType = dv.getUint8(3);
  if (frameType !== FRAME_TYPE.TELEMETRY_CHUNK && frameType !== FRAME_TYPE.OVERVIEW) {
    throw new FrameError(`unknown frame type ${frameType}`);
  }
  const count = dv.getUint32(12, true);
  const channelCount = dv.getUint16(16, true);
  const n = channelCount * count;
  if (byteLength !== FRAME_HEADER_BYTES + n * 4) {
    throw new FrameError(`frame is ${byteLength} bytes but the header announces ${FRAME_HEADER_BYTES + n * 4}`);
  }
  const payloadOffset = byteOffset + FRAME_HEADER_BYTES;
  const planes =
    payloadOffset % 4 === 0
      ? new Float32Array(buf, payloadOffset, n)
      : new Float32Array(buf.slice(payloadOffset, payloadOffset + n * 4));
  return {
    frameType: frameType as FrameType,
    streamSeq: dv.getUint32(4, true),
    startPos: dv.getUint32(8, true),
    count,
    channelCount,
    flags: dv.getUint16(18, true),
    planes,
  };
}

export function frameChannel(frame: TelemetryFrame, i: number): Float32Array {
  if (i < 0 || i >= frame.channelCount) throw new RangeError(`channel row ${i} out of range`);
  return frame.planes.subarray(i * frame.count, (i + 1) * frame.count);
}

export const isFinalFrame = (f: TelemetryFrame): boolean => (f.flags & FLAG.FINAL) !== 0;
export const isFromCache = (f: TelemetryFrame): boolean => (f.flags & FLAG.FROM_CACHE) !== 0;
export const hasNaN = (f: TelemetryFrame): boolean => (f.flags & FLAG.HAS_NAN) !== 0;
