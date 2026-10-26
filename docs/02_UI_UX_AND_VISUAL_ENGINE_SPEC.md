# 02_UI_UX_AND_VISUAL_ENGINE_SPEC.md

> **HelixSight AI** · Document `02` of `05` · Depends on: `00_MASTER_CONTEXT_AND_RULES.md`, `01_SYSTEM_ARCHITECTURE_AND_DATAFLOW.md`
> Scope: Ingestion Modal, History Drawer, application state, helix geometry math, groove brackets, base-pair ring geometry, CGR math, sonification, accessibility.
> All code here is **reference-implementation sketches** meant to be completed and tested in Phases P6–P7.

---

## 0. PURPOSE & INTERCONNECTION OVERVIEW

This document specifies everything the user *sees and touches*. It consumes the contracts in `01` (§10–11) and the telemetry channel registry (`01` §7.3).

```text
 Ingestion Modal ──POST /api/ingest/*──► (doc 01 §3) ──► IngestResponse ──► historyStore ──► IndexedDB
        ▲                                                                       │
        │ paste/drop anywhere                                                   ▼
 History Drawer ◄── selectors ◄── historyStore ◄── /api/history/sync ◄── /ws/events
        │ click row
        ▼
 workbenchStore.openHistoryItem(sha256)
        │  (1 IDB transaction: sequences + tensors + mutations)       ◄── <5 ms path
        ▼
 Engine (non-React singleton)  ◄── WS binary frames ◄── stream.worker (doc 01 §12)
   ├─ ring buffers (Float32Array per channel)      ├─ GeometryTable (cumZ, cumTh, morph)
   ├─ headPos clock (rAF)                          └─ FCGR grid (cgr.worker)
        ▼
 HelixCanvas2D · ReadingHeadStrip · HUD tracks · BasePairInspector · CgrRadar · Sonifier
        ▲
        └── click base in ReadingHeadStrip ──► WS {"type":"mutate",…} ──► mutation_result ──► MutationPanel + IDB
```

**Core UI rule:** *React owns chrome; the Engine owns frames.* Anything that changes per frame (head position, ring-buffer reads, canvas draws) lives in the Engine and is never stored in React state. React sees a throttled (≤10 Hz) snapshot.

---

## 1. DESIGN SYSTEM

### 1.1 Tokens (CSS variables, mapped in `tailwind.config.ts`)

| Token | Dark (default) | Use |
|---|---|---|
| `--bg` | `#070B14` | app background |
| `--panel` | `#0D1424` | cards, drawer |
| `--panel-2` | `#121C33` | raised/hover |
| `--border` | `#1B2740` | hairlines |
| `--text` | `#E6EDF7` | primary text |
| `--muted` | `#8A9BB8` | secondary text |
| `--head` | `#22D3EE` | reading head / focus ring |
| `--alert` | `#F43F5E` | anomaly, destructive |
| `--attn` | `#A78BFA` | attention glow |
| `--base-A` / `--base-C` / `--base-G` / `--base-T` | `#4ADE80` / `#60A5FA` / `#FBBF24` / `#F87171` | nucleotides |
| `--src-ncbi` / `--src-pdb` / `--src-paste` / `--src-file` | `#38BDF8` / `#C084FC` / `#94A3B8` / `#2DD4BF` | source badges |

**Colour-vision-safe palette toggle** (`hud.cvdPalette`): swap base colours to Okabe–Ito (`A #009E73`, `C #0072B2`, `G #F0E442`, `T #D55E00`). Base letters are **always printed** on glyphs, so colour is never the only cue.

**Typography:** system stacks only (no CDN fonts; C-2): `ui-sans-serif, system-ui, "Segoe UI"` for UI; `ui-monospace, "Cascadia Mono", Menlo, Consolas` for sequences and numerics (tabular figures).
**Motion:** all non-essential animation is disabled under `prefers-reduced-motion` (head still advances; glow pulses and morph easing become instant).
**Light theme:** out of scope for v1.

### 1.2 App shell

```text
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ◈ HelixSight AI   [⊕ Ingest ⌘/Ctrl+O]   active: NM_004006.3 · NCBI · 13,883 bp    ⏱ ☰ 🔊 ⚙ │ header 48px
├───────────┬──────────────────────────────────────────────────────────┬───────────────────┤
│ HISTORY   │  HELIX CANVAS (2D schematic / 3D toggle)                 │ BASE-PAIR         │
│ DRAWER    │  reading head ▼  turn 12.34  groove brackets             │ INSPECTOR (face-  │
│ 360px     │──────────────────────────────────────────────────────────│ on rings, H-bonds)│
│ slide-out │  5'→3' SEQUENCE STRIP (41 clickable bases)               ├───────────────────┤
│           │──────────────────────────────────────────────────────────│ MUTATION PANEL    │
│           │  HUD TRACKS: GC · Tm · ΔG · attention · promoter · CpG · ├───────────────────┤
│           │  splice D/A · anomaly · minimap with head marker         │ CGR RADAR         │
└───────────┴──────────────────────────────────────────────────────────┴───────────────────┘
```
Breakpoints: ≥1280 three columns; 1024–1279 right column collapses into tabs; <1024 drawer overlays content and the right column stacks below tracks.

---

## 2. INGESTION MODAL

### 2.1 Triggers
1. Header **Ingest** button or `Ctrl/Cmd+O`.
2. **Global paste:** pasting >200 characters (or text starting with `>`) while no input is focused opens the modal on the **Paste** tab pre-filled.
3. **Global drag-over:** dragging files over the window shows a full-window drop overlay; dropping routes to the **File** lane directly (modal not required; a toast confirms).

