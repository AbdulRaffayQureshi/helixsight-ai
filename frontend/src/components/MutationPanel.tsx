import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { useServices } from "../app/AppServices";
import type { Mutation } from "../contracts/history";
import type { Base4 } from "../contracts/ingest";
import { deleteMutation } from "../db/repo";
import { BASE_COLORS, BASE_COLORS_CVD, SEQUENCE_STRIP_WINDOW } from "../lib/constants";
import { useHelixStore } from "../store/useHelixStore";
import { useUiStore } from "../store/useUiStore";
import { ChevronIcon, cx, Spinner } from "./ui";

const BASES: readonly Base4[] = ["A", "C", "G", "T"];
const LETTER = "ACGTN";

export const transitionOf = (b: Base4): Base4 => (b === "A" ? "G" : b === "G" ? "A" : b === "C" ? "T" : "C");

export function verdictFor(p: number | null): { label: string; tone: "na" | "low" | "moderate" | "high" } {
  if (p === null || Number.isNaN(p)) return { label: "n/a", tone: "na" };
  if (p < 0.2) return { label: "low", tone: "low" };
  if (p < 0.5) return { label: "moderate", tone: "moderate" };
  return { label: "high", tone: "high" };
}
const TONE: Record<ReturnType<typeof verdictFor>["tone"], string> = { na: "bg-abyss-600", low: "bg-ok", moderate: "bg-warn", high: "bg-laser" };

const fmt = (v: number | null, digits = 2, signed = true): string => (v === null ? "–" : `${signed && v > 0 ? "+" : ""}${v.toFixed(digits)}`);

export function PathogenicityBar({ value }: { value: number | null }) {
  const v = verdictFor(value);
  return (
    <div className="flex items-center gap-2" title="Research heuristic, not a clinical or diagnostic result">
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-abyss-700" role="meter" aria-label="Heuristic impact score" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value ?? 0}>
        <div className={cx("h-full", TONE[v.tone])} style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
      </div>
      <span className="w-24 text-right font-mono text-xs">{value === null ? "n/a" : `${value.toFixed(2)} · ${v.label}`}</span>
    </div>
  );
}

function SequenceStrip() {
  const active = useHelixStore((s) => s.active); const head = useHelixStore((s) => s.headPos); const selected = useHelixStore((s) => s.selectedBase);
  const mutated = useHelixStore((s) => s.mutations); const cvd = useHelixStore((s) => s.hud.cvdPalette);
  const selectBase = useHelixStore((s) => s.selectBase); const toast = useUiStore((s) => s.toast);
  if (!active) return null;
  const colors = cvd ? BASE_COLORS_CVD : BASE_COLORS;
  const half = (SEQUENCE_STRIP_WINDOW - 1) / 2;
  const center = Math.round(head);
  const first = Math.max(0, Math.min(center - half, active.length - SEQUENCE_STRIP_WINDOW));
  const last = Math.min(active.length - 1, first + SEQUENCE_STRIP_WINDOW - 1);
  const marks = new Set(mutated.map((m) => m.position));
  const cells = [];
  for (let i = first; i <= last; i++) {
    const code = active.codes[i] ?? 4;
    const base = LETTER[code] ?? "N";
    const color = code < 4 ? colors[base as Base4] : "#64748B";
    cells.push(
      <button
        key={i} type="button" aria-pressed={selected === i} aria-label={`Position ${i + 1} (1-based), ${base}. Click to select, Shift+click for a transition mutation`}
        onClick={(e) => { selectBase(i); if (e.shiftKey && code < 4) { useHelixStore.getState().mutateBase(i, transitionOf(base as Base4)).catch((err: unknown) => toast("error", `Mutation failed: ${(err as Error).message}`)); } }}
        className={cx("relative h-7 w-5 shrink-0 rounded border font-mono text-xs font-bold transition-colors", selected === i ? "border-white bg-white/15" : i === center ? "border-electric bg-electric/10" : "border-abyss-600 bg-abyss-900 hover:border-abyss-500")}
        style={{ color }}
      >
        {base}
        {marks.has(i) ? <span className="absolute -top-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-laser" aria-hidden="true" /> : null}
      </button>,
    );
  }
  return <div className="flex gap-px overflow-x-auto pb-1 pt-2" role="group" aria-label="Bases around the reading head">{cells}</div>;
}

