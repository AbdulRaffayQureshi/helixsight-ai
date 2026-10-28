export type FcgrK = 4 | 5 | 6;
export const FCGR_KS: readonly FcgrK[] = [4, 5, 6];
export const MAX_SPECTRUM_K = 12;

export const xBit = (b: number): number => b >> 1;
export const yBit = (b: number): number => (b & 1) ^ (b >> 1);
export const gridSide = (k: number): number => 1 << k;

function assertK(k: number, allowed: readonly number[] = FCGR_KS): void {
  if (!allowed.includes(k)) throw new RangeError(`k must be one of ${allowed.join(", ")} (got ${k})`);
}

export function kmerToCellIndex(h: number, k: number): number {
  let x = 0; let y = 0;
  for (let j = 1; j <= k; j++) {
    const b = (h >>> (2 * (k - j))) & 3;
    x |= xBit(b) << (j - 1); y |= yBit(b) << (j - 1);
  }
  const n = 1 << k;
  return (n - 1 - y) * n + x;
}

export function cellOfPoint(px: number, py: number, k: number): number {
  const n = 1 << k;
  const x = Math.min(n - 1, Math.floor(px * n));
  const y = Math.min(n - 1, Math.floor(py * n));
  return (n - 1 - y) * n + x;
}

export class FcgrAccumulator {
  readonly k: FcgrK;
  readonly side: number;
  readonly grid: Uint32Array;
  max = 0; total = 0; pos = 0;
  private X = 0; private Y = 0; private run = 0;

  constructor(k: FcgrK) {
    assertK(k); this.k = k; this.side = 1 << k; this.grid = new Uint32Array(this.side * this.side);
  }

  reset(): void {
    this.grid.fill(0); this.max = 0; this.total = 0; this.pos = 0; this.X = 0; this.Y = 0; this.run = 0;
  }

  advance(codes: Uint8Array, upTo: number): number {
    const end = Math.min(upTo, codes.length);
    const { k, side, grid } = this;
    const top = k - 1;
    let added = 0;
    for (let i = this.pos; i < end; i++) {
      const b = codes[i]!;
      if (b > 3) { this.run = 0; continue; }
      this.X = (this.X >> 1) | (xBit(b) << top);
      this.Y = (this.Y >> 1) | (yBit(b) << top);
      if (++this.run >= k) {
        const idx = (side - 1 - this.Y) * side + this.X;
        const c = ++grid[idx]!;
        grid[idx] = c;
        if (c > this.max) this.max = c;
        added++;
      }
    }
    this.total += added;
    if (end > this.pos) this.pos = end;
    return added;
  }

  seek(codes: Uint8Array, pos: number): void {
    this.reset(); this.advance(codes, pos);
  }
}

export function fcgrCounts(codes: Uint8Array, k: FcgrK, from = 0, to = codes.length): Uint32Array {
  const acc = new FcgrAccumulator(k);
  acc.advance(codes.subarray(Math.max(0, from), Math.min(codes.length, to)), Number.POSITIVE_INFINITY);
  return acc.grid;
}

export function kmerSpectrum(codes: Uint8Array, k: number, from = 0, to = codes.length): Uint32Array {
  assertK(k, Array.from({ length: MAX_SPECTRUM_K }, (_, i) => i + 1));
  const out = new Uint32Array(1 << (2 * k));
  const mask = k >= 16 ? 0xffffffff : (1 << (2 * k)) - 1;
  const end = Math.min(codes.length, to);
  let h = 0; let run = 0;
  for (let i = Math.max(0, from); i < end; i++) {
    const b = codes[i]!;
    if (b > 3) { run = 0; h = 0; continue; }
    h = ((h << 2) | b) & mask;
    if (++run >= k) out[h] = out[h]! + 1;
  }
  return out;
}

export function spectrumToFcgr(spectrum: Uint32Array, k: FcgrK): Uint32Array {
  assertK(k);
  if (spectrum.length !== 1 << (2 * k)) throw new RangeError(`spectrum has ${spectrum.length} entries, expected ${1 << (2 * k)}`);
  const grid = new Uint32Array(spectrum.length);
  for (let h = 0; h < spectrum.length; h++) grid[kmerToCellIndex(h, k)] = spectrum[h]!;
  return grid;
}