### 2.2 Layout & tabs

```text
┌───────────────────────── Ingest sequence ───────────────────────── ✕ ┐
│ [ NCBI ]  [ PDB ]  [ Paste ]  [ File ]                               │  role="tablist"
├──────────────────────────────────────────────────────────────────────┤
│ NCBI:  Accession [ NM_004006        ]  ☐ force refresh   [ Fetch ⏎ ] │
│        Examples: NM_004006 · NC_045512.2 · NC_012920.1               │
│        status line: "Cached locally — opens instantly" | "Will fetch"│
├──────────────────────────────────────────────────────────────────────┤
│ result/preview area: name, organism, length, GC%, cache status badge │
│ error area (aria-live=polite)                       [Cancel] [Open ▸]│
└──────────────────────────────────────────────────────────────────────┘
```

| Tab | Inputs | Client validation | Offline cache probe | Request |
|---|---|---|---|---|
| **NCBI** | accession, `force_refresh` | regex `^[A-Za-z]{1,4}_?[0-9]+(\.[0-9]+)?$` | IDB `history.by_accession` (versioned exact match) | `NcbiIngestRequest` |
| **PDB** | 4-char ID; entity selector appears after first response if multiple nucleic-acid entities | `^[0-9][A-Za-z0-9]{3}$` | IDB by `accession="1BNA"` | `PdbIngestRequest` |
| **Paste** | textarea (monospace, virtualized preview for >200 kb), optional label | live canonicalization (see §2.4) | IDB `sequences[sha256]` | `PasteIngestRequest` |
| **File** | drop zone + file picker (`.fasta .fa .fna .fas .txt`), multiple | extension + size (≤50 MB) | none (needs read); after read, SHA probe optional | multipart |

### 2.3 State machine

```ts
type IngestPhase =
  | { kind: "idle" }
  | { kind: "validating" }                       // client-side only
  | { kind: "submitting"; lane: SourceKind; startedAt: number }
  | { kind: "success"; items: IngestItem[]; warnings: string[] }
  | { kind: "error"; error: ErrorBody };

// transitions: idle → validating → submitting → success | error ; any → idle on tab change/close
// "Open ▸" (or ⏎ on success) calls workbenchStore.openIngestItem(items[0]); extra items stay in History.
```
- While `submitting`, the lane's button shows a spinner and a **Cancel** (AbortController on `fetch`; the server finishes harmlessly and caches).
- On `success`, the modal auto-closes after 600 ms unless `warnings.length > 0` (e.g. PDB "entity 2 skipped: protein") or `items.length > 1` (user picks which to open).
- **Error mapping:** `INVALID_IUPAC` → highlight offending character in the paste textarea using `detail.offset`; `PDB_NO_NUCLEIC_ACID` → list protein entities from `detail` and suggest the NCBI tab; `NCBI_RATE_LIMITED` / `UPSTREAM_TIMEOUT` → inline message plus "Open from History" shortcut listing cached items; all other codes → inline `message`.

### 2.4 Paste preview (dual validation, doc 01 §3.4)
- `canonicalize.ts` runs on input with 150 ms debounce; for inputs >200 kb it runs in a small `hash.worker.ts` so typing never blocks.
- Preview strip shows: `records`, `length`, `GC%`, `ambiguous`, `molecule`, short SHA (`sha256.slice(0,8)`), and first invalid character with its 0-based offset.
- SHA-256 uses `crypto.subtle.digest` (secure context: `localhost` and HTTPS qualify; the PWA always is one). If unavailable, show "Hash preview unavailable" and submit anyway (server is authoritative).
- If the predicted `sha256` exists in IDB **and** tensors exist: primary button becomes **Open instantly (cached)** → no network.

### 2.5 Component tree & contracts

```text
IngestionModal
├─ TabList (NCBI|PDB|Paste|File)
├─ NcbiForm        props: { onSubmit(req), probe(accession) }
├─ PdbForm         props: { onSubmit(req), entities?: EntityInfo[] }
├─ PasteModal      props: { onSubmit(req), canonicalize }   // despite the name: the Paste tab body
├─ FileDropZone    props: { onFiles(File[]) }
├─ ResultPreview   props: { phase: IngestPhase }
└─ ErrorBanner     props: { error?: ErrorBody }
Hook: useIngest() → { phase, submitNcbi, submitPdb, submitPaste, submitFiles, reset }
```
`useIngest` calls `api/http.ts`, then on success: `historyStore.upsertMany(items.map(i => i.record))` and `idb.putHistory/putSequenceIfKnown` (sequence bytes are fetched lazily via `GET /api/sequences/{sha}?format=u8` the first time the item is opened on this device, unless the Paste lane already holds the codes).

**Accessibility:** focus trap; `Esc` closes; tabs use roving tabindex (←/→); `aria-live="polite"` for status/errors; all inputs labelled; first focus lands on the active tab's primary field.

---

## 3. HISTORY DRAWER

### 3.1 Anatomy