function MutationRow({ m, onGo, onRevert, reverting }: { m: Mutation; onGo: () => void; onRevert: () => void; reverting: boolean }) {
  return (
    <li className="rounded-md border border-abyss-700 bg-abyss-900/80 p-2 text-xs" data-testid="mutation-row">
      <div className="flex items-center gap-2">
        <button type="button" className="font-mono font-semibold text-electric-bright underline-offset-2 hover:underline" onClick={onGo} aria-label={`Go to position ${m.position + 1}`}>#{(m.position + 1).toLocaleString("en-US")}</button>
        <span className="font-mono"><span className="text-ink-dim">{m.ref}</span> → <span className="text-laser-bright">{m.alt}</span></span>
        <button type="button" className="btn btn-ghost ml-auto px-1.5 py-0.5 text-xs" onClick={onRevert} disabled={reverting} aria-label={`Revert mutation at position ${m.position + 1}`}>
          {reverting ? <Spinner className="h-3 w-3" /> : "Revert"}
        </button>
      </div>
      <div className="mt-1.5 grid grid-cols-5 gap-x-2 font-mono text-[11px] text-ink-dim">
        <span title="change in melting temperature (°C)">ΔTm {fmt(m.delta_tm_c, 1)}</span>
        <span title="change in free energy ΔG (kcal/mol)">ΔΔG {fmt(m.delta_dg_kcal)}</span>
        <span title="change in promoter probability">Δprom {fmt(m.delta_p_promoter, 3)}</span>
        <span title="change in CpG-island probability">ΔCpG {fmt(m.delta_p_cpg, 3)}</span>
        <span title="change in splice-site probability">Δsplice {fmt(m.delta_p_splice, 3)}</span>
      </div>
      <div className="mt-1.5"><PathogenicityBar value={m.pathogenicity} /></div>
    </li>
  );
}

