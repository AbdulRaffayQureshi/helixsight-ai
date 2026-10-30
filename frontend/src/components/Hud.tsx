import { useState } from "react";
import { useHelixStore } from "../store/useHelixStore";
import { useUiStore } from "../store/useUiStore";
import { TRACKS, TrackStrip } from "./TrackStrip";
import { ChevronIcon, cx, formatBp, PauseIcon, PlayIcon, ScanIcon, Spinner, StopIcon } from "./ui";

const MIN_SPEED = 1; const MAX_SPEED = 2000;
export const SPEED_PRESETS: readonly number[] = [10, 50, 200, 1000];
export const WINDOW_OPTIONS: readonly number[] = [20, 40, 80, 120, 200];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const speedToSlider = (bps: number): number => Math.log(Math.min(MAX_SPEED, Math.max(MIN_SPEED, bps))) / Math.log(MAX_SPEED);
export function sliderToSpeed(v: number): number {
  const bps = Math.pow(MAX_SPEED, clamp01(v));
  return bps < 10 ? Math.round(bps * 10) / 10 : Math.round(bps);
}

const STATUS_LABEL = { idle: "Idle", connecting: "Connecting…", analyzing: "Analyzing…", streaming: "Streaming", complete: "Complete", error: "Error" } as const;

function StatusChips() {
  const active = useHelixStore((s) => s.active); const status = useHelixStore((s) => s.status); const cache = useHelixStore((s) => s.cache);
  const progress = useHelixStore((s) => s.progress); const anomalies = useHelixStore((s) => s.anomalyCount);
  const scope = useHelixStore((s) => s.modelScope); const error = useHelixStore((s) => s.scanError); const notices = useHelixStore((s) => s.notices);
  const busy = status === "connecting" || status === "analyzing" || status === "streaming";
  return (
    <div className="flex max-w-[min(34rem,100%)] flex-col items-start gap-1.5" aria-live="polite">
      <div className="panel pointer-events-auto flex items-center gap-2 px-3 py-1.5 text-sm">
        {active ? (
          <>
            <span className="max-w-[16rem] truncate font-semibold" title={active.display}>{active.display}</span>
            <span className="font-mono text-xs text-ink-dim">{active.molecule} · {formatBp(active.length)}</span>
          </>
        ) : <span className="text-ink-dim">No sequence open</span>}
        {active ? (
          <span className={cx("chip", status === "error" ? "border-alert text-alert" : status === "complete" ? "border-ok/60 text-ok" : busy ? "border-electric text-electric-bright" : "")}>
            {busy ? <Spinner className="h-3 w-3" /> : null}{STATUS_LABEL[status]}
          </span>
        ) : null}
        {cache ? <span className="chip font-mono" title={cache === "HIT" ? "served from the analysis cache" : "computed now"}>{cache}</span> : null}
        {status === "complete" ? <span className="chip" title="anomaly regions found">⚠ {anomalies}</span> : null}
      </div>
      {busy ? (
        <div className="pointer-events-none h-1 w-64 overflow-hidden rounded bg-abyss-700" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Scan progress">
          <div className="h-full bg-gradient-to-r from-electric to-laser transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}
      {scope ? <span className="chip pointer-events-auto border-laser/60 text-laser-bright" title={scope.trained_on}>⚠ {scope.warning}</span> : null}
      {error ? <span role="alert" className="chip pointer-events-auto border-alert text-alert">{error.code}: {error.message}</span> : null}
      {notices.slice(-3).map((n) => <span key={`${n.code}${n.message}`} className="chip pointer-events-auto border-warn/60 text-warn">{n.code.replaceAll("_", " ")}: {n.message}</span>)}
    </div>
  );
}

function ScanButton() {
  const active = useHelixStore((s) => s.active); const status = useHelixStore((s) => s.status); const toast = useUiStore((s) => s.toast);
  const busy = status === "connecting" || status === "analyzing" || status === "streaming";
  const onClick = async () => {
    const st = useHelixStore.getState();
    if (busy) { st.stopScan(); return; }
    try { await st.startScan({ force: status === "complete" }); } catch (e) { toast("error", `Could not start the scan: ${(e as Error).message}`); }
  };
  return (
    <button type="button" className={cx("btn", busy ? "btn-danger" : "btn-primary")} disabled={!active} onClick={() => void onClick()} aria-label={busy ? "Stop scan" : "Start scan"}>
      {busy ? <StopIcon /> : <ScanIcon />}{busy ? "Stop" : status === "complete" ? "Re-scan" : "Scan"}
    </button>
  );
}

function Transport() {
  const active = useHelixStore((s) => s.active); const playing = useHelixStore((s) => s.playing); const speed = useHelixStore((s) => s.speedBps);
  const head = useHelixStore((s) => s.headPos); const windowBp = useHelixStore((s) => s.windowBp);
  const seek = useHelixStore((s) => s.seek); const setPlaying = useHelixStore((s) => s.setPlaying); const setSpeed = useHelixStore((s) => s.setSpeed); const setWindow = useHelixStore((s) => s.setWindowBp);
  const L = active?.length ?? 0; const disabled = !active;
  return (
    <div className="panel pointer-events-auto flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing}>
        {playing ? <PauseIcon /> : <PlayIcon />}{playing ? "Pause" : "Play"}
      </button>
      <div className="flex min-w-[10rem] flex-1 items-center gap-2">
        <input type="range" className="w-full" min={0} max={Math.max(0, L - 1)} step={1} value={Math.min(Math.floor(head), Math.max(0, L - 1))} disabled={disabled} aria-label="Reading head position" onChange={(e) => seek(Number(e.target.value))} />
        <span className="w-28 shrink-0 text-right font-mono text-xs text-ink-dim" aria-live="off">{disabled ? "–" : `${(Math.floor(head) + 1).toLocaleString("en-US")} / ${L.toLocaleString("en-US")}`}</span>
      </div>
      <div className="flex items-center gap-2">
        <input type="range" className="w-24" min={0} max={1} step={0.005} value={speedToSlider(speed)} disabled={disabled} aria-label="Speed (bases per second)" onChange={(e) => setSpeed(sliderToSpeed(Number(e.target.value)))} />
        <span className="w-16 font-mono text-xs text-ink-dim">{speed} bp/s</span>
        <div className="hidden gap-1 lg:flex" role="group" aria-label="Speed presets">
          {SPEED_PRESETS.map((p) => (
            <button key={p} type="button" className={cx("chip hover:border-electric", Math.round(speed) === p && "border-electric text-electric-bright")} aria-label={`Set speed ${p} bases per second`} disabled={disabled} onClick={() => setSpeed(p)}>{p}</button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-ink-dim">
        Window
        <select className="input w-auto py-1" value={windowBp} onChange={(e) => setWindow(Number(e.target.value))} aria-label="Visible window (bases)">
          {WINDOW_OPTIONS.map((w) => <option key={w} value={w}>{w} bp</option>)}
        </select>
      </label>
      <ScanButton />
    </div>
  );
}

function TracksToggle() {
  const tracks = useHelixStore((s) => s.hud.tracks); const setTrack = useHelixStore((s) => s.setTrack);
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Data tracks">
      <span className="label mb-0 mr-1">Tracks</span>
      {TRACKS.map((t) => (
        <button key={t.id} type="button" aria-pressed={!!tracks[t.id]} onClick={() => setTrack(t.id, !tracks[t.id])} className={cx("chip transition-colors", tracks[t.id] ? "text-ink" : "opacity-60")} style={tracks[t.id] ? { borderColor: t.color } : undefined}>
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: t.color }} aria-hidden="true" />{t.label}
        </button>
      ))}
    </div>
  );
}

function MorphControl() {
  const morph = useHelixStore((s) => s.morph); const setMorph = useHelixStore((s) => s.setMorph);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-xs text-ink-dim">
        <span className="whitespace-nowrap">B-DNA</span>
        <input type="range" className="w-32" min={0} max={1} step={0.01} value={morph.blend} aria-label="B-DNA to Z-DNA blend" onChange={(e) => setMorph({ blend: Number(e.target.value) })} />
        <span className="whitespace-nowrap">Z-DNA</span>
        <span className="w-10 text-right font-mono">{Math.round(morph.blend * 100)}%</span>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-ink-dim" title="Heuristic: bases with z_propensity above 0.5 morph towards Z-DNA (research use only)">
        <input type="checkbox" checked={morph.auto} onChange={(e) => setMorph({ auto: e.target.checked })} aria-label="Morph automatically from Z-propensity" /> auto from Z-propensity
      </label>
    </div>
  );
}

function ViewMenu() {
  const [open, setOpen] = useState(false);
  const cvd = useHelixStore((s) => s.hud.cvdPalette); const reduced = useHelixStore((s) => s.hud.reducedMotion);
  const toggleCvd = useHelixStore((s) => s.toggleCvd); const setReduced = useHelixStore((s) => s.setReducedMotion);
  return (
    <div className="pointer-events-auto relative">
      <button type="button" className="btn" aria-expanded={open} aria-controls="view-menu" onClick={() => setOpen(!open)}>View <ChevronIcon open={open} /></button>
      {open ? (
        <div id="view-menu" className="panel absolute right-0 z-10 mt-1 w-60 space-y-2 p-3 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={cvd} onChange={toggleCvd} aria-label="Colour-vision-safe palette" /> Colour-vision-safe palette</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} aria-label="Reduce motion" /> Reduce motion</label>
          <p className="text-xs text-ink-faint">Keys: <span className="kbd">Space</span> play · <span className="kbd">←</span><span className="kbd">→</span> move · <span className="kbd">+</span><span className="kbd">-</span> speed</p>
        </div>
      ) : null}
    </div>
  );
}

export function Hud() {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between gap-3 p-3" aria-label="Scan controls">
      <div className="flex items-start justify-between gap-3"><StatusChips /><ViewMenu /></div>
      <div className="flex flex-col gap-2">
        <div className="panel pointer-events-auto space-y-2 p-2"><TracksToggle /><TrackStrip /></div>
        <div className="panel pointer-events-auto px-3 py-2"><MorphControl /></div>
        <Transport />
      </div>
    </div>
  );
}
