import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { useServices } from "../app/AppServices";
import { deleteHistoryItem, openHistoryItem, openIngestItem } from "../app/flows";
import { isValidAccession, isValidPdbId, SOURCE_KINDS, type ErrorBody, type InvalidIupacDetail, type SourceKind } from "../contracts/ingest";
import type { HistoryRecord, IngestItem, IngestResponse } from "../contracts/history";
import { putIngestItems, listHistory } from "../db/repo";
import { CanonicalizeError, canonicalizeDraft, codePointToUtf16Offset } from "../lib/canonicalize";
import { sequenceSha256 } from "../lib/sha256";
import { useHelixStore } from "../store/useHelixStore";
import { useUiStore, type IngestLane, type SidebarTab } from "../store/useUiStore";
import { cx, Field, formatBp, formatRelativeTime, RefreshIcon, SearchIcon, SourceBadge, Spinner, TrashIcon } from "./ui";

const TABS: ReadonlyArray<{ id: SidebarTab; label: string }> = [{ id: "history", label: "History" }, { id: "ingest", label: "Ingest" }];

export function Sidebar() {
  const tab = useUiStore((s) => s.sidebarTab);
  const setTab = useUiStore((s) => s.setSidebarTab);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  return (
    <aside aria-label="Sequences" className="flex h-full min-h-0 w-full flex-col border-r border-abyss-700 bg-abyss-900">
      <div role="tablist" aria-label="Sidebar sections" className="grid grid-cols-2 border-b border-abyss-700" onKeyDown={onKey}>
        {TABS.map((t) => (
          <button key={t.id} id={`tab-${t.id}`} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} className={cx("px-3 py-2.5 text-sm font-semibold uppercase tracking-wider transition-colors", tab === t.id ? "border-b-2 border-electric bg-abyss-850 text-electric-bright" : "border-b-2 border-transparent text-ink-dim hover:text-ink")}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1">
        {tab === "history" ? <HistoryPanel /> : <IngestPanel />}
      </div>
    </aside>
  );
}

function VirtualList({ count, rowHeight, overscan = 6, label, renderRow }: { count: number; rowHeight: number; overscan?: number; label: string; renderRow: (i: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const viewH = height || 600;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewH) / rowHeight) + overscan);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(<div key={i} data-row={i} style={{ position: "absolute", top: i * rowHeight, height: rowHeight, left: 0, right: 0 }}>{renderRow(i)}</div>);
  }
  return (
    <div ref={ref} role="listbox" aria-label={label} className="h-full overflow-y-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: count * rowHeight, position: "relative" }}>{rows}</div>
    </div>
  );
}