export function MutationPanel() {
  const svc = useServices(); const toast = useUiStore((s) => s.toast);
  const active = useHelixStore((s) => s.active); const selected = useHelixStore((s) => s.selectedBase); const pending = useHelixStore((s) => s.pendingBase);
  const mutations = useHelixStore((s) => s.mutations); const seek = useHelixStore((s) => s.seek); const selectBase = useHelixStore((s) => s.selectBase);
  const mutateBase = useHelixStore((s) => s.mutateBase); const removeMutation = useHelixStore((s) => s.removeMutation);
  const [open, setOpen] = useState(true); const [alt, setAlt] = useState<Base4 | null>(null);
  const [goTo, setGoTo] = useState(""); const [reverting, setReverting] = useState<string | null>(null);

  const ref: Base4 | null = useMemo(() => {
    if (!active || selected === null) return null;
    const b = LETTER[active.codes[selected] ?? 4];
    return b === "A" || b === "C" || b === "G" || b === "T" ? b : null;
  }, [active, selected]);
  useEffect(() => { setAlt(ref ? transitionOf(ref) : null); }, [ref, selected]);

  const canApply = !!active?.scanId && selected !== null && ref !== null && alt !== null && alt !== ref && pending === null;
  const sorted = useMemo(() => [...mutations].sort((a, b) => b.created_at.localeCompare(a.created_at)), [mutations]);

  const apply = async () => {
    if (!canApply || selected === null || alt === null) return;
    try {
      const m = await mutateBase(selected, alt);
      const v = verdictFor(m.pathogenicity);
      toast("success", `Position ${m.position + 1}: ${m.ref}→${m.alt}, heuristic impact ${m.pathogenicity === null ? "n/a" : `${m.pathogenicity.toFixed(2)} (${v.label})`}`);
    } catch (e) { toast("error", `Mutation failed: ${(e as Error).message}`); }
  };

  const revert = async (m: Mutation) => {
    setReverting(m.mutation_id);
    try { await svc.api.deleteMutation(m.mutation_id); }
    catch (e) { if (!(e instanceof ApiError && e.status === 404)) { toast("error", `Could not revert: ${(e as Error).message}`); setReverting(null); return; } }
    removeMutation(m.mutation_id);
    if (svc.db) await deleteMutation(svc.db, m.mutation_id).catch(() => undefined);
    setReverting(null);
  };

  const go = (e: FormEvent) => {
    e.preventDefault(); const n = Number(goTo);
    if (!active || !Number.isInteger(n) || n < 1 || n > active.length) return;
    seek(n - 1); selectBase(n - 1);
  };

  if (!active) return null;
  return (
    <section aria-label="In-silico mutation" className="panel pointer-events-auto absolute right-3 top-16 z-10 flex max-h-[calc(100%-13rem)] w-[22rem] max-w-[calc(100%-1.5rem)] flex-col">
      <button type="button" className="flex items-center justify-between px-3 py-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="text-sm font-semibold uppercase tracking-wider text-laser-bright">In-silico mutation</span>
        <span className="flex items-center gap-2 text-xs text-ink-dim">{mutations.length > 0 ? `${mutations.length} applied` : ""}<ChevronIcon open={open} /></span>
      </button>
      {open ? (
        <div className="min-h-0 space-y-3 overflow-y-auto border-t border-abyss-700 p-3">
          <form onSubmit={go} className="flex items-end gap-2">
            <label className="flex-1">
              <span className="label">Go to position</span>
              <input className="input font-mono" inputMode="numeric" value={goTo} onChange={(e) => setGoTo(e.target.value)} placeholder={`1 – ${active.length.toLocaleString("en-US")}`} aria-label="Go to position (1-based)" />
            </label>
            <button type="submit" className="btn">Go</button>
          </form>
          <SequenceStrip />
          <div aria-live="polite" className="text-sm">
            {selected === null ? (
              <p className="text-ink-dim">Select a base: click the helix, a letter in the strip, or enter a position.</p>
            ) : (
              <p>
                <span className="text-ink-dim">Selected </span><span className="font-mono font-semibold">Position {(selected + 1).toLocaleString("en-US")}</span>
                <span className="ml-2 font-mono">{ref ?? "N"}</span>
                {ref === null ? <span className="ml-2 text-xs text-warn">ambiguous base: cannot mutate</span> : null}
              </p>
            )}
          </div>
          <div role="group" aria-label="Substitution" className="flex items-center gap-2">
            <span className="label mb-0">to</span>
            {BASES.map((b) => (
              <button key={b} type="button" aria-pressed={alt === b} disabled={ref === null || b === ref} onClick={() => setAlt(b)} aria-label={`Substitute with ${b}`} className={cx("btn h-8 w-9 px-0 font-mono font-bold", alt === b && "btn-laser")}>{b}</button>
            ))}
            <button type="button" className="btn btn-laser ml-auto" disabled={!canApply} aria-busy={pending !== null} onClick={() => void apply()}>
              {pending !== null ? <Spinner className="h-3.5 w-3.5 text-laser" /> : null}Apply
            </button>
          </div>
          {!active.scanId ? <p className="text-xs text-warn">Open this sequence from History (or ingest it) so mutations can be saved with a scan.</p> : null}
          <p className="rounded border border-abyss-700 bg-abyss-900 p-2 text-[11px] leading-snug text-ink-dim">Scores are a <strong className="text-ink">research heuristic</strong>... Not a clinical result.</p>
          {sorted.length > 0 ? (
            <ul className="space-y-2" aria-label="Applied mutations">
              {sorted.map((m) => (
                <MutationRow key={m.mutation_id} m={m} reverting={reverting === m.mutation_id} onGo={() => { seek(m.position); selectBase(m.position); }} onRevert={() => void revert(m)} />
              ))}
            </ul>
          ) : <p className="text-xs text-ink-faint">No mutations applied to this scan yet.</p>}
        </div>
      ) : null}
    </section>
  );
}