```text
┌ HISTORY ─────────────────────── ⟳ synced 12:41 ┐   header: title · sync state · close (Esc)
│ 🔍 search name/accession    [All ▾ NCBI PDB PASTE FILE]  sort ▾ │
├────────────────────────────────────────────────┤
│ [NCBI] NM_004006.3                      12:41  │   row 72px
│ Homo sapiens dystrophin (DMD) mRNA             │   name · description (1 line, ellipsis)
│ 13,883 bp · GC 42.7% · ⚠ 3 anomalies           │   length · GC% · anomaly count (⚠ hidden if 0)
│ ▓▓▓▓▓▓▓▓▓▓░░░░ scanned 71% · 2 mutations       │   last_scanned_pos / length · mutation_count
├────────────────────────────────────────────────┤
│ [PASTE] pasted-3fa9c1d2                 12:10  │
│ …                                              │
└────────────────────────────────────────────────┘
```
Row fields map 1:1 to `HistoryRecord` (`01` §10): `display_name|accession`, `source` badge, `length`, `gc_pct`, `anomaly_count`, `last_scanned_pos/length`, `mutation_count`, `updated_at` (relative time; absolute in tooltip).

### 3.2 Behavior
| Interaction | Result |
|---|---|
| Click / Enter on row | `workbenchStore.openHistoryItem(sha256, scan_id)` (§4.3) – no spinner expected (<5 ms) |
| `↑/↓` | roving focus; `Home/End` jump |
| `Delete` or ⋯ menu → Delete | optimistic removal + **Undo** toast (8 s); after timeout `DELETE /api/history/{scan_id}` (tombstone) |
| ⋯ menu → Re-scan | opens item with `force_recompute=true` |
| Search | client-side over IDB `history` (name, accession, organism); debounce 100 ms |
| Source chips | multi-select filter |
| Sort | Recent (default) · Length · Anomalies |
| Drawer open/close | button, `Ctrl/Cmd+H`; slide 180 ms (instant if reduced motion); focus returns to trigger |

**Virtualization:** fixed row height 72 px; render `visible + 6` overscan rows (own windowing, no extra dependency). Data source is the in-memory sorted ID list from `historyStore`; rows fetch records from the store map.
**Sync indicator:** `⟳` while `/api/history/sync` in flight; `⚠ offline` if last attempt failed (history remains fully usable from IDB).
**Empty state:** "Nothing scanned yet — ingest a sequence" with the four lane icons.
**Opening states:** if tensors exist → render immediately. If the sequence exists but no tensors → show sequence + **Scan** CTA. If neither exists locally (new device) → skeleton + hydrate via `GET /api/sequences/{sha}?format=u8` and `GET /api/analysis/{sha}` (doc 01 §8); offline → "Not cached on this device".

### 3.3 Component sketch

```tsx
export function HistoryDrawer() {
  const open = useUi(s => s.drawerOpen);
  const ids  = useHistory(s => s.visibleIds);          // already filtered+sorted
  const open_ = useWorkbench(s => s.openHistoryItem);
  return (
    <aside role="complementary" aria-label="Analysis history" data-open={open}
           className="fixed inset-y-0 left-0 w-[360px] translate-x-[-100%] data-[open=true]:translate-x-0 transition-transform">
      <DrawerHeader /><HistoryFilters />
      <VirtualList itemHeight={72} count={ids.length} overscan={6}
        render={(i) => <HistoryRow key={ids[i]} id={ids[i]} onOpen={open_} />} />
    </aside>
  );
}
```

---

## 4. STATE MANAGEMENT

### 4.1 Stores (Zustand, MIT) and the Engine

| Unit | Holds | Update rate |
|---|---|---|
| `useIngest` store | modal open, tab, `IngestPhase`, drafts | user events |
| `useHistory` store | `records: Map<scan_id, HistoryRecord>`, filters, sort, `visibleIds`, `lastRev`, sync status | events + sync |
| `useWorkbench` store | `active` (identity + metadata), `scanStatus`, `channels`, `speedBps`, `playing`, `morph{blend,auto,gain}`, `hud{tracks,cvdPalette,audio,view}`, `selectedBase`, `mutations`, `snapshot{headPos, filledUpTo}` (≤10 Hz) | events; snapshot throttled |
| **Engine** (plain class, singleton) | `codes: Uint8Array`, `planes: Float32Array[13]` ring/full buffers, `headPos`, clock, `GeometryTable`, FCGR grid handle, audio scheduler | every frame (never in React) |

```ts
// store/useWorkbench.ts (shape)
interface WorkbenchState {
  active: { sha256: string; scanId: string; length: number; molecule: Molecule; name: string } | null;
  scanStatus: "idle" | "connecting" | "analyzing" | "streaming" | "complete" | "error";
  channels: ChannelInfo[];
  speedBps: number; playing: boolean;
  morph: { blend: number; auto: boolean; gain: number };          // auto=false by default (heuristic)
  hud: { tracks: Record<string, boolean>; cvdPalette: boolean; audio: boolean; view: "2d" | "3d" };
  selectedBase: number | null;
  mutations: Mutation[];
  snapshot: { headPos: number; filledUpTo: number };
  openHistoryItem(sha256: string, scanId: string): Promise<void>;
  openIngestItem(item: IngestItem): Promise<void>;
  startScan(opts?: { force?: boolean }): void;
  mutate(pos: number, alt: "A"|"C"|"G"|"T"): void;
  setHead(pos: number): void; setSpeed(bps: number): void; togglePlay(): void;
}
```