const ROW_H = 84;
function HistoryRow({ rec, active, confirming, busy, onOpen, onAskDelete, onConfirmDelete }: { rec: HistoryRecord; active: boolean; confirming: boolean; busy: boolean; onOpen: () => void; onAskDelete: () => void; onConfirmDelete: () => void; }) {
  const pct = rec.length > 0 ? Math.min(100, Math.round((rec.last_scanned_pos / rec.length) * 100)) : 0;
  return (
    <div className="group relative h-full px-2 py-1">
      <button type="button" role="option" aria-selected={active} onClick={onOpen} className={cx("flex h-full w-full flex-col justify-center gap-0.5 rounded-md border px-3 text-left transition-colors", active ? "border-electric bg-electric/10 shadow-glow" : "border-abyss-700 bg-abyss-850 hover:border-abyss-500")}>
        <span className="flex items-center gap-2">
          <SourceBadge source={rec.source} />
          <span className="truncate text-sm font-semibold">{rec.display_name}</span>
          {busy ? <Spinner className="ml-auto h-3.5 w-3.5" /> : <span className="ml-auto shrink-0 text-[11px] text-ink-faint">{formatRelativeTime(rec.updated_at)}</span>}
        </span>
        <span className="truncate text-xs text-ink-dim">{rec.accession ?? rec.organism ?? "\u00a0"}</span>
        <span className="flex items-center gap-3 font-mono text-[11px] text-ink-dim">
          <span>{formatBp(rec.length)}</span>
          <span>GC {rec.gc_pct.toFixed(1)}%</span>
          {rec.anomaly_count > 0 ? <span className="text-laser-bright" title="anomaly regions">⚠ {rec.anomaly_count}</span> : null}
          {rec.mutation_count > 0 ? <span className="text-warn" title="in-silico mutations">✎ {rec.mutation_count}</span> : null}
        </span>
        <span className="mt-0.5 h-1 overflow-hidden rounded bg-abyss-700" aria-hidden="true"><span className="block h-full bg-electric/80" style={{ width: `${pct}%` }} /></span>
      </button>
      <button type="button" aria-label={confirming ? `Confirm delete ${rec.display_name}` : `Delete ${rec.display_name}`} onClick={confirming ? onConfirmDelete : onAskDelete} className={cx("btn absolute right-3 top-8 px-1.5 py-1 text-xs", confirming ? "btn-danger opacity-100" : "btn-ghost opacity-0 focus:opacity-100 group-hover:opacity-100")}>
        {confirming ? "Delete?" : <TrashIcon className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function HistoryPanel() {
  const svc = useServices();
  const toast = useUiStore((s) => s.toast);
  const version = useUiStore((s) => s.historyVersion);
  const activeScan = useHelixStore((s) => s.active?.scanId ?? null);
  const [q, setQ] = useState("");
  const [source, setSource] = useState<SourceKind | "ALL">("ALL");
  const [items, setItems] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const filter = { ...(q.trim() ? { q: q.trim() } : {}), ...(source !== "ALL" ? { source } : {}) };
        const rows = svc.db ? await listHistory(svc.db, { limit: 2000, ...filter }) : (await svc.api.listHistory({ limit: 200, ...filter })).items;
        if (!cancelled) setItems(rows);
      } catch (e) {
        if (!cancelled) toast("error", `Could not load history: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, q ? 120 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [svc, q, source, version, toast]);

  const open = useCallback(async (rec: HistoryRecord) => {
    setOpening(rec.scan_id);
    try {
      await openHistoryItem(svc, rec);
      useUiStore.getState().setSidebarOpen(false);
    } catch (e) {
      toast("error", e instanceof ApiError && e.status === 0 ? "Backend unreachable and this sequence is not cached on this device." : `Could not open ${rec.display_name}: ${(e as Error).message}`);
    } finally { setOpening(null); }
  }, [svc, toast]);

  const remove = async (rec: HistoryRecord) => {
    setConfirm(null);
    try { await deleteHistoryItem(svc, rec); toast("info", `Deleted ${rec.display_name}`); }
    catch (e) { toast("error", `Delete failed: ${(e as Error).message}`); }
  };

  const sync = async () => {
    if (!svc.syncer) return;
    setSyncing(true);
    try { await svc.syncer.sync(); } catch (e) { toast("warning", `Sync failed (working offline): ${(e as Error).message}`); }
    finally { setSyncing(false); }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const i = rows.findIndex((r) => r === document.activeElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) { e.preventDefault(); next.focus(); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-abyss-700 p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-faint" />
          <input type="search" className="input pl-8" placeholder="Search name, accession, organism" aria-label="Search history" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by source">
          {(["ALL", ...SOURCE_KINDS] as const).map((s) => (
            <button key={s} type="button" aria-pressed={source === s} onClick={() => setSource(s)} className={cx("chip transition-colors", source === s && "border-electric text-electric-bright")}>
              {s === "ALL" ? "All" : s}
            </button>
          ))}
          <button type="button" className="btn btn-ghost ml-auto px-2 py-1" onClick={sync} disabled={!svc.syncer || syncing} aria-label="Sync history with the backend" title="Sync with backend">
            {syncing ? <Spinner className="h-3.5 w-3.5" /> : <RefreshIcon className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1" onKeyDown={onKey}>
        {loading ? (
          <p className="p-4 text-sm text-ink-dim">Loading…</p>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-dim">
            <p className="font-medium text-ink">{q || source !== "ALL" ? "No matching runs" : "Nothing scanned yet"}</p>
            <p className="mt-1">Use the <button type="button" className="text-electric underline" onClick={() => useUiStore.getState().setSidebarTab("ingest")}>Ingest</button> tab to load a sequence from NCBI, PDB, a paste or a file.</p>
          </div>
        ) : (
          <VirtualList count={items.length} rowHeight={ROW_H} label="Analysis history" renderRow={(i) => {
            const rec = items[i]!;
            return <HistoryRow rec={rec} active={rec.scan_id === activeScan} confirming={confirm === rec.scan_id} busy={opening === rec.scan_id} onOpen={() => void open(rec)} onAskDelete={() => setConfirm(rec.scan_id)} onConfirmDelete={() => void remove(rec)} />;
          }} />
        )}
      </div>
    </div>
  );
}

export type IngestPhase =
  | { kind: "idle" }
  | { kind: "submitting"; lane: IngestLane }
  | { kind: "success"; items: IngestItem[]; warnings: string[] }
  | { kind: "error"; error: ErrorBody };

export function toErrorBody(e: unknown): ErrorBody {
  if (e instanceof ApiError) return e.body ?? { code: "INTERNAL", message: e.status === 0 ? "Backend unreachable. Is the API running on :8000?" : e.message };
  if (e instanceof CanonicalizeError) return e.toErrorBody();
  return { code: "INTERNAL", message: (e as Error).message };
}

const CACHE_LABEL: Record<IngestItem["cache_status"], string> = { HIT_ACCESSION: "served from the local accession cache (no network)", HIT_SHA: "sequence already stored", MISS_STORED: "new sequence stored" };

function useIngest() {
  const svc = useServices();
  const toast = useUiStore((s) => s.toast);
  const bump = useUiStore((s) => s.bumpHistory);
  const [phase, setPhase] = useState<IngestPhase>({ kind: "idle" });
  const ctl = useRef<AbortController | null>(null);

  const run = useCallback(async (lane: IngestLane, call: (signal: AbortSignal) => Promise<IngestResponse>) => {
    ctl.current?.abort();
    const ac = new AbortController();
    ctl.current = ac;
    setPhase({ kind: "submitting", lane });
    try {
      const res = await call(ac.signal);
      if (ac.signal.aborted) return;
      if (svc.db) await putIngestItems(svc.db, res.items);
      bump();
      setPhase({ kind: "success", items: res.items, warnings: res.warnings });
      const first = res.items[0];
      if (first) {
        await openIngestItem(svc, first);
        toast("success", `${first.record.display_name}: ${CACHE_LABEL[first.cache_status]}`);
        useUiStore.getState().setSidebarOpen(false);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") { setPhase({ kind: "idle" }); return; }
      setPhase({ kind: "error", error: toErrorBody(e) });
    }
  }, [svc, bump, toast]);

  const cancel = useCallback(() => { ctl.current?.abort(); setPhase({ kind: "idle" }); }, []);
  const reset = useCallback(() => setPhase({ kind: "idle" }), []);
  return { phase, run, cancel, reset };
}

function ResultBox({ phase, onOpen }: { phase: IngestPhase; onOpen: (item: IngestItem) => void }) {
  if (phase.kind === "error") {
    return (
      <div role="alert" className="rounded-md border border-alert/60 bg-alert/10 p-3 text-sm">
        <p className="font-semibold text-alert">{phase.error.code.replaceAll("_", " ")}</p>
        <p className="mt-0.5 text-ink">{phase.error.message}</p>
        {phase.error.code === "PDB_NO_NUCLEIC_ACID" && Array.isArray(phase.error.detail?.["entities"]) ? (
          <ul className="mt-2 list-disc pl-5 text-xs text-ink-dim">
            {(phase.error.detail["entities"] as Array<{ entity_id: number; type: string; description: string }>).map((e) => (
              <li key={e.entity_id}>entity {e.entity_id}: {e.type} {e.description ? `(${e.description})` : ""}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  if (phase.kind === "success") {
    return (
      <div role="status" className="rounded-md border border-ok/50 bg-ok/10 p-3 text-sm">
        <p className="font-semibold text-ok">{phase.items.length === 1 ? "Sequence loaded" : `${phase.items.length} sequences loaded`}</p>
        {phase.items.length > 1 ? (
          <ul className="mt-1 space-y-1">
            {phase.items.map((it) => (
              <li key={it.record.scan_id}>
                <button type="button" className="text-electric underline" onClick={() => onOpen(it)}>{it.record.display_name}</button>
                <span className="ml-2 text-xs text-ink-dim">{formatBp(it.record.length)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {phase.warnings.map((w) => <p key={w} className="mt-1 text-xs text-warn">⚠ {w}</p>)}
      </div>
    );
  }
  return null;
}

function SubmitRow({ phase, disabled, label, onCancel }: { phase: IngestPhase; disabled: boolean; label: string; onCancel: () => void }) {
  const busy = phase.kind === "submitting";
  return (
    <div className="flex gap-2">
      <button type="submit" className="btn btn-primary flex-1" disabled={disabled || busy} aria-busy={busy}>
        {busy ? <Spinner /> : null}{busy ? "Working…" : label}
      </button>
      {busy ? <button type="button" className="btn" onClick={onCancel}>Cancel</button> : null}
    </div>
  );
}

function NcbiForm() {
  const svc = useServices();
  const { phase, run, cancel } = useIngest();
  const [acc, setAcc] = useState("");
  const [force, setForce] = useState(false);
  const [cached, setCached] = useState(false);
  const value = acc.trim().toUpperCase();
  const valid = isValidAccession(value);

  useEffect(() => {
    let cancelled = false;
    if (!svc.db || !valid) { setCached(false); return; }
    void svc.db.getAllFromIndex("history", "by_accession", value).then((r) => { if (!cancelled) setCached(r.length > 0); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [svc.db, value, valid]);

  const submit = (e: FormEvent) => { e.preventDefault(); if (valid) void run("ncbi", (signal) => svc.api.ingestNcbi({ accession: value, force_refresh: force }, signal)); };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="NCBI Entrez accession">
      <Field label="Accession" hint={cached ? "Cached locally: opens instantly, no network." : "Nucleotide / RefSeq accession, e.g. NM_004006 or NC_045512.2"} error={acc && !valid ? "Expected letters, optional underscore, digits and an optional .version" : null}>
        {(id) => <input id={id} className="input font-mono" value={acc} onChange={(e) => setAcc(e.target.value)} placeholder="NM_004006" autoComplete="off" spellCheck={false} maxLength={32} />}
      </Field>
      <div className="flex flex-wrap gap-1.5" aria-label="Examples">
        {["NM_004006", "NC_045512.2", "NC_012920.1"].map((x) => (
          <button key={x} type="button" className="chip font-mono hover:border-electric hover:text-electric-bright" onClick={() => setAcc(x)}>{x}</button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Force refresh</label>
      <SubmitRow phase={phase} disabled={!valid} label="Fetch from NCBI" onCancel={cancel} />
      <ResultBox phase={phase} onOpen={(it) => void openIngestItem(svc, it)} />
    </form>
  );
}

function PdbForm() {
  const svc = useServices();
  const { phase, run, cancel } = useIngest();
  const [id, setId] = useState("");
  const [entity, setEntity] = useState("");
  const [all, setAll] = useState(false);
  const [force, setForce] = useState(false);
  const pid = id.trim().toUpperCase();
  const valid = isValidPdbId(pid);
  const entityNum = entity.trim() === "" ? null : Number(entity);
  const entityOk = entityNum === null || (Number.isInteger(entityNum) && entityNum >= 1);
  const submit = (e: FormEvent) => { e.preventDefault(); if (valid && entityOk) void run("pdb", (signal) => svc.api.ingestPdb({ pdb_id: pid, entity_id: entityNum, all_nucleic_acid: all, force_refresh: force }, signal)); };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="RCSB PDB">
      <Field label="PDB ID" hint="Four characters, e.g. 1BNA (the Dickerson dodecamer). The first DNA/RNA entity is used." error={id && !valid ? "A PDB ID is a digit followed by three letters or digits" : null}>
        {(fid) => <input id={fid} className="input font-mono uppercase" value={id} onChange={(e) => setId(e.target.value)} placeholder="1BNA" maxLength={4} autoComplete="off" spellCheck={false} />}
      </Field>
      <Field label="Entity (optional)" error={!entityOk ? "Entity must be a whole number >= 1" : null}>
        {(fid) => <input id={fid} className="input font-mono" inputMode="numeric" value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="auto" />}
      </Field>
      <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Load every nucleic-acid entity</label>
      <label className="flex items-center gap-2 text-xs text-ink-dim"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Force refresh</label>
      <SubmitRow phase={phase} disabled={!valid || !entityOk} label="Fetch from RCSB PDB" onCancel={cancel} />
      <ResultBox phase={phase} onOpen={(it) => void openIngestItem(svc, it)} />
    </form>
  );
}

type Preview = { ok: true; records: ReturnType<typeof canonicalizeDraft>["records"]; warnings: string[] } | { ok: false; error: CanonicalizeError };

function PasteForm() {
  const svc = useServices();
  const { phase, run, cancel } = useIngest();
  const text = useUiStore((s) => s.pasteDraft);
  const setText = useUiStore((s) => s.setPasteDraft);
  const [label, setLabel] = useState("");
  const [cachedRec, setCachedRec] = useState<HistoryRecord | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const deferred = useDeferredValue(text);

  const preview = useMemo<Preview | null>(() => {
    if (!deferred.trim()) return null;
    try { return { ok: true, ...canonicalizeDraft(deferred, { label: label.trim() || null }) }; } catch (e) { return { ok: false, error: e as CanonicalizeError }; }
  }, [deferred, label]);

  useEffect(() => {
    let cancelled = false;
    setCachedRec(null);
    if (!svc.db || !preview?.ok || preview.records.length !== 1) return;
    void sequenceSha256(preview.records[0]!.residues).then(async (sha) => {
      const rows = await svc.db!.getAllFromIndex("history", "by_sha", sha);
      if (!cancelled && rows.length > 0) setCachedRec(rows.sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [svc.db, preview]);

  const jumpTo = useCallback((detail: Partial<InvalidIupacDetail> | null | undefined) => {
    const ta = area.current;
    if (!ta || detail?.raw_offset == null) return;
    const start = codePointToUtf16Offset(ta.value, detail.raw_offset);
    ta.focus();
    ta.setSelectionRange(start, start + (detail.char?.length ?? 1));
  }, []);

  useEffect(() => { if (phase.kind === "error" && phase.error.code === "INVALID_IUPAC") jumpTo(phase.error.detail as Partial<InvalidIupacDetail> | null); }, [phase, jumpTo]);

  const submit = (e: FormEvent) => { e.preventDefault(); if (preview?.ok) void run("paste", (signal) => svc.api.ingestPaste({ text, label: label.trim() || null }, signal)); };
  const clientError = preview && !preview.ok ? preview.error : null;
  const first = preview?.ok ? preview.records[0] : undefined;

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Paste FASTA or raw sequence">
      <Field label="Sequence" hint="FASTA (one or many records) or raw letters. Whitespace, line numbers and case are ignored.">
        {(id) => (
          <textarea
            id={id} ref={area} className="input h-40 resize-y font-mono text-xs leading-relaxed" value={text} onChange={(e) => setText(e.target.value)}
            placeholder={">my_sequence\nATGCGTACGTTAGC…"} spellCheck={false} autoComplete="off" maxLength={20_000_000}
          />
        )}
      </Field>
      <Field label="Label (optional)">
        {(id) => <input id={id} className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="Name shown in History" />}
      </Field>
      <div className="min-h-[2.5rem] rounded-md border border-abyss-700 bg-abyss-900 p-2 text-xs" aria-live="polite" data-testid="paste-preview">
        {!preview ? <span className="text-ink-faint">Paste a sequence to see a live preview.</span> : null}
        {clientError ? (
          <span className="text-alert">
            {clientError.message}{" "}
            {clientError.code === "INVALID_IUPAC" ? <button type="button" className="underline" onClick={() => jumpTo(clientError.detail as Partial<InvalidIupacDetail>)}>Show</button> : null}
          </span>
        ) : null}
        {preview?.ok ? (
          <span className="font-mono text-ink-dim">
            {preview.records.length} record{preview.records.length === 1 ? "" : "s"} · {formatBp(preview.records.reduce((n, r) => n + r.length, 0))}
            {first ? <> · GC {first.gc_pct.toFixed(1)}% · {first.molecule}{first.ambiguous ? ` · ${first.ambiguous} ambiguous` : ""}</> : null}
            {preview.warnings.map((w) => <span key={w} className="block text-warn">⚠ {w}</span>)}
          </span>
        ) : null}
      </div>
      {cachedRec ? (
        <button type="button" className="btn btn-laser w-full" onClick={() => void openHistoryItem(svc, cachedRec)}>Open instantly (cached on this device)</button>
      ) : null}
      <SubmitRow phase={phase} disabled={!preview?.ok} label="Ingest" onCancel={cancel} />
      <ResultBox phase={phase} onOpen={(it) => void openIngestItem(svc, it)} />
    </form>
  );
}

const ACCEPT = ".fasta,.fa,.fna,.fas,.txt";
const MAX_FILE_MB = 50;
function FileForm() {
  const svc = useServices();
  const { phase, run, cancel } = useIngest();
  const pending = useUiStore((s) => s.pendingFiles);
  const setPending = useUiStore((s) => s.setPendingFiles);
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const tooBig = files.find((f) => f.size > MAX_FILE_MB * 1024 * 1024);

  const upload = useCallback((list: File[]) => { void run("file", (signal) => svc.api.ingestFiles(list, signal)); }, [run, svc]);

  useEffect(() => {
    if (pending.length === 0) return;
    setFiles(pending); setPending([]); upload(pending);
  }, [pending, setPending, upload]);

  const submit = (e: FormEvent) => { e.preventDefault(); if (files.length > 0 && !tooBig) upload(files); };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="FASTA files">
      <div
        className={cx("flex h-32 flex-col items-center justify-center rounded-lg border-2 border-dashed text-center text-sm transition-colors", over ? "border-laser bg-laser/10" : "border-abyss-600 bg-abyss-900")}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); setFiles(Array.from(e.dataTransfer.files)); }}
      >
        <p className="text-ink">Drop .fasta / .fa / .fna files here</p>
        <label className="mt-2 cursor-pointer text-electric underline">
          or browse
          <input type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Choose FASTA files" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
      </div>
      {files.length > 0 ? (
        <ul className="space-y-1 text-xs" aria-label="Selected files">
          {files.map((f) => <li key={f.name + f.size} className="flex justify-between font-mono text-ink-dim"><span className="truncate">{f.name}</span><span>{(f.size / 1024).toFixed(1)} KB</span></li>)}
        </ul>
      ) : null}
      {tooBig ? <p className="text-xs text-alert" role="alert">{tooBig.name} is larger than {MAX_FILE_MB} MB.</p> : null}
      <p className="text-xs text-ink-dim">Files dropped into the server's watched folder appear in History automatically.</p>
      <SubmitRow phase={phase} disabled={files.length === 0 || !!tooBig} label={`Ingest ${files.length || ""} file${files.length === 1 ? "" : "s"}`.replace("  ", " ")} onCancel={cancel} />
      <ResultBox phase={phase} onOpen={(it) => void openIngestItem(svc, it)} />
    </form>
  );
}

const LANES: ReadonlyArray<{ id: IngestLane; label: string }> = [{ id: "ncbi", label: "NCBI" }, { id: "pdb", label: "PDB" }, { id: "paste", label: "Paste" }, { id: "file", label: "File" }];

function IngestPanel() {
  const lane = useUiStore((s) => s.ingestLane);
  const setLane = useUiStore((s) => s.setIngestLane);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Ingestion source" className="grid grid-cols-4 gap-1 border-b border-abyss-700 p-2">
        {LANES.map((l) => (
          <button key={l.id} type="button" role="tab" aria-selected={lane === l.id} onClick={() => setLane(l.id)}
            className={cx("rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors", lane === l.id ? "bg-laser/15 text-laser-bright" : "text-ink-dim hover:bg-abyss-800 hover:text-ink")}>
            {l.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {lane === "ncbi" ? <NcbiForm /> : lane === "pdb" ? <PdbForm /> : lane === "paste" ? <PasteForm /> : <FileForm />}
      </div>
    </div>
  );
}
