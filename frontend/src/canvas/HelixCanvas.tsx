import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CHANNEL } from "../contracts/ws";
import { useHelixStore } from "../store/useHelixStore";
import { GeometryTable, HelixRenderer, createRenderInput, hitTestBase, type RenderInput } from "./helixMath";

export interface HelixCanvasProps {
  className?: string;
  style?: CSSProperties;
  onBaseClick?: (base: number) => void;
  onBaseHover?: (base: number | null) => void;
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};

export function HelixCanvas({ className, style, onBaseClick, onBaseHover }: HelixCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveRef = useRef<HTMLDivElement | null>(null);
  const rig = useRef<{ renderer: HelixRenderer; table: GeometryTable; input: RenderInput } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const renderer = new HelixRenderer();
    const table = new GeometryTable();
    const input = createRenderInput();
    rig.current = { renderer, table, input };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      input.width = r.width; input.height = r.height; input.dpr = dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0; let last = performance.now(); let lastSha: string | null = null; let lastMorph = -1;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = useHelixStore.getState();
      s.tick(dt, now);
      const a = s.active;
      if (a && (a.sha256 !== lastSha || s.morphVersion !== lastMorph)) {
        table.reset(a.length, s.morph);
        lastSha = a.sha256; lastMorph = s.morphVersion;
      } else if (!a) { lastSha = null; }
      input.codes = a ? a.codes : null;
      input.length = a ? a.length : 0;
      input.headPos = s.headRef.pos;
      input.windowBp = s.windowBp;
      input.filledUpTo = s.filledUpTo;
      input.table = a ? table : null;
      input.attention = s.planes[CHANNEL.attention] ?? null;
      input.zProp = s.planes[CHANNEL.z_propensity] ?? null;
      input.tm = s.planes[CHANNEL.tm_c] ?? null;
      input.heatMin = s.heatDomain.min;
      input.heatMax = s.heatDomain.max;
      input.regions = s.regions;
      input.mutations = s.mutations;
      input.selectedBase = s.selectedBase ?? -1;
      input.hoveredBase = s.hoveredBase ?? -1;
      input.cvd = s.hud.cvdPalette;
      input.reducedMotion = s.hud.reducedMotion;
      input.timeMs = now;
      renderer.render(ctx, input);
    };
    raf = requestAnimationFrame(frame);

    const live = window.setInterval(() => {
      const s = useHelixStore.getState();
      const el = liveRef.current;
      if (!el || !s.active) return;
      const pos = Math.floor(s.headRef.pos);
      const base = "ACGTN"[s.active.codes[pos] ?? 4] ?? "N";
      el.textContent = `Reading head at base ${pos + 1} of ${s.active.length}, ${base}. ${s.playing ? "Playing" : "Paused"} at ${s.speedBps} bases per second.`;
    }, 1000);

    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.clearInterval(live); rig.current = null; };
  }, []);

  const baseAt = (ev: ReactPointerEvent<HTMLCanvasElement>): number => {
    const r = rig.current; const canvas = canvasRef.current; const s = useHelixStore.getState();
    if (!r || !canvas || !s.active) return -1;
    const box = canvas.getBoundingClientRect();
    return hitTestBase(r.table, r.renderer.layout, ev.clientX - box.left, ev.clientY - box.top, s.active.length);
  };

  const onPointerMove = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const i = baseAt(ev); const s = useHelixStore.getState(); const next = i < 0 ? null : i;
    if (next !== s.hoveredBase) { s.hoverBase(next); onBaseHover?.(next); }
    if (canvasRef.current) canvasRef.current.style.cursor = i < 0 ? "default" : "pointer";
  };
  const onPointerLeave = () => { useHelixStore.getState().hoverBase(null); onBaseHover?.(null); };
  const onClick = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const i = baseAt(ev); if (i < 0) return;
    useHelixStore.getState().selectBase(i); onBaseClick?.(i);
  };
  const onKeyDown = (ev: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const s = useHelixStore.getState();
    if (!s.active) return;
    const step = ev.shiftKey ? 10 : 1;
    switch (ev.key) {
      case "ArrowLeft": s.seek(s.headRef.pos - step); break;
      case "ArrowRight": s.seek(s.headRef.pos + step); break;
      case "Home": s.seek(0); break;
      case "End": s.seek(s.active.length - 1); break;
      case " ": s.setPlaying(!s.playing); break;
      case "+": case "=": s.setSpeed(s.speedBps * 1.25); break;
      case "-": s.setSpeed(s.speedBps / 1.25); break;
      case "Enter": {
        const p = Math.round(s.headRef.pos); s.selectBase(p); onBaseClick?.(p); break;
      }
      default: return;
    }
    ev.preventDefault();
  };

  return (
    <div className={className} style={{ position: "relative", ...style }}>
      <canvas ref={canvasRef} tabIndex={0} role="img" aria-label="Double helix visualisation with reading head." style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onClick={onClick} onKeyDown={onKeyDown} />
      <div ref={liveRef} aria-live="polite" style={VISUALLY_HIDDEN} />
    </div>
  );
}
