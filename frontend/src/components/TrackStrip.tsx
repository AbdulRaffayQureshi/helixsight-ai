import { useEffect, useRef } from "react";
import { CHANNEL, CHANNELS } from "../contracts/ws";
import { useHelixStore } from "../store/useHelixStore";

export interface TrackDef { id: string; label: string; channels: number[]; color: string; }
export const TRACKS: readonly TrackDef[] = [
  { id: "gc", label: "GC %", channels: [CHANNEL.gc_pct], color: "#67E8F9" },
  { id: "tm", label: "Tm", channels: [CHANNEL.tm_c], color: "#FACC15" },
  { id: "dg", label: "ΔG", channels: [CHANNEL.dg_kcal], color: "#F87171" },
  { id: "attention", label: "Attention", channels: [CHANNEL.attention], color: "#A78BFA" },
  { id: "promoter", label: "Promoter", channels: [CHANNEL.p_promoter], color: "#4ADE80" },
  { id: "cpg", label: "CpG", channels: [CHANNEL.p_cpg_island], color: "#60A5FA" },
  { id: "splice", label: "Splice D/A", channels: [CHANNEL.p_splice_donor, CHANNEL.p_splice_acceptor], color: "#FB923C" },
  { id: "anomaly", label: "Anomaly", channels: [CHANNEL.anomaly_score], color: "#FF2BD6" },
];

export const TRACK_ROW_H = 26;
const WINDOW = 160;

export interface TrackFrameInput {
  width: number; height: number; dpr: number; tracks: readonly TrackDef[]; planes: (Float32Array | null)[];
  head: number; length: number; filledUpTo: number; heat: { min: number; max: number };
}

export function channelRange(ch: number, heat: { min: number; max: number }): [number, number] {
  if (ch === CHANNEL.tm_c) return [heat.min, heat.max];
  const c = CHANNELS[ch]!;
  return [c.min, c.max];
}

export function drawTracks(ctx: CanvasRenderingContext2D, inp: TrackFrameInput): void {
  const { width: W, tracks, planes, head, length } = inp;
  ctx.setTransform(inp.dpr, 0, 0, inp.dpr, 0, 0);
  ctx.clearRect(0, 0, W, inp.height);
  ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";
  const labelW = 62;
  const plotW = Math.max(1, W - labelW - 6);
  const start = Math.round(head) - WINDOW;
  const span = WINDOW * 2;
  tracks.forEach((t, row) => {
    const y0 = row * TRACK_ROW_H;
    ctx.fillStyle = "rgba(13,20,36,0.55)"; ctx.fillRect(labelW, y0 + 1, plotW, TRACK_ROW_H - 2);
    ctx.fillStyle = t.color; ctx.fillText(t.label, 4, y0 + 8);
    for (const ch of t.channels) {
      const plane = planes[ch];
      if (!plane) continue;
      const [lo, hi] = channelRange(ch, inp.heat);
      const range = hi - lo || 1;
      ctx.strokeStyle = t.color; ctx.globalAlpha = ch === CHANNEL.p_splice_acceptor ? 0.6 : 0.95; ctx.lineWidth = 1.25;
      let pen = false; ctx.beginPath();
      for (let px = 0; px < plotW; px += 1) {
        const pos = Math.floor(start + (px / plotW) * span);
        const v = pos >= 0 && pos < length && pos < inp.filledUpTo ? plane[pos]! : NaN;
        if (v !== v) { pen = false; continue; }
        const y = y0 + TRACK_ROW_H - 3 - Math.min(1, Math.max(0, (v - lo) / range)) * (TRACK_ROW_H - 7);
        if (pen) ctx.lineTo(labelW + px, y); else { ctx.moveTo(labelW + px, y); pen = true; }
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  });
  ctx.strokeStyle = "#22D3EE"; ctx.lineWidth = 1;
  const hx = labelW + plotW / 2;
  ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, tracks.length * TRACK_ROW_H); ctx.stroke();
}

export function TrackStrip() {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const enabled = useHelixStore((s) => s.hud.tracks);
  const hasData = useHelixStore((s) => s.channelIds.length > 0);
  const tracks = TRACKS.filter((t) => enabled[t.id]);
  const rows = tracks.length;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || rows === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0; let last = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 50) return;
      last = now;
      const s = useHelixStore.getState();
      if (!s.active) return;
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(box.width * dpr)); const h = Math.max(1, Math.round(box.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      drawTracks(ctx, { width: box.width, height: box.height, dpr, tracks, planes: s.planes, head: s.headRef.pos, length: s.active.length, filledUpTo: s.filledUpTo, heat: s.heatDomain });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [rows, tracks]);

  if (rows === 0 || !hasData) return null;
  return <canvas ref={ref} role="img" aria-label="Data tracks around the reading head" className="block w-full" style={{ height: rows * TRACK_ROW_H }} />;
}
