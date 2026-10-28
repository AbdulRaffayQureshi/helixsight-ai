import type { AnomalyRegion, Mutation } from "../contracts/history";
import { BASE_COLORS, BASE_COLORS_CVD, DELTA, GEO, Z_DNA } from "../lib/constants";

export const TAU = 2 * Math.PI;
export const Z_THRESHOLD = 0.5;
export const SAMPLES_PER_BASE = 6;
export const ZIG_AMPLITUDE = 0.35;
export const MIN_WINDOW_BP = 8;
export const MAX_WINDOW_BP = 200;
const MAX_POINTS = (MAX_WINDOW_BP + 10) * SAMPLES_PER_BASE + 2;
const MAX_RUNGS = MAX_WINDOW_BP + 10;
const MAX_EXTEND_PER_CALL = 1 << 20;

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export interface MorphOptions {
  blend: number;
  auto: boolean;
  zThreshold: number;
}
export const DEFAULT_MORPH: Readonly<MorphOptions> = { blend: 0, auto: true, zThreshold: Z_THRESHOLD };

export function morphAt(z: number, o: MorphOptions): number {
  let s = o.blend;
  if (o.auto && z > o.zThreshold) s += smooth((z - o.zThreshold) / (1 - o.zThreshold));
  return clamp(s, 0, 1);
}
export const stepRise = (s: number): number => lerp(GEO.RISE, Z_DNA.RISE, s);
export const stepTwist = (s: number): number => (TAU / lerp(GEO.BPT, Z_DNA.BPT, s)) * Math.cos(Math.PI * s);
export const helixRadius = (s: number): number => lerp(GEO.R, Z_DNA.R, s);

export interface Sample { z: number; th: number; s: number; }

export class GeometryTable {
  length = 0;
  built = 0;
  baseMorph = 0;
  cumZ: Float64Array = new Float64Array(1);
  cumTh: Float64Array = new Float64Array(1);
  morph: Float32Array = new Float32Array(0);
  opts: MorphOptions = { ...DEFAULT_MORPH };

  constructor(length = 0, opts?: Partial<MorphOptions>) { this.reset(length, opts); }

  reset(length: number = this.length, opts?: Partial<MorphOptions>): void {
    if (length !== this.length || this.cumZ.length !== length + 1) {
      this.length = length;
      this.cumZ = new Float64Array(length + 1);
      this.cumTh = new Float64Array(length + 1);
      this.morph = new Float32Array(length);
    }
    if (opts) this.opts = { ...this.opts, ...opts };
    this.cumZ[0] = 0; this.cumTh[0] = 0; this.built = 0; this.baseMorph = morphAt(NaN, this.opts);
  }

  extend(zProp: Float32Array | null, upTo: number): void {
    const end = Math.min(upTo, this.length, this.built + MAX_EXTEND_PER_CALL);
    const { cumZ, cumTh, morph, opts } = this;
    for (let i = this.built; i < end; i++) {
      const s = morphAt(zProp ? zProp[i]! : NaN, opts);
      morph[i] = s;
      cumZ[i + 1] = cumZ[i]! + stepRise(s);
      cumTh[i + 1] = cumTh[i]! + stepTwist(s);
    }
    this.built = Math.max(this.built, end);
  }

  ensure(zProp: Float32Array | null, filledUpTo: number, want: number): void {
    const limit = zProp ? Math.min(filledUpTo, want) : want;
    if (limit > this.built) this.extend(zProp, limit);
  }
}

export function phaseAt(t: GeometryTable, u: number, out: Sample): Sample {
  if (u < 0) u = 0;
  const b = t.built;
  if (u >= b) {
    const d = u - b;
    const s0 = t.baseMorph;
    out.z = t.cumZ[b]! + d * stepRise(s0);
    out.th = t.cumTh[b]! + d * stepTwist(s0);
    out.s = s0;
    return out;
  }
  const i = Math.floor(u);
  const f = u - i;
  out.z = t.cumZ[i]! + f * (t.cumZ[i + 1]! - t.cumZ[i]!);
  out.th = t.cumTh[i]! + f * (t.cumTh[i + 1]! - t.cumTh[i]!);
  out.s = t.morph[i]!;
  return out;
}

export function baseAtZ(t: GeometryTable, zTarget: number): number {
  const b = t.built;
  if (b === 0 || zTarget >= t.cumZ[b]!) return b + (zTarget - t.cumZ[b]!) / stepRise(t.baseMorph);
  let lo = 0; let hi = b;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (t.cumZ[mid]! <= zTarget) lo = mid; else hi = mid;
  }
  return lo + (zTarget - t.cumZ[lo]!) / (t.cumZ[lo + 1]! - t.cumZ[lo]!);
}

