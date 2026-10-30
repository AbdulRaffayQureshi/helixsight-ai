import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { HelixApi } from "./api/client";
import { EventsClient } from "./api/wsEvents";
import { ScanClient } from "./api/wsScan";
import { ServicesContext, type AppServices } from "./app/AppServices";
import { persistCompletedScan } from "./app/flows";
import { HelixCanvas } from "./canvas/HelixCanvas";
import { Hud } from "./components/Hud";
import { MutationPanel } from "./components/MutationPanel";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { cx, MenuIcon, Spinner } from "./components/ui";
import type { Health } from "./contracts/history";
import { putIngestItems, putMutation } from "./db/repo";
import { openHelixDB, type HelixDB } from "./db/schema";
import { createSyncer } from "./db/sync";
import { bindEventsClient, bindScanClient, configureHelixServices, useHelixStore } from "./store/useHelixStore";
import { useUiStore } from "./store/useUiStore";

export interface AppProps { api?: HelixApi; scan?: ScanClient; events?: EventsClient | null; dbName?: string; }
const WIDTH_KEY = "helixsight.sidebarWidth"; const MIN_W = 280; const MAX_W = 560; const DEFAULT_W = 360;
function readWidth(): number { try { const v = Number(localStorage.getItem(WIDTH_KEY)); return v >= MIN_W && v <= MAX_W ? v : DEFAULT_W; } catch { return DEFAULT_W; } }

export default function App(props: AppProps = {}) {
  const [svc, setSvc] = useState<AppServices | null>(null);
  const propsRef = useRef(props);

  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    void (async () => {
      const ui = useUiStore.getState();
      const api = propsRef.current.api ?? new HelixApi();
      let db: HelixDB | null = null;
      try { db = await openHelixDB(propsRef.current.dbName); } catch { ui.toast("warning", "Local storage is unavailable (private mode?). History will not persist offline."); }
      if (cancelled) { db?.close(); return; }
      const scan = propsRef.current.scan ?? new ScanClient();
      const raw = db ? createSyncer(db, (since, signal) => api.historySync(since, signal)) : null;
      const syncer = raw ? { sync: async () => { const r = await raw.sync(); useUiStore.getState().bumpHistory(); return r; } } : null;
      const services: AppServices = { api, db, syncer, getModelVersion: () => scan.helloAck?.model_version ?? "unknown" };

      configureHelixServices({ scan, persistMutation: db ? (m) => putMutation(db!, m) : null });
      cleanups.push(bindScanClient(scan));
      cleanups.push(useHelixStore.subscribe((s, prev) => { if (prev.status === "streaming" && s.status === "complete") void persistCompletedScan(services, s).catch(() => undefined); }));

      const events = propsRef.current.events === undefined ? new EventsClient(syncer ? { syncer } : {}) : propsRef.current.events;
      if (events) {
        cleanups.push(bindEventsClient(events, {
          onIngestComplete: (item) => {
            if (db) void putIngestItems(db, [item]).then(() => useUiStore.getState().bumpHistory());
            useUiStore.getState().toast("info", `Ingested ${item.record.display_name} from the watched folder`);
          },
          onHistoryChanged: () => useUiStore.getState().bumpHistory(),
        }));
        events.connect();
        cleanups.push(() => events.close());
      }
      cleanups.push(() => { scan.close(); db?.close(); });
      void syncer?.sync().catch(() => undefined);
      setSvc(services);
    })();
    return () => { cancelled = true; cleanups.forEach((c) => c()); };
  }, []);

  if (!svc) return <div className="flex h-full items-center justify-center gap-3 text-ink-dim" role="status"><Spinner className="h-5 w-5" /> Starting HelixSight…</div>;
  return <ServicesContext.Provider value={svc}><Shell svc={svc} /></ServicesContext.Provider>;
}