```ts
// engine/Engine.ts (shape)
export class Engine {
  headPos = 0; speedBps = 50; playing = false; length = 0;
  codes = new Uint8Array(0);
  planes: Float32Array[] = [];          // index = channel id; length = sequence length (NaN until filled)
  filledUpTo = 0;
  geom!: GeometryTable;                  // §6.4
  private last = 0;
  tick(now: number) {                    // called by the single rAF loop
    const dt = (now - this.last) / 1000; this.last = now;
    if (this.playing) this.headPos = Math.min(this.headPos + this.speedBps * dt, this.filledUpTo, this.length - 1);
  }
  load(payload: LoadedWorkbench) { /* swap buffers, rebuild geometry, reset FCGR; no allocations afterwards */ }
}
```
A **single** `requestAnimationFrame` loop calls `engine.tick(now)` then each registered painter (`HelixCanvas2D`, `HudTracks`, `CgrRadar`) in a fixed order. Painters never schedule their own rAF.

### 4.2 Event flow ↔ stores

```text
 /ws/events history_changed ─► historyStore.sync() ─► GET /api/history/sync?since_rev ─► IDB bulkPut ─► store update
 WS scan_ready              ─► workbench.channels, Engine.allocate(length)
 WS binary frame            ─► stream.worker.decode ─► Engine.writePlanes(start,count,planes)  (main thread, memcpy)
 Engine (10 Hz)             ─► workbench.snapshot {headPos, filledUpTo}
 WS scan_complete           ─► idb.putTensors(...) ; history row patch (anomaly_count,last_scanned_pos) ; scanStatus=complete
 WS mutation_result         ─► workbench.mutations.push ; idb.putMutation ; history.mutation_count++
```

### 4.3 `openHistoryItem` (the <5 ms path)
```ts
async function openHistoryItem(sha256: string, scanId: string) {
  const t0 = performance.now();
  const { seq, tensors, muts } = await idb.loadWorkbench(sha256);   // ONE readonly tx over [sequences,tensors,mutations]
  if (!seq) return hydrateFromServer(sha256, scanId);               // new-device path (§3.2)
  engine.load({ codes: new Uint8Array(seq.codes), planes: tensors ? splitPlanes(tensors) : emptyPlanes(seq.length) });
  set({ active: {...}, mutations: muts, scanStatus: tensors ? "complete" : "idle" });
  if (!tensors) /* UI shows Scan CTA */;
  perf.mark("open_history", performance.now() - t0);                // asserted in P6.3 benchmark (<5 ms for ≤50 kb)
}
```
`splitPlanes` creates `Float32Array` **views** (no copy) over the stored planar ArrayBuffer (`01` §7.3 layout). The head position is restored from `last_scanned_pos`.

---

## 5. HELIX VISUAL ENGINE — GEOMETRY & MATH

### 5.1 Constants (single source: `lib/constants.ts`; matches `00` §6)

| Quantity | B-DNA value | Symbol |
|---|---|---|
| Rise per base pair | 0.34 nm | `RISE` |
| Pitch (one turn) | 3.4 nm | `P` |
| Bases per turn | 10 (=P/RISE) | `BPT` |
| Twist per base | 36° (2π/10) | `ω₀` |
| Major / minor groove | 2.2 nm / 1.2 nm | `W_maj`, `W_min` |
| Helix diameter | 2.0 nm (radius `R`=1.0) | `R` |
| H-bonds | A–T: 2 · G≡C: 3 | |

> **Note:** real B-DNA averages ≈10.5 bp/turn; this project fixes the **spec constants** above (pitch 3.4 / rise 0.34 ⇒ 10 bp/turn) for the schematic. The turn counter is `cumTh[i] / 2π` (≈ `i/10` in B-form), **not** `i/10.5`.

### 5.2 Strand curves (side view, axis horizontal)
Let `z` be axial position (nm), `θ₁(z)` the phase of strand 1 (the 5'→3' reading strand), `Δ` the phase offset to strand 2 (the complement, antiparallel).

```text
 strand 1:  x = z·s     y₁ = R·sin θ₁(z)·s     depth₁ = cos θ₁(z)
 strand 2:  x = z·s     y₂ = R·sin θ₂(z)·s     depth₂ = cos θ₂(z),    θ₂ = θ₁ + Δ
 s = pixels per nm (DPR-aware).   depth > 0 ⇒ nearer the viewer ("front").
 B-form:    θ₁(z) = H·2π·z / P,   H = +1 (right-handed)       → θ₁(base i) = 2π·i / 10
```
**Groove offset from spec widths.** Define groove width as the *axial distance between consecutive front crossings* (points where a strand passes `y=0` with `depth>0`, i.e. `θ ≡ 0 mod 2π`). Strand 2's front crossing occurs when `θ₁ ≡ −Δ`, so the two crossings are separated axially by `P·Δ/2π`. Choosing

```text
 Δ = 2π · W_min / P = 2π · 1.2 / 3.4 = 2.2176 rad  (127.06°)
```
gives a minor-groove gap of exactly `1.2 nm` and the complementary gap `P − 1.2 = 2.2 nm` = the major groove, **matching both spec values simultaneously** (they sum to the pitch in this schematic). Handedness sign `H` is validated visually against a reference image in P7.2 (acceptance: right-handed B-form).

### 5.3 Per-base geometry table with morphing (stable under head movement)
Phase must not jump as the head slides, so phase is **absolute**, from prefix sums over the whole sequence, rebuilt (in a worker) only when morph inputs change.