export interface Layout {
  width: number; height: number; cx: number; cy: number; pxPerNm: number; zHead: number; windowBp: number;
}
export const createLayout = (): Layout => ({ width: 0, height: 0, cx: 0, cy: 0, pxPerNm: 1, zHead: 0, windowBp: 40 });

const SCRATCH: Sample = { z: 0, th: 0, s: 0 };
const SCRATCH2: Sample = { z: 0, th: 0, s: 0 };

export function computeLayout(out: Layout, width: number, height: number, windowBp: number, t: GeometryTable, headPos: number): Layout {
  const wb = clamp(windowBp, MIN_WINDOW_BP, MAX_WINDOW_BP);
  out.width = width; out.height = height; out.windowBp = wb; out.cx = width / 2; out.cy = height / 2;
  out.pxPerNm = Math.min((width * 0.94) / (wb * GEO.RISE), (height * 0.3) / GEO.R);
  out.zHead = phaseAt(t, headPos, SCRATCH).z;
  return out;
}

export const projectX = (l: Layout, z: number): number => l.cx + (z - l.zHead) * l.pxPerNm;

export function hitTestBase(t: GeometryTable, l: Layout, mx: number, my: number, length: number, tolerancePx = 6): number {
  if (length <= 0) return -1;
  const u = baseAtZ(t, l.zHead + (mx - l.cx) / l.pxPerNm);
  const idx = Math.round(u);
  if (idx < 0 || idx >= length) return -1;
  const p = phaseAt(t, idx, SCRATCH2);
  const dx = Math.abs(mx - projectX(l, p.z));
  if (dx > Math.max(tolerancePx, 0.5 * stepRise(p.s) * l.pxPerNm)) return -1;
  if (Math.abs(my - l.cy) > helixRadius(p.s) * l.pxPerNm + tolerancePx) return -1;
  return idx;
}