function Shell({ svc }: { svc: AppServices }) {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen); const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const [width, setWidth] = useState(readWidth);
  const [health, setHealth] = useState<Health | null | "offline">(null);
  const [dragging, setDragging] = useState(false); const dragDepth = useRef(0);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const status = useHelixStore((s) => s.status);

  useEffect(() => { let alive = true; svc.api.health().then((h) => alive && setHealth(h)).catch(() => alive && setHealth("offline")); return () => { alive = false; }; }, [svc, status]);
  useEffect(() => { try { localStorage.setItem(WIDTH_KEY, String(width)); } catch {} }, [width]);
  useEffect(() => {
    const ui = () => useUiStore.getState();
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { dragDepth.current++; setDragging(true); } };
    const onLeave = (e: DragEvent) => { if (hasFiles(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } };
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth.current = 0; setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      ui().setSidebarTab("ingest"); ui().setIngestLane("file"); ui().setSidebarOpen(true); ui().setPendingFiles(files);
    };
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (text.length > 200 || text.trimStart().startsWith(">")) { e.preventDefault(); ui().setPasteDraft(text); ui().setSidebarTab("ingest"); ui().setIngestLane("paste"); ui().setSidebarOpen(true); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "o") { e.preventDefault(); ui().setSidebarTab("ingest"); ui().setSidebarOpen(true); }
      else if (e.key.toLowerCase() === "h") { e.preventDefault(); ui().setSidebarTab("history"); ui().setSidebarOpen(true); }
    };
    window.addEventListener("dragenter", onEnter); window.addEventListener("dragleave", onLeave); window.addEventListener("dragover", onOver); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste); window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("dragenter", onEnter); window.removeEventListener("dragleave", onLeave); window.removeEventListener("dragover", onOver); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); window.removeEventListener("keydown", onKey); };
  }, []);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => { drag.current = { x: e.clientX, w: width }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => { if (drag.current) setWidth(Math.max(MIN_W, Math.min(MAX_W, drag.current.w + e.clientX - drag.current.x))); };
  const onUp = () => { drag.current = null; };
  const onSepKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowRight") setWidth((w) => Math.min(MAX_W, w + step)); else if (e.key === "ArrowLeft") setWidth((w) => Math.max(MIN_W, w - step)); else if (e.key === "Home") setWidth(MIN_W); else if (e.key === "End") setWidth(MAX_W); else return;
    e.preventDefault();
  };

  const healthChip = useMemo(() => {
    if (health === null) return { text: "connecting…", cls: "" };
    if (health === "offline") return { text: "backend offline", cls: "border-alert text-alert" };
    return health.status === "ok" ? { text: `core ${health.core_version} · model ready`, cls: "border-ok/60 text-ok" } : { text: `degraded: ${!health.core_available ? "no native core" : "no model"}`, cls: "border-warn/60 text-warn" };
  }, [health]);

  return (
    <div className="flex h-full flex-col bg-abyss-950 text-ink">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-abyss-700 bg-abyss-900 px-3">
        <button type="button" className="btn btn-ghost px-2 md:hidden" aria-label="Toggle sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><MenuIcon /></button>
        <h1 className="flex items-center gap-2 text-base font-bold tracking-wide">
          <span className="inline-block h-5 w-5 rounded bg-gradient-to-br from-electric to-laser" aria-hidden="true" />
          Helix<span className="text-electric">Sight</span> <span className="font-light text-ink-dim">AI</span>
        </h1>
        <span className="chip hidden sm:inline-flex">local-first</span>
        <span className={cx("chip ml-auto", healthChip.cls)} role="status">{healthChip.text}</span>
        <button type="button" className="btn btn-primary hidden sm:inline-flex" onClick={() => { useUiStore.getState().setSidebarTab("ingest"); setSidebarOpen(true); }}>Ingest <span className="kbd">Ctrl+O</span></button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div className={cx("z-30 h-full shrink-0", sidebarOpen ? "absolute inset-y-0 left-0 block shadow-glow md:static" : "hidden md:block")} style={{ width, maxWidth: "92vw" }}>
          <Sidebar />
        </div>
        <div role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin={MIN_W} aria-valuemax={MAX_W} aria-valuenow={width} tabIndex={0} className="z-30 hidden w-1.5 shrink-0 cursor-col-resize bg-abyss-700 transition-colors hover:bg-electric/60 focus-visible:bg-electric md:block" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onSepKey} />
        <main className="relative min-w-0 flex-1 bg-abyss-950">
          <HelixCanvas className="absolute inset-0" />
          <Hud />
          <MutationPanel />
        </main>
      </div>
      {dragging ? <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center border-4 border-dashed border-laser bg-abyss-950/80 text-xl font-semibold text-laser-bright" role="status">Drop FASTA files to ingest</div> : null}
      <Toasts />
    </div>
  );
}