export const FCGR_PALETTE: Uint8ClampedArray = (() => {
  const p = new Uint8ClampedArray(256 * 4);
  const stops: ReadonlyArray<readonly [number, number, number]> = [[7, 11, 20], [30, 64, 175], [34, 211, 238], [255, 255, 255]];
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const j = Math.min(stops.length - 2, Math.floor(t));
    const f = t - j;
    for (let c = 0; c < 3; c++) p[i * 4 + c] = stops[j]![c]! + (stops[j + 1]![c]! - stops[j]![c]!) * f;
    p[i * 4 + 3] = 255;
  }
  return p;
})();

export function densityToRgba(grid: Uint32Array, max: number, out: Uint8ClampedArray): void {
  if (out.length !== grid.length * 4) throw new RangeError("rgba buffer has the wrong size");
  const denom = max > 0 ? Math.log1p(max) : 1;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i]!;
    const t = v === 0 ? 0 : Math.round((Math.log1p(v) / denom) * 255);
    const o = i * 4; const p = t * 4;
    out[o] = FCGR_PALETTE[p]!; out[o + 1] = FCGR_PALETTE[p + 1]!; out[o + 2] = FCGR_PALETTE[p + 2]!; out[o + 3] = 255;
  }
}

export type FcgrRequest =
  | { type: "init"; id: number; k: FcgrK; codes: Uint8Array }
  | { type: "advance"; id: number; upTo: number }
  | { type: "seek"; id: number; pos: number }
  | { type: "window"; id: number; from: number; to: number }
  | { type: "spectrum"; id: number; k?: number; from?: number; to?: number }
  | { type: "dispose"; id: number };

export type FcgrResponse =
  | { type: "ready"; id: number; k: FcgrK; length: number }
  | { type: "grid"; id: number; k: FcgrK; side: number; grid: Uint32Array; max: number; total: number; pos: number }
  | { type: "spectrum"; id: number; k: number; spectrum: Uint32Array }
  | { type: "disposed"; id: number }
  | { type: "error"; id: number; message: string };

export interface FcgrSession { codes: Uint8Array | null; acc: FcgrAccumulator | null; }
export const createFcgrSession = (): FcgrSession => ({ codes: null, acc: null });

export function handleFcgrMessage(session: FcgrSession, msg: FcgrRequest): { response: FcgrResponse; transfer: ArrayBuffer[] } {
  try {
    switch (msg.type) {
      case "init": {
        session.codes = msg.codes; session.acc = new FcgrAccumulator(msg.k);
        return { response: { type: "ready", id: msg.id, k: msg.k, length: msg.codes.length }, transfer: [] };
      }
      case "advance":
      case "seek": {
        const { codes, acc } = requireSession(session);
        const target = msg.type === "advance" ? msg.upTo : msg.pos;
        if (msg.type === "seek" || target < acc.pos) acc.seek(codes, target); else acc.advance(codes, target);
        return gridResponse(msg.id, acc.k, acc.side, acc.grid, acc.max, acc.total, acc.pos);
      }
      case "window": {
        const { codes, acc } = requireSession(session);
        const local = new FcgrAccumulator(acc.k);
        local.advance(codes.subarray(Math.max(0, msg.from), Math.min(codes.length, msg.to)), Number.POSITIVE_INFINITY);
        return gridResponse(msg.id, local.k, local.side, local.grid, local.max, local.total, msg.to);
      }
      case "spectrum": {
        const { codes, acc } = requireSession(session);
        const spectrum = kmerSpectrum(codes, msg.k ?? acc.k, msg.from ?? 0, msg.to ?? codes.length);
        return { response: { type: "spectrum", id: msg.id, k: msg.k ?? acc.k, spectrum }, transfer: [spectrum.buffer as ArrayBuffer] };
      }
      case "dispose": {
        session.codes = null; session.acc = null;
        return { response: { type: "disposed", id: msg.id }, transfer: [] };
      }
    }
  } catch (e) { return { response: { type: "error", id: msg.id, message: (e as Error).message }, transfer: [] }; }
}

function requireSession(s: FcgrSession): { codes: Uint8Array; acc: FcgrAccumulator } {
  if (!s.codes || !s.acc) throw new Error("fcgr worker is not initialised (send `init` first)");
  return { codes: s.codes, acc: s.acc };
}

function gridResponse(id: number, k: FcgrK, side: number, grid: Uint32Array, max: number, total: number, pos: number) {
  const copy = grid.slice();
  return { response: { type: "grid", id, k, side, grid: copy, max, total, pos } as FcgrResponse, transfer: [copy.buffer as ArrayBuffer] };
}
