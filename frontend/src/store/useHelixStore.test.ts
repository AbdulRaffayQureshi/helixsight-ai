import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mutation } from "../contracts/history";
import { CHANNELS, FLAG, FRAME_TYPE, decodeFrame, type TelemetryFrame, type WsScanReady } from "../contracts/ws";
import { encodeCodes } from "../lib/iupac";
import {
  bindEventsClient, bindScanClient, configureHelixServices, openFromWorkbench, percentileDomain, resetHelixStore, useHelixStore,
  type ScanClientLike,
} from "./useHelixStore";
import type { LoadedWorkbench } from "../db/repo";
import type { ScanHandlers } from "../api/wsScan";

const SHA = "c".repeat(64);
const L = 1000;
const st = () => useHelixStore.getState();

function frame(type: number, seq: number, start: number, planes: number[][], flags = 0): TelemetryFrame {
  const count = planes[0]!.length;
  const buf = new ArrayBuffer(24 + planes.length * count * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x48); dv.setUint8(1, 0x53); dv.setUint8(2, 1); dv.setUint8(3, type);
  dv.setUint32(4, seq, true); dv.setUint32(8, start, true); dv.setUint32(12, count, true);
  dv.setUint16(16, planes.length, true); dv.setUint16(18, flags, true);
  planes.forEach((p, r) => p.forEach((v, i) => dv.setFloat32(24 + (r * count + i) * 4, v, true)));
  return decodeFrame(buf);
}

const ready = (ids: number[], over: Partial<WsScanReady> = {}): WsScanReady => ({
  type: "scan_ready", sha256: SHA, length: L, channels: ids.map((i) => CHANNELS[i]!), chunk_positions: 256, cache: "MISS", params_hash: "ph",
  overview_bins: 4, model_scope: { trained_on: "human", warning: "w" }, ...over,
});

function open(scanId: string | null = "scan1") {
  st().openSequence({ sha256: SHA, scanId, codes: encodeCodes("ACGT".repeat(L / 4)), molecule: "DNA", display: "demo" });
}

beforeEach(() => resetHelixStore());
afterEach(() => { vi.useRealTimers(); resetHelixStore(); });

describe("openSequence", () => {
  it("adopts codes/length/molecule, resets the head and scan state", () => {
    open();
    const s = st();
    expect(s.active).toMatchObject({ sha256: SHA, scanId: "scan1", length: L, molecule: "DNA", display: "demo" });
    expect(s.status).toBe("idle");
    expect(s.headRef.pos).toBe(0);
  });
});

describe("frame ingestion", () => {
  it("scan_ready allocates NaN planes for the streamed channels; frames fill them", () => {
    open();
    st().beginScan(ready([0, 2, 12]));
    expect(st().status).toBe("streaming");
    expect(st().planes[0]).toHaveLength(L);

    st().applyFrame(frame(FRAME_TYPE.TELEMETRY_CHUNK, 1, 0, [[1, 2, 3], [10, 20, 30], [0.1, 0.2, 0.3]]));
    expect(Array.from(st().planes[0]!.subarray(0, 4))).toEqual([1, 2, 3, expect.any(Number)]);
  });
});

describe("percentileDomain", () => {
  it("ignores NaN, trims outliers and never returns a zero-width domain", () => {
    const a = Float32Array.from({ length: 1000 }, (_, i) => (i === 3 ? NaN : i === 10 ? 1e6 : 50 + (i % 20)));
    const d = percentileDomain(a);
    expect(d.min).toBeGreaterThanOrEqual(50);
    expect(d.max).toBeLessThanOrEqual(70);
  });
});