```ts
// engine/helixGeometry.ts
export const GEO = { RISE: 0.34, PITCH: 3.4, BPT: 10, MAJOR: 2.2, MINOR: 1.2, R: 1.0 } as const;
export const DELTA = (2 * Math.PI * GEO.MINOR) / GEO.PITCH;       // 2.2176 rad
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => x * x * (3 - 2 * x);

export interface GeometryTable { cumZ: Float32Array; cumTh: Float32Array; morph: Float32Array; length: number; }

export function buildGeometryTable(L: number, zProp: Float32Array | null, blend: number, auto: boolean, gain: number): GeometryTable {
  const cumZ = new Float32Array(L + 1), cumTh = new Float32Array(L + 1), morph = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const zp = auto && zProp && Number.isFinite(zProp[i]) ? gain * zProp[i] : 0;
    const s = smooth(Math.min(1, Math.max(0, blend + zp)));           // s: 0 = B-DNA, 1 = Z-DNA
    morph[i] = s;
    const rise = lerp(0.34, 0.37, s);                                 // Z-DNA rise 0.37 nm
    const bpt  = lerp(10, 12, s);                                     // Z-DNA 12 bp/turn
    const omega = (2 * Math.PI / bpt) * Math.cos(Math.PI * s);        // sign flips through 0 at s=0.5 (unwinds, then rewinds left-handed)
    cumZ[i + 1]  = cumZ[i]  + rise;
    cumTh[i + 1] = cumTh[i] + omega;
  }
  return { cumZ, cumTh, morph, length: L };
}
```
- **B→Z morph** (`blend` slider 0→1, or auto from `z_propensity` channel 4 when `morph.auto`): rise 0.34→0.37 nm, 10→12 bp/turn (pitch ≈ 4.44 nm), radius 1.0→0.9 nm (`R(s)=lerp(1,0.9,s)`), handedness via `cos(πs)`, plus a **zig-zag** term for Z: `θ₁ᵢ += (−1)^i · 0.35 · s` rad (alternating offset on strand 1; strand 2 gets the opposite sign). This is a *schematic* of the B→Z transition, not a physical simulation; the inspector must say so. `Δ` is held constant so groove labels remain comparable.
- `auto` is **off by default**; `z_propensity` is a heuristic (C-9).

### 5.4 Sampling & draw order

```ts
function sample(tab: GeometryTable, u: number, strand: 0 | 1) {       // u = fractional base index
  const L = tab.length, i = Math.min(L - 1, Math.max(0, Math.floor(u))), f = u - i;
  const z  = tab.cumZ[i]  * (1 - f) + tab.cumZ[i + 1]  * f;
  const th = tab.cumTh[i] * (1 - f) + tab.cumTh[i + 1] * f
           + (strand ? DELTA : 0) + zig(i, strand, tab.morph[i]);
  const R  = lerp(1.0, 0.9, tab.morph[i]);
  return { z, y: R * Math.sin(th), depth: Math.cos(th), th };
}
```
Per frame (window = `head ± 20` bases, 8 samples per base ⇒ ≈ 330 points per strand):
1. Compute `x = cx + (z − zHead)·s`, `y = cy − y·s`.
2. Draw **back** segments (depth ≤ 0): alpha 0.40, width 2 px.
3. Draw **rungs** (base pairs) at integer `u`: two half-rungs coloured by base (strand 1 base from `codes[i]`, strand 2 = complement), alpha from `0.35 + 0.65·(depth₁+depth₂+2)/4`; H-bond ticks (2 or 3, perpendicular short lines at 33/50/67% along the rung when the projected rung length > 14 px).
4. Draw **front** segments (depth > 0): alpha 1.0, width 3 px, with a subtle gradient by `ΔG` (see §5.8).
5. Overlays: attention glow (radial gradient at each base, alpha `attn^1.5`), thermo strip, anomaly band, groove brackets (§5.5), reading-head reticle (vertical cyan line at `x=cx`, caret ▼, label with position and turn).

Never allocate in the loop: reuse preallocated `Float32Array` scratch for `x,y,depth`.

### 5.5 Groove bracket logic
Brackets are dimension lines (`├──┤`) with a label, drawn at the helix centreline (`y = cy`) between consecutive **front crossings** of alternating strands.

```ts
interface Crossing { z: number; strand: 0 | 1; }
// samplesZ[], samplesTh[] = dense samples of strand-1 phase over the window (th WITHOUT the Δ offset)
function findCrossings(samplesZ: Float32Array, samplesTh: Float32Array, n: number): Crossing[] {
  const out: Crossing[] = [], TAU = 2 * Math.PI;
  for (let strand = 0 as 0 | 1; strand < 2; strand++) {
    const off = strand ? DELTA : 0;
    for (let k = 0; k + 1 < n; k++) {
      const a = (samplesTh[k] + off) / TAU, b = (samplesTh[k + 1] + off) / TAU;
      if (Math.floor(a) !== Math.floor(b) && a !== b) {
        const m = b > a ? Math.floor(b) : Math.floor(a);            // integer crossed (θ ≡ 0 mod 2π)
        const t = (m - a) / (b - a);
        out.push({ z: samplesZ[k] + t * (samplesZ[k + 1] - samplesZ[k]), strand });
      }
    }
  }
  return out.sort((p, q) => p.z - q.z);
}

function groovesFrom(c: Crossing[], handedness: 1 | -1) {
  const res: { z0: number; z1: number; width: number; kind: "minor" | "major" }[] = [];
  for (let i = 0; i + 1 < c.length; i++) {
    if (c[i].strand === c[i + 1].strand) continue;                  // gaps only between different strands
    // right-handed (H>0): gap s2→s1 is minor; left-handed: gap s1→s2 is minor
    const minor = (handedness > 0 && c[i].strand === 1) || (handedness < 0 && c[i].strand === 0);
    res.push({ z0: c[i].z, z1: c[i + 1].z, width: c[i + 1].z - c[i].z, kind: minor ? "minor" : "major" });
  }
  return res;
}
```
- `handedness = sign(cumTh[iHead+1] − cumTh[iHead])` (0 within the unwound region ⇒ **no brackets**, gracefully).
- **Display:** only the turn nearest the reading head by default (one minor + one major bracket) to avoid clutter; a toggle shows all visible turns. Labels show **measured** widths (`1.20 nm`, `2.20 nm` in B-form; live values during morph). Tooltip: "Schematic axial measure; B-form reference 1.2 nm minor / 2.2 nm major."
- Hide a bracket if its pixel width < 28 px; collision-avoid labels by skipping any whose rect overlaps the previous one.
- **Unit test:** for `blend=0`, every minor bracket width = `1.2 ± 0.01` and major = `2.2 ± 0.01`.