const C = {
  bg: "#070B14", strand1: "#67E8F9", strand2: "#C4B5FD", head: "#22D3EE", attn: "#A78BFA", alert: "#F43F5E",
  hbond: "#CBD5E1", text: "#E6EDF7", muted: "#8A9BB8", mut: "#F472B6", spot: "rgba(34,211,238,0.07)", sel: "#FFFFFF", zBadge: "#F59E0B",
} as const;
const BASE_FILL: readonly string[] = [BASE_COLORS.A, BASE_COLORS.C, BASE_COLORS.G, BASE_COLORS.T, "#64748B"];
const BASE_FILL_CVD: readonly string[] = [BASE_COLORS_CVD.A, BASE_COLORS_CVD.C, BASE_COLORS_CVD.G, BASE_COLORS_CVD.T, "#64748B"];
const LETTERS: readonly string[] = ["A", "C", "G", "T", "N"];
const DIGITS: readonly string[] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const POW10: readonly number[] = [1, 10, 100, 1000, 10000];
const DASH: number[] = [2, 2];
const NO_DASH: number[] = [];
const FONT = "11px ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace";
const CHAR_W = 6.6;
export const HEAT_STEPS = 64;
export const HEAT_LUT: readonly string[] = (() => {
  const stops = [[37, 99, 235], [34, 211, 238], [250, 204, 21], [239, 68, 68]] as const;
  const out: string[] = [];
  for (let i = 0; i < HEAT_STEPS; i++) {
    const t = (i / (HEAT_STEPS - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    const a = stops[k]!;
    const b = stops[k + 1]!;
    out.push(`rgb(${Math.round(lerp(a[0], b[0], f))},${Math.round(lerp(a[1], b[1], f))},${Math.round(lerp(a[2], b[2], f))})`);
  }
  return out;
})();

const digitBuf = new Uint8Array(24);

export function drawNumber(ctx: CanvasRenderingContext2D, value: number, x: number, y: number, decimals: number): number {
  if (value !== value) { ctx.fillText("--", x, y); return 2 * CHAR_W; }
  let w = 0; let v = value;
  if (v < 0) { ctx.fillText("-", x, y); x += CHAR_W; w += CHAR_W; v = -v; }
  const dec = decimals < 0 ? 0 : decimals > 4 ? 4 : decimals;
  const scale = POW10[dec]!;
  const scaled = Math.round(v * scale);
  let ip = Math.floor(scaled / scale);
  const frac = scaled - ip * scale;
  let n = 0;
  do { const d = ip % 10; digitBuf[n++] = d; ip = (ip - d) / 10; } while (ip > 0 && n < 20);
  for (let k = n - 1; k >= 0; k--) { ctx.fillText(DIGITS[digitBuf[k]!]!, x, y); x += CHAR_W; w += CHAR_W; }
  if (dec > 0) {
    ctx.fillText(".", x, y); x += CHAR_W; w += CHAR_W;
    for (let d = dec - 1; d >= 0; d--) { ctx.fillText(DIGITS[Math.floor(frac / POW10[d]!) % 10]!, x, y); x += CHAR_W; w += CHAR_W; }
  }
  return w;
}

export interface RenderInput {
  width: number; height: number; dpr: number; codes: Uint8Array | null; length: number; headPos: number; windowBp: number;
  filledUpTo: number; table: GeometryTable | null; attention: Float32Array | null; zProp: Float32Array | null; tm: Float32Array | null;
  heatMin: number; heatMax: number; regions: readonly AnomalyRegion[]; mutations: readonly Mutation[];
  selectedBase: number; hoveredBase: number; cvd: boolean; reducedMotion: boolean; timeMs: number;
}
export function createRenderInput(): RenderInput {
  return { width: 0, height: 0, dpr: 1, codes: null, length: 0, headPos: 0, windowBp: 40, filledUpTo: 0, table: null, attention: null, zProp: null, tm: null, heatMin: 0, heatMax: 1, regions: [], mutations: [], selectedBase: -1, hoveredBase: -1, cvd: false, reducedMotion: false, timeMs: 0 };
}

export class HelixRenderer {
  readonly layout: Layout = createLayout();
  readonly stats = { frames: 0, points: 0, rungs: 0 };
  readonly rungKey = new Float32Array(MAX_RUNGS);
  readonly rungOrder = new Uint16Array(MAX_RUNGS);
  rungCount = 0;
  private readonly X = new Float32Array(MAX_POINTS);
  private readonly Y1 = new Float32Array(MAX_POINTS);
  private readonly D1 = new Float32Array(MAX_POINTS);
  private readonly Y2 = new Float32Array(MAX_POINTS);
  private readonly D2 = new Float32Array(MAX_POINTS);
  private readonly RX = new Float32Array(MAX_RUNGS);
  private readonly RY1 = new Float32Array(MAX_RUNGS);
  private readonly RY2 = new Float32Array(MAX_RUNGS);
  private readonly RR = new Float32Array(MAX_RUNGS);
  private readonly RI = new Int32Array(MAX_RUNGS);
  private readonly S: Sample = { z: 0, th: 0, s: 0 };

  render(ctx: CanvasRenderingContext2D, inp: RenderInput): void {
    this.stats.frames++;
    const W = inp.width; const H = inp.height;
    ctx.setTransform(inp.dpr, 0, 0, inp.dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const tab = inp.table; const codes = inp.codes; const L = inp.length;
    ctx.font = FONT;
    if (!tab || !codes || L <= 0 || W < 40 || H < 40) { ctx.fillStyle = C.muted; ctx.fillText("Open a sequence to start scanning", 16, 24); return; }
    const head = inp.headPos < 0 ? 0 : inp.headPos > L - 1 ? L - 1 : inp.headPos;
    const wb = clamp(inp.windowBp, MIN_WINDOW_BP, MAX_WINDOW_BP);
    const half = wb / 2 + 2;
    const i0 = Math.max(0, Math.floor(head - half));
    const i1 = Math.min(L - 1, Math.ceil(head + half));
    tab.ensure(inp.zProp, inp.filledUpTo, Math.min(L, i1 + 8));
    const lay = computeLayout(this.layout, W, H, wb, tab, head);
    const { cx, cy, pxPerNm: ppn, zHead } = lay;
    const stepPx = GEO.RISE * ppn;
    const fill = inp.cvd ? BASE_FILL_CVD : BASE_FILL;
    const S = this.S; const zProp = inp.zProp; const attn = inp.attention;

    ctx.fillStyle = C.spot; ctx.fillRect(cx - stepPx, 0, 2 * stepPx, H);

    let nr = 0;
    for (let i = i0; i <= i1 && nr < MAX_RUNGS; i++) {
      phaseAt(tab, i, S);
      const R = helixRadius(S.s) * ppn;
      const zig = ZIG_AMPLITUDE * S.s * Math.cos(Math.PI * i);
      const th1 = S.th + zig; const th2 = S.th + DELTA - zig;
      this.RX[nr] = cx + (S.z - zHead) * ppn;
      this.RY1[nr] = cy - R * Math.sin(th1);
      this.RY2[nr] = cy - R * Math.sin(th2);
      this.RR[nr] = R;
      this.RI[nr] = i;
      this.rungKey[nr] = (Math.cos(th1) + Math.cos(th2)) * 0.5;
      this.rungOrder[nr] = nr;
      nr++;
    }
    for (let a = 1; a < nr; a++) {
      const idx = this.rungOrder[a]!;
      const key = this.rungKey[idx]!;
      let b = a - 1;
      while (b >= 0 && this.rungKey[this.rungOrder[b]!]! > key) { this.rungOrder[b + 1] = this.rungOrder[b]!; b--; }
      this.rungOrder[b + 1] = idx;
    }
    this.rungCount = nr; this.stats.rungs += nr;

    const tm = inp.tm;
    if (tm) {
      const span = inp.heatMax - inp.heatMin;
      for (let r = 0; r < nr; r++) {
        const v = tm[this.RI[r]!]!;
        if (v !== v) continue;
        const t = span > 0 ? (v - inp.heatMin) / span : 0;
        ctx.fillStyle = HEAT_LUT[t <= 0 ? 0 : t >= 1 ? HEAT_STEPS - 1 : (t * (HEAT_STEPS - 1)) | 0]!;
        ctx.globalAlpha = 0.9;
        ctx.fillRect(this.RX[r]! - stepPx * 0.5, H - 14, stepPx + 0.6, 6);
      }
    }
    ctx.globalAlpha = 0.75; ctx.fillStyle = C.alert;
    for (let k = 0; k < inp.regions.length; k++) {
      const reg = inp.regions[k]!;
      if (reg.end < i0 || reg.start > i1) continue;
      const xs = cx + (phaseAt(tab, Math.max(reg.start, i0), S).z - zHead) * ppn;
      const xe = cx + (phaseAt(tab, Math.min(reg.end, i1 + 1), S).z - zHead) * ppn;
      ctx.fillRect(xs, 4, Math.max(2, xe - xs), 5);
    }
    if (attn) {
      const pulse = inp.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(inp.timeMs * 0.004);
      ctx.fillStyle = C.attn;
      for (let r = 0; r < nr; r++) {
        const a = attn[this.RI[r]!]!;
        if (!(a > 0.05)) continue;
        const g = Math.pow(a, 1.5) * pulse;
        const rad = 0.6 * ppn * GEO.PITCH * 0.5;
        ctx.globalAlpha = 0.1 * g; ctx.beginPath(); ctx.arc(this.RX[r]!, cy, rad, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.14 * g; ctx.beginPath(); ctx.arc(this.RX[r]!, cy, rad * 0.66, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.2 * g; ctx.beginPath(); ctx.arc(this.RX[r]!, cy, rad * 0.33, 0, TAU); ctx.fill();
      }
    }

    const n = Math.min(MAX_POINTS, (i1 - i0) * SAMPLES_PER_BASE + 1);
    for (let k = 0; k < n; k++) {
      const u = i0 + k / SAMPLES_PER_BASE;
      phaseAt(tab, u, S);
      const R = helixRadius(S.s) * ppn;
      const zig = ZIG_AMPLITUDE * S.s * Math.cos(Math.PI * u);
      const th1 = S.th + zig; const th2 = S.th + DELTA - zig;
      this.X[k] = cx + (S.z - zHead) * ppn;
      this.Y1[k] = cy - R * Math.sin(th1); this.D1[k] = Math.cos(th1);
      this.Y2[k] = cy - R * Math.sin(th2); this.D2[k] = Math.cos(th2);
    }
    this.stats.points += n;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    this.strand(ctx, this.Y1, this.D1, n, false, C.strand1, 2, 0.4);
    this.strand(ctx, this.Y2, this.D2, n, false, C.strand2, 2, 0.4);

    ctx.textAlign = "center";
    for (let o = 0; o < nr; o++) {
      const r = this.rungOrder[o]!;
      const x = this.RX[r]!; const y1 = this.RY1[r]!; const y2 = this.RY2[r]!; const i = this.RI[r]!;
      const alpha = 0.3 + 0.7 * (this.rungKey[r]! + 1) * 0.5;
      const code = codes[i]!; const comp = code < 4 ? 3 - code : 4;
      const len = Math.abs(y2 - y1);
      const ya = y1 + (y2 - y1) * 0.38; const yb = y1 + (y2 - y1) * 0.62;
      ctx.globalAlpha = alpha; ctx.lineWidth = 3; ctx.strokeStyle = fill[code]!;
      ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, ya); ctx.stroke();
      ctx.strokeStyle = fill[comp]!;
      ctx.beginPath(); ctx.moveTo(x, y2); ctx.lineTo(x, yb); ctx.stroke();
      if (len > 14 && code < 4) {
        ctx.strokeStyle = C.hbond; ctx.lineWidth = 1.2; ctx.setLineDash(DASH);
        const bonds = code === 0 || code === 3 ? 2 : 3;
        const off = bonds === 2 ? 2.5 : 4;
        for (let b = 0; b < bonds; b++) {
          const bx = x + (b - (bonds - 1) / 2) * off;
          ctx.beginPath(); ctx.moveTo(bx, ya); ctx.lineTo(bx, yb); ctx.stroke();
        }
        ctx.setLineDash(NO_DASH);
      }
      const nodeR = 3.2 + 1.8 * (this.rungKey[r]! + 1) * 0.5;
      ctx.fillStyle = fill[code]!; ctx.beginPath(); ctx.arc(x, y1, nodeR, 0, TAU); ctx.fill();
      ctx.fillStyle = fill[comp]!; ctx.beginPath(); ctx.arc(x, y2, nodeR, 0, TAU); ctx.fill();
      if (Math.abs(i - head) <= 8 && len > 18) {
        ctx.globalAlpha = Math.min(1, alpha + 0.2);
        ctx.fillStyle = "#0B1220";
        ctx.fillText(LETTERS[code]!, x, y1 + 3.5); ctx.fillText(LETTERS[comp]!, x, y2 + 3.5);
      }
      if (i === inp.selectedBase || i === inp.hoveredBase) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = i === inp.selectedBase ? C.sel : C.head;
        ctx.lineWidth = i === inp.selectedBase ? 2 : 1;
        ctx.beginPath(); ctx.arc(x, cy, this.RR[r]! + 6, 0, TAU); ctx.stroke();
      }
      if (zProp && zProp[i]! > Z_THRESHOLD) {
        ctx.globalAlpha = 0.9; ctx.fillStyle = C.zBadge; ctx.fillText("Z", x, cy + this.RR[r]! + 18);
      }
    }
    ctx.textAlign = "left";

    ctx.fillStyle = C.mut; ctx.globalAlpha = 1;
    for (let k = 0; k < inp.mutations.length; k++) {
      const p = inp.mutations[k]!.position;
      if (p < i0 || p > i1) continue;
      const x = cx + (phaseAt(tab, p, S).z - zHead) * ppn;
      const y = cy - helixRadius(S.s) * ppn - 14;
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill();
    }

    this.strand(ctx, this.Y1, this.D1, n, true, C.strand1, 3, 1);
    this.strand(ctx, this.Y2, this.D2, n, true, C.strand2, 3, 1);

    ctx.globalAlpha = 0.9; ctx.strokeStyle = C.head; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, 12); ctx.lineTo(cx, H - 18); ctx.stroke();
    ctx.fillStyle = C.head;
    ctx.beginPath(); ctx.moveTo(cx - 6, 2); ctx.lineTo(cx + 6, 2); ctx.lineTo(cx, 12); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = C.text;
    let lx = cx + 10;
    ctx.fillText("pos", lx, 22); lx += 4 * CHAR_W; lx += drawNumber(ctx, Math.floor(head) + 1, lx, 22, 0) + 2 * CHAR_W;
    ctx.fillStyle = C.muted; ctx.fillText("turn", lx, 22); lx += 5 * CHAR_W;
    phaseAt(tab, head, S);
    drawNumber(ctx, Math.abs(S.th) / TAU, lx, 22, 2);
    ctx.fillText("rise", 12, H - 30); drawNumber(ctx, stepRise(S.s), 12 + 5 * CHAR_W, H - 30, 2);
    ctx.fillText("nm  Z", 12 + 10 * CHAR_W, H - 30); drawNumber(ctx, S.s, 12 + 16 * CHAR_W, H - 30, 2);
    ctx.globalAlpha = 1;
  }

  private strand(ctx: CanvasRenderingContext2D, Y: Float32Array, D: Float32Array, n: number, front: boolean, color: string, width: number, alpha: number): void {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
    let open = false;
    for (let k = 0; k < n; k++) {
      const isFront = D[k]! > 0;
      if (isFront === front) {
        if (!open) {
          ctx.beginPath();
          if (k > 0) { ctx.moveTo(this.X[k - 1]!, Y[k - 1]!); ctx.lineTo(this.X[k]!, Y[k]!); } else ctx.moveTo(this.X[k]!, Y[k]!);
          open = true;
        } else ctx.lineTo(this.X[k]!, Y[k]!);
      } else if (open) {
        ctx.lineTo(this.X[k]!, Y[k]!); ctx.stroke(); open = false;
      }
    }
    if (open) ctx.stroke();
  }
}