### 5.6 Turn counter & dimensions panel
`turn = cumTh[floor(headPos)] / 2π` (absolute value; shown to 2 decimals) — in pure B-form `≈ headPos/10`. The dimensions chip shows live: rise, pitch (`(2π / |ω|) · rise` per base, i.e. rise·bpt), bp/turn, minor/major from §5.5.

### 5.7 Base-pair Inspector (face-on, ring geometry)
A side-view rung is edge-on (a base pair's plane is perpendicular to the axis), so true **purine/pyrimidine ring geometry is shown in the face-on inspector** for the base pair under the reading head (looking down the axis). Optional "ladder mode" in the main canvas unrolls the helix into a flat ladder using the same ring glyphs.

Ring construction in a local frame (unit: ring edge length = 1; +x points from the sugar attachment toward the partner base; origin = glycosidic attachment point):

```ts
const Rp  = 1 / (2 * Math.sin(Math.PI / 5));   // pentagon circumradius 0.8507
const apP = 1 / (2 * Math.tan(Math.PI / 5));   // pentagon apothem      0.6882
const apH = Math.sqrt(3) / 2;                  // hexagon apothem       0.8660
const poly = (cx: number, cy: number, n: number, R: number, rot: number) =>
  Array.from({ length: n }, (_, k) => [cx + R * Math.cos(rot + (2 * Math.PI * k) / n), cy + R * Math.sin(rot + (2 * Math.PI * k) / n)]);

export function baseRings(kind: "purine" | "pyrimidine") {
  if (kind === "pyrimidine")                       // C, T(U): one hexagon, vertex toward the sugar
    return { hex: poly(1, 0, 6, 1, Math.PI), pent: null, extent: 2.0 };
  const pentC = Rp;                                // purine A, G: 5-ring proximal, 6-ring distal, shared edge
  const hexC  = Rp + apP + apH;                    // 2.4049
  return { pent: poly(pentC, 0, 5, Rp, Math.PI), hex: poly(hexC, 0, 6, 1, Math.PI / 6), extent: hexC + apH }; // 3.2709
}
```
- Pair layout: purine glyph from its sugar attachment toward the centre (extent 3.27), pyrimidine glyph from the opposite attachment (extent 2.00, rotated π), H-bond gap `g ≈ 0.6` units; total rung `D = 3.27 + 2.00 + 0.6 + 2·s₀` (`s₀` = sugar offset ≈ 0.5). Scale so `D` fits the inspector width.
- **H-bonds:** A–T = 2 parallel dashed lines, G≡C = 3, drawn in the gap, perpendicular spacing 0.28 units; line weight and label ("2 H-bonds · weaker" / "3 H-bonds · stronger") follow the pair. Mutations to a mismatched pair (not representable on a Watson–Crick complement strand) are not applicable: the complement strand is always the Watson–Crick partner of the current base.
- Backbone: sugar-phosphate dots at both attachment points on the circle of radius `R`; neighbouring pairs (±3) drawn faintly, rotated by the local twist `ω`, to show stacking.
- Ambiguity code (`code=4`): draw a dashed outline "N" glyph, no H-bonds.

### 5.8 Heat and glow mappings
| Channel | Visual | Mapping |
|---|---|---|
| `tm_c` | Tm heat strip under the helix | linear colour ramp; domain = `[p2, p98]` of finite values for the sequence (computed once) |
| `dg_kcal` | front-strand tint | more negative ΔG = more stable = cooler/denser |
| `attention` | radial glow on bases | `alpha = attention^1.5`, colour `--attn`, radius ∝ 0.6·pitch/2 |
| `anomaly_score` | red hatched band above helix | `≥ 0.5` (the alert threshold, `03` §7) drawn solid |
| `z_propensity` | small Z-badge under bases | shown if `> 0.5` |

`NaN` samples render as a neutral "no data" hatch (never as zero).

### 5.9 Hit-testing & the mutation interaction
- **Primary target — the 5'→3' Sequence Strip** (41 buttons centred on the head): each is a real `<button aria-label="Position 1234 (1-based), A. Choose substitution">`. Click opens a 3-option popover (the other bases). **Shift+click applies the transition** (A↔G, C↔T) immediately. Selection sets `selectedBase` and sends WS `mutate` (`01` §4.4).
- **Canvas click** on a rung maps `x → base index` via binary search over the window's screen-x array (monotonic because rise > 0), then selects the base (no mutation without the strip/popover confirmation).
- While `mutate` is in flight the base shows a spinner ring; on `mutation_result`, HUD deltas animate (instant under reduced motion). The MutationPanel lists entries: position (1-based), `A→G`, ΔTm, ΔΔG, Δ promoter/CpG/splice, heuristic score with a visible "research heuristic" label (C-9); a **Revert** action removes the entry locally and via `DELETE` (doc 04 will add the endpoint).

### 5.10 3D toggle (optional, P7.8)
Three.js `TubeGeometry` along the same `GeometryTable` helix (shared maths): two tubes (strands) + instanced cylinders (rungs) + instanced spheres (phosphates). Only the window `head ± 40` is instanced. Controls via `OrbitControls`-equivalent written locally (no extra deps). Same hit-testing result must be exposed through the same `selectedBase` contract.

---

## 6. CHAOS GAME REPRESENTATION (CGR)

### 6.1 Definition (matches `00` §6)
Corners `A(0,0)`, `C(0,1)`, `G(1,1)`, `T(1,0)`; start `p₀=(0.5, 0.5)`:

```text
 pᵢ = (pᵢ₋₁ + corner(baseᵢ)) / 2
```
Ambiguity (`code 4`): the point is **not advanced** and the output is `NaN` for that position (the previous point is retained as state; no reset), consistent with `01` §5.

### 6.2 Two data paths (and why)
1. **Continuous trail (float):** channels `cgr_x`, `cgr_y` (ids 5, 6) from C++ feed the radar's "last 128 points" trail and cursor dot. Float32 precision is irrelevant visually.
2. **Density grid (integer-exact):** built in `cgr.worker.ts` **from the base codes**, *not* from float coordinates. Reason: after `k` steps the cell index at resolution `2^k` depends only on the last `k` bases; float32 rounding after ~24 steps can flip a cell near a boundary (e.g. long poly-G runs). Integer rolling indices avoid this.

### 6.3 Frequency-CGR (FCGR) index & rolling update
Per-base bits: `xbit(b) = b >> 1` (A0 C0 G1 T1), `ybit(b) = (b & 1) ^ (b >> 1)` (A0 C1 G1 T0), with codes `A0 C1 G2 T3`. For a grid `N = 2^k` the cell of the k-mer ending at `i` is

```text
 X = Σ_{j=1..k} xbit(base_j)·2^(j−1)      Y = Σ_{j=1..k} ybit(base_j)·2^(j−1)      (base_k = newest = most significant bit)
 rolling:  X' = (X >> 1) | (xbit(b) << (k−1))     Y' = (Y >> 1) | (ybit(b) << (k−1))
```
```ts
// workers/cgr.worker.ts
export function accumulate(grid: Uint32Array, k: number, codes: Uint8Array, from: number, to: number, st: {X: number; Y: number; run: number}) {
  const N = 1 << k, top = k - 1;
  for (let i = from; i < to; i++) {
    const b = codes[i];
    if (b > 3) { st.run = 0; continue; }                         // ambiguity breaks the k-mer run
    st.X = (st.X >> 1) | ((b >> 1) << top);
    st.Y = (st.Y >> 1) | (((b & 1) ^ (b >> 1)) << top);
    if (++st.run >= k) grid[(N - 1 - st.Y) * N + st.X]++;        // flip Y so G/C corners are at the top
  }
}
```
Default `k = 7` (128×128 = 16,384 cells). To start `st.run` must be re-primed when seeking: on a backward seek, reset grid and re-accumulate `0 → head` (O(head), done in the worker, ~10–15 ms for 1 Mbp); forward movement accumulates only `lastHead → head`.

**Index bridge to the C++ k-mer matrix** (`hash h = ((h<<2)|b) & mask`, earliest base = most significant):
```ts
export function kmerToCell(h: number, k: number) {
  let X = 0, Y = 0;
  for (let j = 1; j <= k; j++) { const b = (h >> (2 * (k - j))) & 3; X |= (b >> 1) << (j - 1); Y |= ((b & 1) ^ (b >> 1)) << (j - 1); }
  return { X, Y };
}
```
**Unit test (required):** for any sequence with no ambiguity, the worker's grid at `k=4` equals the C++ `kmer_matrix(k=4, window=L, stride=L)` row mapped through `kmerToCell`.

### 6.4 Rendering the radar
- Offscreen `ImageData` of `N×N` as `Uint32Array`; value `v = log1p(count)/log1p(max)`; palette = deep navy → cyan → white LUT (256 entries); nearest-neighbour upscale (`imageSmoothingEnabled=false`) to ~240 px.
- Radar chrome (vector overlay): concentric rings at 25/50/75%, crosshair, corner labels A C G T, **cursor dot** at `(cgr_x, cgr_y)[head]`, trail of the last 128 finite points fading with age, and optional sweep line rotating at 1 turn/10 s (decorative; disabled under reduced motion).
- Modes: **Cumulative** (default, grid fills up to the head) · **Local** (window of the last 5,000 bases only, recomputed in the worker) — local mode highlights regional composition drift.
- Throttle: grid → canvas at 30 fps; trail at display rate.

---

## 7. SONIFICATION (WEB AUDIO)

- **Default muted.** `AudioContext` is created/resumed only on the user's first interaction with the 🔊 control.
- Mapping per note slot: base → pitch (`A 261.63 Hz`, `C 329.63`, `G 392.00`, `T 523.25`); attention → gain `0.02 + 0.18·attn`; local GC% → low-pass cutoff `400 + 40·GC` Hz; `anomaly_score ≥ 0.5` → +30-cent detune and a short noise burst.
- Rate limiter: at most **12 notes/s**; at higher head speeds each slot plays the base with the highest attention in that slot.
- Scheduling: look-ahead 100 ms using `audioCtx.currentTime`; notes scheduled from `Engine.headPos`, so pausing/seeking cancels scheduled nodes. Master gain hard-limited to 0.25.

---

## 8. HUD TRACKS & MINIMAP

Tracks (toggle each; order fixed): GC% · GC skew · Tm · ΔG · attention · promoter · CpG · splice donor/acceptor · anomaly. Each is a 1-D `Canvas` strip rendering the window `head ± 200` bases at 1 px/bp (decimated by min/max if zoomed out). A minimap shows the whole sequence (`OVERVIEW` frame bins, `01` §7.3) with anomaly marks and a draggable head marker (seek). Tooltips on hover show channel value at that position; keyboard: `←/→` move head by 1 base, `Shift+←/→` by 10, `Space` play/pause, `+/−` speed.

---

## 9. ACCESSIBILITY & PERFORMANCE

- All controls keyboard-operable; focus ring uses `--head`; contrast ≥ 4.5:1 for text; canvases have an `aria-label` and a text summary of the current window (position, bases, turn, key channel values) in a visually hidden live region updated at 1 Hz (not per frame).
- Respect `prefers-reduced-motion` and `prefers-color-scheme` (dark default; no light theme in v1).
- Budgets (`01` §14): ≤ 16.6 ms frame, JS ≤ 8 ms; CGR worker updates never block the main thread; no per-frame allocations (verified by a dev-only counter); memory for a 5 Mbp tensor (13 channels × 4 B × 5 M = 260 MB) justifies lazy hydration: only channels with visible tracks are decoded into `Float32Array` views at scan start; others remain in the stored ArrayBuffer until toggled on.

---

## 10. TEST PLAN (UI + MATH)

| Test | Type | Pass criterion |
|---|---|---|
| Canonicalize/hash golden vectors | unit (TS+Py shared) | identical `sha256` |
| `buildGeometryTable(blend=0)` | unit | `cumTh[10]=2π ± 1e-5`; `cumZ[10]=3.4 ± 1e-5` |
| Groove widths (B-form) | unit | minor 1.2 ± 0.01, major 2.2 ± 0.01 |
| Morph continuity | unit | `cumTh` and `cumZ` monotone-continuous; `ω` crosses 0 at `s=0.5` |
| Ring geometry | unit | purine extent 3.2709 ± 1e-3; pyrimidine 2.0 |
| FCGR vs C++ k-mer matrix | unit/integration | exact equality at `k=4` |
| History open | perf | median < 5 ms for ≤50 kb seq + tensors |
| Draw loop | perf | p95 frame < 16.6 ms at 1080p, DPR 2 |
| Ingestion lanes | Playwright | all four lanes; error mapping; undo delete |
| Reduced motion / keyboard | a11y | axe-core clean; full keyboard path |

---

## 11. INTERCONNECTION MATRIX (UI LAYER)

| Caller | Callee | Payload / channel | Purpose |
|---|---|---|---|
| `IngestionModal` | `api/http.ts` → `/api/ingest/*` | request models (`01` §10–11) | four-lane ingestion |
| `useIngest` | `historyStore`, `idb` | `HistoryRecord[]` | optimistic history + offline cache |
| `HistoryDrawer` | `workbenchStore.openHistoryItem` | `(sha256, scan_id)` | instant reload (<5 ms) |
| `historyStore.sync` | `GET /api/history/sync` | `since_rev` → upserts/deleted | IDB ⇄ DuckDB reconcile |
| `workbenchStore.startScan` | `wsClient` `/ws/scan` | `start_scan` JSON | scan |
| `wsClient` | `stream.worker` | transferable ArrayBuffer | decode frames |
| `stream.worker` / main | `Engine.writePlanes` | planar float32 | fill ring buffers |
| `Engine` | `HelixCanvas2D`, `HudTracks`, `CgrRadar`, `Sonifier` | in-memory reads per frame | rendering/audio |
| `Engine` | `workbenchStore.snapshot` | `{headPos, filledUpTo}` @10 Hz | React text/controls |
| `ReadingHeadStrip` click | `wsClient` `mutate` | `{request_id, scan_id, position, alt}` | in-silico mutation |
| `mutation_result` | `MutationPanel`, `idb.mutations`, `historyStore` | `Mutation` | log + history count |
| `cgr.worker` | `Engine` | `Uint32Array` grid (transferable) | radar image |
| `buildGeometryTable` (worker) | `Engine.geom` | `GeometryTable` buffers | stable helix phase |

---

## 12. PHASE-TRACKER REFINEMENTS (apply to `00` §8)

```text
P6.5 → split: [ ] P6.5a IngestionModal (4 tabs, state machine, error mapping)  [ ] P6.5b HistoryDrawer (virtualized, filters, undo-delete)
P7.1 → add:   [ ] P7.1b Engine + single rAF loop + snapshot throttle
P7.2 → add:   [ ] P7.2b GeometryTable worker (absolute phase) + handedness visual check
P7.3 → add:   [ ] P7.3b Groove brackets (+unit tests)  [ ] P7.3c Base-Pair Inspector rings
P7.7 → split: [ ] P7.7a FCGR worker (integer rolling) + C++ k-mer bridge test  [ ] P7.7b Radar chrome  [ ] P7.7c Sonifier
```