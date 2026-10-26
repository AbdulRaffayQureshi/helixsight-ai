# 01_SYSTEM_ARCHITECTURE_AND_DATAFLOW.md

> **HelixSight AI** · Document `01` of `05` · Depends on: `00_MASTER_CONTEXT_AND_RULES.md`
> Scope: ingestion flows, cache logic, analysis pipeline, WebSocket lifecycle, and **exact data contracts**.

---

## 1. LEGEND & READING GUIDE

```text
  ───►   synchronous call / HTTP request          ═══►  binary payload / memory handoff
  ◄───   response                                  ┄┄►   async event / WebSocket message
  [X]    component                                  (n)   step number referenced in narrative
  HIT / MISS   DuckDB / IndexedDB cache outcomes
```

Component aliases used below:

| Alias | Real component |
|---|---|
| **UI** | React app (`frontend/src/components/*`) |
| **IDB** | IndexedDB via `frontend/src/db/repo.ts` |
| **API** | FastAPI routers (`backend/src/helixsight/api/*`) |
| **PIPE** | `ingestion/pipeline.py::ingest_records` |
| **SAN** | `ingestion/sanitizer.py` (+ `hasher.py`) |
| **DB** | DuckDB via `db/duckdb_store.py` |
| **NCBI** | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/` |
| **RCSB** | `https://www.rcsb.org/fasta/...` and `https://data.rcsb.org/rest/v1/core/...` |
| **CORE** | `helixsight_core` C++20 module via pybind11 |
| **ML** | `ml/inference.py` (PyTorch / ONNX Runtime) |
| **SESS** | `streaming/session.py::ScanSession` |
| **WRK** | `workers/stream.worker.ts` |
| **CANVAS** | `components/helix/HelixCanvas2D.tsx` |

---

## 2. TOPOLOGY OVERVIEW

```text
┌──────────────────────────────── BROWSER (PWA) ─────────────────────────────────────┐
│  [UI: Ingestion Panel]  [History Drawer]  [Helix Canvas]  [HUD]  [Mutation Panel]   │
│        │ HTTP JSON            ▲ read <5ms          ▲ 60fps draw                      │
│        │                      │                    │                                │
│        │               [IDB: history|sequences|tensors|mutations|meta]              │
│        │                      ▲ sync(rev)           │                                │
│        │                      │            [WRK: Web Worker, ring buffers]          │
│        │                      │                    ▲ ArrayBuffer (transferable)     │
└────────┼──────────────────────┼────────────────────┼─────────────────────────────────┘
         │ POST /api/ingest/*   │ GET /api/history*   │ WS /ws/scan  (binary + JSON)
         ▼                      │                    │ WS /ws/events (JSON)
┌──────────────────────────────── FASTAPI (Python 3.11) ──────────────────────────────┐
│ routes_ingest ─► PIPE ─► SAN ─► DB (sequences, accession_index, scan_history)        │
│      │             ▲                                                                 │
│      │   ncbi_client / pdb_client (httpx, async, rate-limited)  ──► NCBI / RCSB      │
│      │   file_ingest / watcher(watchdog) ◄── ~/helixsight_watch/*.fasta              │
│ ws_scan ─► SESS ═► core_bridge ═► CORE (C++20)   ═► ML (PyTorch/ONNX) ─► DB cache    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Rule of the topology:** the browser never talks to NCBI/RCSB directly (CORS, rate-limit control, single cache). All external fetches go through the backend, which is the only place the SHA-256/accession cache is consulted before network egress.

---

## 3. FLOW A — INGESTION (FOUR LANES → ONE PIPELINE)

### 3.0 Shared canonicalization & hashing spec (applies to all lanes)

Implemented twice and kept identical: `backend/.../ingestion/sanitizer.py` and `frontend/src/lib/canonicalize.ts`. Both are tested against a shared **golden-vector file** (`docs/golden_vectors.json`, created in P2.3).

```text
canonicalize(text) -> list[CanonicalRecord]
  1. Normalize newlines (\r\n, \r -> \n); strip BOM.
  2. If any line starts with '>':  split into records at each '>' header.
     Header text -> display_name (first token) + description (rest).
     Else: treat entire text as ONE raw record (name = label or "pasted-<sha8>").
  3. For each record's body lines:
       a. drop whitespace (space, tab, \n)
       b. drop digits (GenBank-style line numbers: "  61 atgc...")
       c. drop '*' and '-' (terminators / alignment gaps)
  4. uppercase.
  5. if 'U' in body and 'T' not in body: body = body.replace('U','T'); molecule='RNA'
     else molecule='DNA'
  6. validate every char ∈ "ACGTRYSWKMBDHVN" else INVALID_IUPAC (report first bad char + 0-based offset)
  7. if len == 0: EMPTY_SEQUENCE; if len > MAX_BP: SEQUENCE_TOO_LONG
  8. sha256 = hex( SHA256( utf8("hs1:" + body) ) )
  9. stats: length, gc_pct = (G+C) / (A+C+G+T) * 100 (ambiguity codes excluded), ambiguous_count
```

> **Why identity excludes source:** `NM_004006` fetched from NCBI and the same letters pasted later yield the same `sha256`, so they share one `sequences` row and one tensor cache; only `scan_history`/`source_records` rows differ.

### 3.1 Cache decision table (used by PIPE for every lane)

| Lane | Pre-network key | Step | Outcome |
|---|---|---|---|
| NCBI | `accession_index(source='NCBI', accession_key)` | If row exists and not expired and `force_refresh=false` → load `sha256` | `HIT_ACCESSION` (no network) |
| NCBI | after fetch | canonicalize → `sha256`; `sequences` has it? | `HIT_SHA` (network used, no new sequence row) else `MISS_STORED` |
| PDB | `accession_index(source='PDB', accession_key='1BNA:1')` (entry:entity) | same as above | `HIT_ACCESSION` / `HIT_SHA` / `MISS_STORED` |
| PASTE | none | canonicalize → `sha256` lookup | `HIT_SHA` / `MISS_STORED` |
| FILE | none | canonicalize each record → `sha256` lookup | `HIT_SHA` / `MISS_STORED` |

- **Accession key normalization:** uppercase, trimmed. NCBI versioned accessions (`NC_045512.2`) are immutable → no expiry. Unversioned (`NM_004006`) resolve to the *latest* version at fetch time; store the resolved `accessionversion` from `esummary` and set `ttl_expires_at = now + 30 days`; after expiry, revalidate with a cheap `esummary` call (if version unchanged, extend TTL without re-downloading FASTA).
- Every outcome (including hits) still writes/updates a `scan_history` row and bumps `rev`, so the History Sidebar always reflects the latest activity.

### 3.2 Lane A1 — NCBI Entrez (`efetch`)

**Endpoints (free, public):**
```text
FASTA   GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi
          ?db=nuccore&id={ACCESSION}&rettype=fasta&retmode=text[&tool=helixsight&email=...&api_key=...]
META    GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi
          ?db=nuccore&id={ACCESSION}&retmode=json[&tool=...&email=...&api_key=...]
```
`esummary` JSON supplies title, organism, `accessionversion`, `slen` (used as a sanity check vs. parsed length). Rate limit: 3 requests/s without an API key (10/s with the free key); enforced client-side by an `asyncio` token bucket in `ncbi_client.py`. Retries: 3× exponential backoff on `429/5xx/timeout`.

```text
 UI(NcbiForm)         IDB            API(routes_ingest)      PIPE/SAN           DB                 NCBI
     │                 │                    │                    │               │                  │
 (1) │ validate regex ^[A-Za-z]{1,4}_?[0-9]+(\.[0-9]+)?$        │               │                  │
     │ (optional) local check: accession seen? ─►│ (offline hint only)           │                  │
 (2) │────────────── POST /api/ingest/ncbi {accession, force_refresh} ──►         │               │
 (3) │                 │                    │──ingest_ncbi()────►│               │                  │
 (4) │                 │                    │                    │─ SELECT accession_index WHERE     │
     │                 │                    │                    │   source='NCBI' AND key=? ───────►│
 (5) │                 │                    │                    │◄── row? ──────────────────────────│
     │                 │            ┌───────┴─ HIT & fresh ──────┤                                   │
     │                 │            │ (6a) SELECT sequences/scan meta by sha256 ─────────────────────►│
     │                 │            │ (7a) INSERT scan_history (rev++) ─────────────────────────────►│
     │                 │            └─ skip to (14)                                                  │
 (6b)│                 │                    │  MISS or expired:                                      │
     │                 │                    │──────────────── GET esummary ─────────────────────────►│
     │                 │                    │◄──────────────── JSON(meta) ───────────────────────────│
 (7b)│                 │                    │──────────────── GET efetch (fasta) ───────────────────►│
     │                 │                    │◄──────────────── ">NM_004006.3 ..." text ──────────────│
 (8) │                 │                    │                    │ canonicalize()→ sha256, stats     │
 (9) │                 │                    │                    │─ SELECT sequences WHERE sha256=? ►│
 (10)│                 │                    │                    │◄── exists? (HIT_SHA) / no (MISS) ─│
 (11)│                 │                    │                    │─ INSERT sequences (if MISS) ─────►│
 (12)│                 │                    │                    │─ INSERT source_records ──────────►│
 (13)│                 │                    │                    │─ UPSERT accession_index ─────────►│
     │                 │                    │                    │─ INSERT scan_history (rev++) ────►│
 (14)│◄──────────────── 200 IngestResponse{items[0]{sha256,cache_status,record}} ────────────────────│
 (15)│─ write history+sequence to IDB ─►│    │                    │               │                  │
 (16)│ History Drawer re-renders; active sequence = items[0]; (optional) auto-start scan via /ws/scan │
```

**Narrative.**
1. `NcbiForm` validates the accession pattern client-side (cheap fail).
2. It `POST`s `NcbiIngestRequest`.
3–5. `routes_ingest.py` hands off to `PIPE`, which first queries `accession_index`. This is the **offline-friendly fast path**: a prior fetch means no network even if the user is offline.
6a–7a. On a fresh hit, `PIPE` loads the existing sequence metadata and records a new `scan_history` row (so the user's activity log is complete) without touching NCBI.
6b–7b. On miss/expiry, `ncbi_client` calls `esummary` (metadata) then `efetch` (FASTA), respecting the rate limiter.
8–13. `SAN` canonicalizes and hashes; `PIPE` checks `sequences` by `sha256` (dedup), inserts new rows only when needed, and upserts `accession_index` mapping `NM_004006 → sha256`.
14–16. The response carries the full `HistoryRecord`; the UI stores it in IndexedDB so the next open is local-only.

### 3.3 Lane A2 — RCSB PDB

**Endpoints (free, public):**
```text
FASTA     GET https://www.rcsb.org/fasta/entry/{PDB_ID}                      (all polymer entities, multi-FASTA)
ENTRY     GET https://data.rcsb.org/rest/v1/core/entry/{PDB_ID}              (title, method, resolution, release date)
ENTITY    GET https://data.rcsb.org/rest/v1/core/polymer_entity/{PDB_ID}/{ENTITY_ID}   (entity type, chains, sequence)
```
A PDB entry can contain several polymer entities (protein *and* nucleic acid). HelixSight is nucleotide-centric, so `pdb_client.py`:
1. Fetches the multi-FASTA and `entry` metadata.
2. Classifies each entity (via `polymer_entity` → `entity_poly.type`, e.g. `polydeoxyribonucleotide`, `polyribonucleotide`, vs. `polypeptide(L)`).
3. If `entity_id` omitted: selects the **first nucleic-acid entity**. If none exists → `422 PDB_NO_NUCLEIC_ACID` (response lists the protein entities found so the UI can explain).
4. Passes the selected entity's sequence into the shared pipeline. Modified/unknown residues (`N`, `X`) become ambiguity `N` per Section 3.0.

```text
 UI(PdbForm)                API                PIPE            DB                    RCSB
  │ regex ^[0-9][A-Za-z0-9]{3}$                                                          │
  │── POST /api/ingest/pdb {pdb_id:"1BNA", entity_id?:null} ─►│                           │
  │                         │── ingest_pdb() ─►│ accession_index lookup key "1BNA:*" ─────►│DB
  │                         │                  │◄ HIT? → resolve entity→sha256, skip net  │
  │                         │                  │── GET /fasta/entry/1BNA ───────────────────────────►│
  │                         │                  │◄─ multi-FASTA ─────────────────────────────────────│
  │                         │                  │── GET /core/entry/1BNA ───────────────────────────►│
  │                         │                  │◄─ JSON metadata ───────────────────────────────────│
  │                         │                  │── GET /core/polymer_entity/1BNA/{n} (each) ───────►│
  │                         │                  │◄─ JSON (entity_poly.type, chains) ─────────────────│
  │                         │                  │ choose nucleic-acid entity → canonicalize → sha256  │
  │                         │                  │── INSERT/UPSERT sequences, source_records(meta_json=PDB meta),
  │                         │                  │   accession_index("1BNA:{entity}"), scan_history(rev++) ►DB
  │◄──────────── 200 IngestResponse{items:[...], warnings:["entity 2 skipped: protein"]} ──│
```

`items` may contain **multiple** entries if the user requested all nucleic-acid entities (`entity_id: null, all_nucleic_acid: true` — optional flag; default is first entity only).

### 3.4 Lane A3 — Direct FASTA / Raw Paste

```text
 UI(PasteModal)                                   API                 PIPE/SAN                DB
   │ user pastes ">seq1\nATGC...\n>seq2..." or "1 atgcatgc 9 ttgacc..."                          │
   │ live preview: canonicalize.ts (TS) shows length/GC%/first bad IUPAC char + sha256 (WebCrypto)│
   │ IDB lookup by predicted sha256: HIT → offer "Open instantly (cached)"  [no server call]     │
   │── POST /api/ingest/paste {text, label?} ───────►│── ingest_paste() ─►│ canonicalize (Py)    │
   │                                                 │                    │ assert sha256 == client's (debug) 
   │                                                 │                    │─ SELECT sequences ───►│
   │                                                 │                    │─ INSERT as needed ───►│
   │◄─────────── 200 IngestResponse{items[n]} ───────│                    │                      │
```

**Narrative.** The paste box is *dual-validated*: TypeScript provides instant feedback and an **offline cache probe** (compute the SHA-256 with WebCrypto, check IndexedDB). If the hash hits locally, the UI can reopen the sequence with zero network traffic. Otherwise the raw text goes to the server, whose canonicalization is the authority. A mismatch between client and server hashes is a bug → logged and covered by golden vectors. Multi-record FASTA yields one `items[]` entry per record; the UI activates the first and lists the rest in History.

### 3.5 Lane A4 — Local File Drop & Directory Watcher

Two entry points, one pipeline.

**(i) Drag-and-drop (browser):**
```text
 UI(FileDropZone) ── POST /api/ingest/file (multipart/form-data, field "files", ≤ 50 MB each) ─► API
   API reads bytes → decode UTF-8 (errors='replace') → PIPE.ingest_records(source='FILE', name=filename)
 ◄─ IngestResponse (same shape as other lanes)
```
Accepted extensions: `.fasta .fa .fna .fas .txt`; content is validated, not trusted by extension.

**(ii) Watched folder (server-side):**
```text
 OS writes file ► watchdog Observer (thread) ┄► loop.call_soon_threadsafe(queue.put, path)
        │ debounce 500 ms until size stable (avoids half-written files)
        ▼
 asyncio consumer (watcher.py) ─► read file ─► PIPE.ingest_records(source='FILE', name=path.name)
        ▼
 DB (scan_history rev++) ─► ws_events.broadcast({"type":"ingest_complete", "item": HistoryRecord})
        ▼
 UI (/ws/events listener) ─► history/sync (since_rev) ─► IDB ─► Drawer shows new FILE item + toast
```
**WSL2 note (C-5):** default `WATCH_DIR=~/helixsight_watch`. If the path starts with `/mnt/`, use `PollingObserver` (2 s interval).
**Thread-safety note:** `watchdog` callbacks run in a worker thread; they must *only* enqueue paths onto the asyncio queue via `loop.call_soon_threadsafe`. They must never touch DuckDB directly.

### 3.6 Populating the History Sidebar (all lanes)

```text
 IngestResponse(items[]) ─► UI store ─► IDB.put(history, sequences)  [immediate, optimistic]
                                    └─► Drawer reads IDB index "by_created_at desc"
 Periodic / on-focus / on-/ws/events:
     GET /api/history/sync?since_rev={meta.last_rev}
        ◄── { latest_rev, upserts:[HistoryRecord...], deleted:[scan_id...] }
     IDB.bulkPut(upserts); IDB.bulkDelete(deleted); meta.last_rev = latest_rev
```

Each Drawer row binds to a `HistoryRecord`: `display_name | accession`, `source` badge, `length`, `gc_pct`, `anomaly_count`, `last_scanned_pos`, `created_at/updated_at`.

**Instant reload (<5 ms) path:**
```text
 click row ─► repo.loadWorkbench(sha256):
     one IDB readonly transaction over stores [sequences, tensors, mutations] (parallel gets)
       sequences[sha256]  -> ArrayBuffer (1 byte/base, codes 0..4) + display string metadata
       tensors[sha256+model_version+params_hash] -> ArrayBuffer (planar float32) + channel registry
       mutations.by_sha(sha256) -> Mutation[]
     ─► store.setActive() ─► CANVAS paints from the in-memory arrays   (no fetch, no WS, no inference)
 If tensors missing (never analyzed on this device): UI shows "Scan" CTA → Flow B.
```

---

## 4. FLOW B — ACTIVE SEQUENCE → C++ → ML → CACHE → WEBSOCKET → CANVAS

### 4.1 Pipeline overview

```text
 DuckDB sequences.residues (VARCHAR)
        │ (1) load
        ▼
 core_bridge.buffers.encode()  ══►  numpy uint8[L]  (C-contiguous, codes 0..4)  ← allocated ONCE per scan
        │ (2) pass pointer (buffer protocol, no copy)
        ▼
 helixsight_core (C++20, GIL released)
     gc_windowed(seq, w, stride, out_gc[], out_skew[])
     thermo_nn(seq, w, na_mM, out_tm[], out_dg[])
     zdna_propensity(seq, w, out_z[])
     cgr_points(seq, out_xy[2L])
     kmer_matrix(seq, k=4, win=1024, stride=256, out_counts[nWin,256])   ← feeds IsolationForest
        │ (3) results are written INTO Python-owned numpy buffers (out-params) ═► zero-copy
        ▼
 ml.inference
     one-hot (4×L) windows [1024, stride 512, overlap stitched by averaging]
     CNN+BiLSTM → p_promoter, p_cpg, p_splice_donor, p_splice_acceptor, attention
     anomaly.score(kmer_matrix) → anomaly_score per window → broadcast to per-position
        │ (4) assemble planar float32 tensor [C × L]
        ▼
 DuckDB analysis_cache INSERT (sha256, model_version, params_hash, channels_blob, summary_json)
        │ (5) stream in chunks of 256 positions (or replay from cache)
        ▼
 ws_scan ┄► JSON scan_ready, then binary TELEMETRY_CHUNK frames, JSON events (anomaly_alert…)
        ▼
 Browser stream.worker ═► decode Float32Array views → ring buffers → postMessage(transfer)
        ▼
 HelixCanvas2D requestAnimationFrame @60 fps: draws window around reading head
        ▼
 IDB.tensors.put(...) when scan completes (so the NEXT open is local-only)
```

### 4.2 Full sequence diagram (new scan, cache miss)

```text
 UI/CANVAS        WRK              ws_scan/SESS          core_bridge/CORE         ML               DB
    │              │                     │                     │                  │               │
 (1)│─ connect WS /ws/scan ─────────────►│                     │                  │               │
 (2)│─ {"type":"hello","contract":1,"client":"web"} ─────────►│                     │               │
 (3)│◄─ {"type":"hello_ack","session_id","server":{core_version,model_version}} ─│                  │
 (4)│─ {"type":"start_scan","sha256":"…","window_bp":40,"speed_bps":50,"want":[channel ids]} ─►     │
 (5)│              │                     │─ SELECT analysis_cache WHERE (sha256,model_version,params_hash) ─────►│
    │              │                     │◄─ miss ────────────────────────────────────────────────────────────│
 (6)│              │                     │─ SELECT residues ───────────────────────────────────────────────────►│
    │              │                     │◄─ "ATGC…" ──────────────────────────────────────────────────────────│
 (7)│              │                     │═ encode → np.uint8[L] ═►│                  │               │
 (8)│              │                     │═ call native funcs (GIL released) ═► out buffers filled ◄══            │
 (9)│              │                     │═ windows → torch/ORT ════════════════════►│               │
(10)│              │                     │◄═ probs/attention/anomaly ═════════════════│               │
(11)│◄─ {"type":"scan_ready","sha256","length","channels":[{id,name,unit,min,max}],"chunk_positions":256,"cache":"MISS"}
(12)│              │                     │─ INSERT analysis_cache (write queue) ───────────────────────────────►│
(13)│◄══ BINARY frame #0: header(24B)+planar float32 [C×256] ═══════════│                  │               │
    │              │◄ ArrayBuffer ═══════│                     │                  │               │
(14)│              │ decode → ring buf; postMessage({chunk}, [buffer]) → main thread                           │
(15)│─ {"type":"ack","stream_seq":0} ───►│   (server keeps ≤ 8 unacked frames in flight)                      │
(16)│◄┄ {"type":"progress","pos":512,"fraction":0.04} ┄┄┄ (every ≥100 ms)                                      │
(17)│◄┄ {"type":"anomaly_alert","start":4096,"end":4608,"score":0.91,"kind":"composition_shift"} ┄            │
    │   … frames continue …                                                                                  │
(18)│◄┄ {"type":"scan_complete","anomaly_count":3,"duration_ms":412} ┄┄┄                                      │
(19)│              │ assemble full tensor → IDB.tensors.put; update history row (anomaly_count,last_scanned_pos)
(20)│─ POST /api/history/{sha}/progress {last_scanned_pos} (or WS "checkpoint") ─►│ DB UPDATE scan_history rev++
```

**Narrative.**
1–3. Handshake pins `contract_version` and reports `core_version`/`model_version`, which become part of the cache key.
4–5. `start_scan` names a sequence by `sha256`. The server computes `params_hash` from window/stride/Na⁺/k settings and checks `analysis_cache`. **Cache hit ⇒ jump to step 13 immediately** (frames are sliced directly from the stored blob; `scan_ready.cache="HIT"`).
6–8. On a miss, the residue string is loaded once and encoded to `uint8[L]`. C++ writes results into preallocated `float32` NumPy arrays that Python owns (details in §5).
9–10. `ml.inference` batches overlapping windows, runs the model, then stitches window outputs by averaging in overlaps.
11–12. `scan_ready` precedes data so the client can allocate typed arrays; the cache write is queued to the single DuckDB writer (never blocks streaming).
13–15. Binary frames flow with ack-based backpressure so a slow tab cannot grow server memory.
16–18. JSON events carry low-rate semantic information (progress, alerts, completion).
19–20. The client persists the assembled tensor to IndexedDB and checkpoints `last_scanned_pos`, completing the loop that makes the next load instant.

### 4.3 Reading head model (who owns the clock?)

- **Server streams analysis data; the client owns the reading head clock.** The server pushes telemetry as fast as backpressure allows (analysis for a 14 kb gene finishes in well under a second); the Web Worker maintains `headPos` advancing at `speed_bps` (user-set, default 50 bp/s) using `performance.now()` deltas, with fractional interpolation for smooth motion.
- Therefore the visual "scan" never stalls on network jitter, and **seek/pause/resume are client-only** (they only change `headPos`). The server is involved only for new analysis and mutations.
- `ReadingHeadWindow` samples the ring buffers for `[headPos - 20, headPos + 20]` and feeds `HelixCanvas2D`, which redraws each `requestAnimationFrame` (target 16.6 ms budget; see §14).

### 4.4 Mutation sub-flow (click a base)

```text
 UI click base @pos=1234 'A'→'G'
   ─► WS {"type":"mutate","sha256","position":1234,"alt":"G","request_id":"…"}
 SESS:
   1. copy sequence window [pos-512, pos+512] into a scratch uint8 buffer; apply alt
   2. CORE.thermo_nn on [pos-64, pos+64] (ref vs alt)  → Δ(Tm), Δ(ΔG)   (O(window), microseconds)
   3. ML.infer on the 1024-nt window (ref vs alt)       → Δ(promoter/cpg/splice), Δ(attention)
   4. pathogenicity.py combines: heuristic_score = f(Δprobabilities, ΔΔG, conservation-free) ∈ [0,1]
   5. INSERT mutations (mutation_id UUIDv7, parent sha256, position, ref, alt, deltas…); bump scan_history.mutation_count, rev++
 ◄┄ {"type":"mutation_result","request_id","mutation":{…Mutation…}}
 UI: updates HUD deltas, appends to Mutation log, writes to IDB.mutations; History row mutation_count updates via sync.
```
Reloading a history item restores saved mutations from IDB instantly. Mutations are stored as *edits on the parent sequence* (parent `sha256` + position/alt), not as new sequences, so the history list stays uncluttered.
**Label requirement (C-9):** `pathogenicity` is a research heuristic.

---

## 5. PYTHON ⇄ C++ MEMORY HANDOFF (EXACT RULES)

| Concern | Rule |
|---|---|
| **Input buffer** | `np.ndarray(shape=(L,), dtype=np.uint8, order='C')`, read-only from C++ (`py::array_t<uint8_t, py::array::c_style \| py::array::forcecast>` with `const` access). Built once from the residue string by `encode()` (also in C++ for speed). |
| **Output buffers** | Python **preallocates** every output (`np.empty((L,), np.float32)`, `np.empty((L,2), np.float32)` for CGR, `np.empty((nWin,256), np.uint32)` for k-mers). C++ receives them as writable `py::array_t<float>` and fills in place. C++ never allocates arrays that cross the boundary → no ownership ambiguity, no copies. |
| **GIL** | Each heavy function wraps its loop in `py::gil_scoped_release`, so the asyncio event loop (WebSocket I/O) stays responsive. Long calls are additionally dispatched via `await loop.run_in_executor(core_executor, fn, *args)` where `core_executor` is a small `ThreadPoolExecutor`. |
| **Lifetime** | Buffers are held by the `ScanSession` object until `scan_complete`/disconnect. C++ keeps **no** pointers after returning. |
| **Validation** | `core_bridge/buffers.py` asserts dtype, contiguity, length equality and `writeable` before every call; C++ rechecks sizes and throws `std::invalid_argument` (→ `ValueError`). |
| **Ambiguity handling** | Code `4` windows containing ambiguity produce `NaN` for Tm/ΔG; the frame packer keeps `NaN` (JS reads it as `NaN`, UI draws "no data" texture). |
| **Rolling math** | Thermo uses **prefix sums** of ΔH and ΔS over dinucleotide steps → each window's Tm/ΔG is O(1): `ΔH_w = P_H[e-1]-P_H[s] + init`, then `Tm = ΔH·1000 / (ΔS_salt + R·ln(C_T/4)) − 273.15`. Salt correction: `ΔS_salt = ΔS + 0.368·(N−1)·ln[Na⁺]`. |
| **k-mer counting** | 2-bit rolling hash `h = ((h << 2) \| b) & mask`; ambiguity resets the run counter. Window counts are maintained incrementally (add entering k-mer, subtract leaving one). |
| **Versioning** | `helixsight_core.__version__` string is read at startup and stored as `core_version` in cache rows; a change invalidates cached thermo channels. |
| **Fallback** | `native.py` exposes the same API with a slow NumPy fallback if the wheel is missing, logging a loud warning (dev convenience only; budgets in §14 not guaranteed). |

Exposed Python surface (names fixed for later docs):
```python
helixsight_core.encode(seq: str) -> np.ndarray[uint8]
helixsight_core.gc_windowed(seq: u8[L], window: int, stride: int, out_gc: f32[N], out_skew: f32[N]) -> None
helixsight_core.thermo_nn(seq: u8[L], window: int, na_mM: float, out_tm: f32[L], out_dg: f32[L]) -> None
helixsight_core.zdna_propensity(seq: u8[L], window: int, out_z: f32[L]) -> None
helixsight_core.cgr_points(seq: u8[L], out_xy: f32[L,2]) -> None
helixsight_core.kmer_matrix(seq: u8[L], k: int, window: int, stride: int, out_counts: u32[nWin, 4**k]) -> None
```
(Per-position channels are written for the window *centered* on each position; edge positions use clamped windows. The exact edge rule is specified in doc `03`.)

---

## 6. ML / CACHE KEY DETAILS

```text
params = { window_bp:20, stride:1, na_mM:50, k:4, win_ml:1024, stride_ml:512,
           anomaly:{kind:"isolation_forest", n_estimators:200, seed:42, window:1024, stride:256},
           channel_registry_version:1 }
params_hash   = sha256( canonical_json(params) )                  # sorted keys, no whitespace
analysis_key  = (sha256, model_version, core_version, params_hash)
```

- **Anomaly detection baseline:** IsolationForest is **fit on the sequence's own k-mer windows** (self-referential drift detection: what is unusual *within this sequence*), with `random_state=42`. Optionally, a pre-trained autoencoder baseline (`ml_models/`) can score deviation from a reference corpus; its `model_version` is part of the key.
- **Alert rule:** a window is anomalous if its score ≥ `anomaly_threshold` (default top 3% by score, minimum 3 consecutive windows to merge). Merged regions become `anomaly_alert` events and increment `anomaly_count`.
- **Attention channel:** produced by the attention-pooling head over BiLSTM states (per-position weights normalized per window), stitched across overlaps.
- **Offline path (PWA):** the same architecture exported to INT8 ONNX runs in `onnx.worker.ts` using the identical window/stitch logic, but *only for classifier + attention channels*. Thermo and k-mer channels in offline mode need the backend. If the backend is unreachable and the sequence has no cached tensors, the UI displays reduced telemetry (classifier + attention only) and states so explicitly. (Full offline parity can be added later by porting thermo to WASM — tracked as a future ADR.)

---

## 7. WEBSOCKET PROTOCOLS

### 7.1 Endpoints

| Endpoint | Purpose | Payloads |
|---|---|---|
| `WS /ws/scan` | One session = one active analysis stream (+ mutations) | JSON text frames (control/events) + binary frames (telemetry) |
| `WS /ws/events` | Global server push (watcher ingests, history changes) | JSON text frames only |

### 7.2 `/ws/scan` session state machine

```text
                 connect
   ┌──────┐  ───────────────►  ┌─────────┐ hello ┌────────┐ start_scan ┌───────────┐
   │ CLOSED│                    │ CONNECTED│─────►│ READY  │───────────►│ ANALYZING │
   └──────┘ ◄────────────┐     └─────────┘       └────────┘            └─────┬─────┘
        ▲   close/error  │                           ▲   stop                │ scan_ready sent
        │                │                           │◄──────────────────────┤
        │                │                      ┌────┴─────┐   chunks done   ▼
        │                └──────────────────────│ COMPLETE │◄────────── ┌───────────┐
        │                                       └────┬─────┘            │ STREAMING │
        │                    mutate (any READY/COMPLETE/STREAMING)       └───────────┘
        └──────── idle timeout 120 s / heartbeat miss ×3 ◄──────────────────┘
```
`mutate` is allowed in `READY`, `STREAMING`, `COMPLETE` states. Pause/resume/seek are client-local (§4.3) and optionally mirrored to the server with `checkpoint`.

### 7.3 Binary telemetry frame layout (v1)

All integers little-endian. Header is **24 bytes** so payload begins 4-byte aligned (required for `new Float32Array(buf, 24, n)`).

```text
 offset size  field
   0     2    magic        = 0x48 0x53  ("HS")
   2     1    version      = 1
   3     1    frame_type   = 0x01 TELEMETRY_CHUNK | 0x02 OVERVIEW (downsampled whole-sequence minimap)
   4     4    stream_seq   (u32, increments per frame, starts 0)
   8     4    start_pos    (u32, first sequence position covered)   [for OVERVIEW: bin size in bp]
  12     4    count        (u32, positions in this frame)           [for OVERVIEW: number of bins]
  16     2    channel_cnt  (u16, C)
  18     2    flags        (bit0 FINAL, bit1 FROM_CACHE, bit2 HAS_NAN)
  20     4    reserved     (u32 = 0)
  24   C*count*4   payload: planar float32 — channel 0 [count], channel 1 [count], … in the order listed by scan_ready.channels
```

**Channel registry v1** (ids are stable; `scan_ready.channels` echoes the subset requested via `want`):

| id | name | unit / range | Source |
|---|---|---|---|
| 0 | `gc_pct` | % [0,100] | CORE |
| 1 | `gc_skew` | (G−C)/(G+C) [−1,1] | CORE |
| 2 | `tm_c` | °C | CORE (SantaLucia) |
| 3 | `dg_kcal` | kcal/mol @37 °C | CORE |
| 4 | `z_propensity` | [0,1] heuristic | CORE |
| 5 | `cgr_x` | [0,1] | CORE |
| 6 | `cgr_y` | [0,1] | CORE |
| 7 | `attention` | [0,1] normalized | ML |
| 8 | `p_promoter` | [0,1] | ML |
| 9 | `p_cpg_island` | [0,1] | ML |
| 10 | `p_splice_donor` | [0,1] | ML |
| 11 | `p_splice_acceptor` | [0,1] | ML |
| 12 | `anomaly_score` | [0,1] | ML (IsolationForest, rescaled) |

Chunk size default: 256 positions → with all 13 channels, payload = 13·256·4 = 13,312 B (+24 B header). A 14 kb gene ≈ 55 frames ≈ 730 KB total.

### 7.4 Backpressure & heartbeat

- Server may have **≤ 8 unacked** binary frames outstanding; client sends `{"type":"ack","stream_seq":N}` after the worker consumes frame N.
- Client sends `ping` every 15 s; server replies `pong`; 3 missed pings ⇒ server closes with code 4408.
- Reconnect: client re-sends `hello` + `start_scan` (cache makes replay cheap); no server-side resume state is required.

### 7.5 `/ws/events` messages (JSON)

`ingest_complete`, `history_changed {latest_rev}`, `watcher_status {watching, path, mode}`, `server_notice {level,message}`. The UI treats `history_changed` as a trigger for `GET /api/history/sync`.

---

## 8. REST API SURFACE (EXACT)

| Method & Path | Request | Response | Notes |
|---|---|---|---|
| `POST /api/ingest/ncbi` | `NcbiIngestRequest` | `IngestResponse` | §3.2 |
| `POST /api/ingest/pdb` | `PdbIngestRequest` | `IngestResponse` | §3.3 |
| `POST /api/ingest/paste` | `PasteIngestRequest` | `IngestResponse` | §3.4 |
| `POST /api/ingest/file` | multipart `files[]` | `IngestResponse` | §3.5 |
| `GET /api/history` | `?limit=50&cursor=&source=&q=` | `HistoryPage` | newest first |
| `GET /api/history/sync` | `?since_rev=N` | `HistorySyncResponse` | delta sync |
| `GET /api/history/{scan_id}` | – | `HistoryRecord` | |
| `DELETE /api/history/{scan_id}` | – | `204` | writes tombstone (rev++) |
| `POST /api/history/{scan_id}/progress` | `{last_scanned_pos}` | `HistoryRecord` | checkpoint |
| `GET /api/sequences/{sha256}` | `?format=json\|u8` | `SequencePayload` or `application/octet-stream` (uint8 codes) | for new-device hydration |
| `GET /api/analysis/{sha256}` | `?params_hash=` | `application/octet-stream` (same layout as OVERVIEW/full tensor) + `X-HS-Channels` JSON header | hydrate IDB tensors without WS |
| `POST /api/sequences/{sha256}/mutations` | `MutationRequest` | `Mutation` | REST twin of WS `mutate` |
| `GET /api/health` | – | `{status, core_version, model_version, watcher}` | |

---

## 9. DUCKDB SCHEMA (`migrations/001_init.sql`)

```sql
CREATE SEQUENCE IF NOT EXISTS rev_seq START 1;

CREATE TABLE IF NOT EXISTS sequences (
  sha256          VARCHAR PRIMARY KEY,          -- hex of SHA256("hs1:"+residues)
  residues        VARCHAR NOT NULL,             -- canonical IUPAC string (U already mapped to T)
  molecule        VARCHAR NOT NULL CHECK (molecule IN ('DNA','RNA')),
  length          UINTEGER NOT NULL,
  gc_pct          FLOAT   NOT NULL,
  ambiguous_count UINTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS source_records (       -- provenance per (sequence, source acquisition)
  record_id     VARCHAR PRIMARY KEY,              -- UUIDv7
  sha256        VARCHAR NOT NULL REFERENCES sequences(sha256),
  source        VARCHAR NOT NULL CHECK (source IN ('NCBI','PDB','PASTE','FILE')),
  accession     VARCHAR,                          -- e.g. NM_004006.3 | 1BNA
  entity_id     INTEGER,                          -- PDB entity, else NULL
  display_name  VARCHAR NOT NULL,
  description   VARCHAR,
  organism      VARCHAR,
  meta_json     JSON,                             -- raw esummary / RCSB metadata subset
  fetched_at    TIMESTAMP NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS accession_index (      -- network-avoidance cache
  source         VARCHAR NOT NULL,
  accession_key  VARCHAR NOT NULL,                -- 'NM_004006' | 'NC_045512.2' | '1BNA:1'
  sha256         VARCHAR NOT NULL REFERENCES sequences(sha256),
  resolved_acc   VARCHAR,                         -- versioned accession returned by NCBI
  fetched_at     TIMESTAMP NOT NULL DEFAULT current_timestamp,
  ttl_expires_at TIMESTAMP,                       -- NULL = immutable
  PRIMARY KEY (source, accession_key)
);

CREATE TABLE IF NOT EXISTS analysis_cache (
  sha256         VARCHAR NOT NULL REFERENCES sequences(sha256),
  model_version  VARCHAR NOT NULL,
  core_version   VARCHAR NOT NULL,
  params_hash    VARCHAR NOT NULL,
  channels_blob  BLOB    NOT NULL,                -- planar float32 [C×L], little-endian, zstd-optional later
  channel_ids    VARCHAR NOT NULL,                -- JSON array of ints
  anomaly_count  INTEGER NOT NULL,
  summary_json   JSON,                            -- anomaly regions, per-class peaks
  created_at     TIMESTAMP NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (sha256, model_version, core_version, params_hash)
);

CREATE TABLE IF NOT EXISTS scan_history (
  scan_id           VARCHAR PRIMARY KEY,          -- UUIDv7
  sha256            VARCHAR NOT NULL REFERENCES sequences(sha256),
  record_id         VARCHAR REFERENCES source_records(record_id),
  source            VARCHAR NOT NULL,
  display_name      VARCHAR NOT NULL,
  accession         VARCHAR,
  length            UINTEGER NOT NULL,
  gc_pct            FLOAT NOT NULL,
  anomaly_count     INTEGER NOT NULL DEFAULT 0,
  last_scanned_pos  UINTEGER NOT NULL DEFAULT 0,
  mutation_count    INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMP NOT NULL DEFAULT current_timestamp,
  updated_at        TIMESTAMP NOT NULL DEFAULT current_timestamp,
  deleted           BOOLEAN NOT NULL DEFAULT FALSE,
  rev               BIGINT  NOT NULL DEFAULT nextval('rev_seq')
);
CREATE INDEX IF NOT EXISTS idx_hist_rev ON scan_history(rev);
CREATE INDEX IF NOT EXISTS idx_hist_created ON scan_history(created_at);

CREATE TABLE IF NOT EXISTS mutations (
  mutation_id        VARCHAR PRIMARY KEY,         -- UUIDv7
  scan_id            VARCHAR NOT NULL REFERENCES scan_history(scan_id),
  sha256             VARCHAR NOT NULL REFERENCES sequences(sha256),  -- parent
  position           UINTEGER NOT NULL,           -- 0-based
  ref_base           VARCHAR  NOT NULL,
  alt_base           VARCHAR  NOT NULL,
  delta_tm_c         FLOAT, delta_dg_kcal FLOAT,
  delta_p_promoter   FLOAT, delta_p_cpg FLOAT, delta_p_splice FLOAT,
  pathogenicity      FLOAT,                       -- heuristic [0,1] (C-9)
  created_at         TIMESTAMP NOT NULL DEFAULT current_timestamp
);
```

**DuckDB concurrency rule:** DuckDB permits one writing process; use **one `duckdb.connect()` owned by `duckdb_store.py`**, writes serialized through an `asyncio.Queue` consumed by a single writer task (offloaded to a thread), and short-lived cursors (`con.cursor()`) for concurrent reads. No other process (including CLI tools) may open the file while the server runs.

---

## 10. DATA CONTRACTS — PYDANTIC (SOURCE OF TRUTH)

`backend/src/helixsight/schemas/` (Pydantic v2). Shown consolidated here.

```python
from __future__ import annotations
from datetime import datetime
from typing import Annotated, Literal, Optional, Union
from pydantic import BaseModel, Field, ConfigDict

CONTRACT_VERSION = 1

SourceKind = Literal["NCBI", "PDB", "PASTE", "FILE"]
Molecule   = Literal["DNA", "RNA"]
CacheStatus = Literal["HIT_ACCESSION", "HIT_SHA", "MISS_STORED"]

class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

# ───────────── Ingestion requests ─────────────
class NcbiIngestRequest(ApiModel):
    accession: Annotated[str, Field(pattern=r"^[A-Za-z]{1,4}_?[0-9]+(\.[0-9]+)?$", max_length=32)]
    db: Literal["nuccore"] = "nuccore"
    force_refresh: bool = False

class PdbIngestRequest(ApiModel):
    pdb_id: Annotated[str, Field(pattern=r"^[0-9][A-Za-z0-9]{3}$")]
    entity_id: Optional[int] = Field(default=None, ge=1)
    all_nucleic_acid: bool = False
    force_refresh: bool = False

class PasteIngestRequest(ApiModel):
    text: Annotated[str, Field(min_length=1, max_length=20_000_000)]
    label: Optional[Annotated[str, Field(max_length=120)]] = None

# /api/ingest/file uses multipart; server builds an internal FileIngestItem per file.

# ───────────── Core records ─────────────
class HistoryRecord(ApiModel):
    scan_id: str
    sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    source: SourceKind
    display_name: str
    accession: Optional[str] = None
    organism: Optional[str] = None
    molecule: Molecule
    length: int
    gc_pct: float
    anomaly_count: int = 0
    last_scanned_pos: int = 0
    mutation_count: int = 0
    created_at: datetime
    updated_at: datetime
    rev: int

class IngestItem(ApiModel):
    sha256: str
    cache_status: CacheStatus
    record: HistoryRecord
    has_analysis_cache: bool          # lets UI choose "Open instantly" vs "Scan"

class IngestResponse(ApiModel):
    contract_version: int = CONTRACT_VERSION
    items: list[IngestItem]
    warnings: list[str] = []

class HistoryPage(ApiModel):
    items: list[HistoryRecord]
    next_cursor: Optional[str] = None

class HistorySyncResponse(ApiModel):
    since_rev: int
    latest_rev: int
    upserts: list[HistoryRecord]
    deleted: list[str]                # scan_ids

class SequencePayload(ApiModel):
    sha256: str
    molecule: Molecule
    length: int
    residues: str                     # canonical IUPAC (for small seqs); large seqs use ?format=u8

# ───────────── Mutations ─────────────
class MutationRequest(ApiModel):
    request_id: str
    scan_id: str
    position: int = Field(ge=0)
    alt: Literal["A", "C", "G", "T"]

class Mutation(ApiModel):
    mutation_id: str
    scan_id: str
    sha256: str
    position: int
    ref: Literal["A", "C", "G", "T", "N"]
    alt: Literal["A", "C", "G", "T"]
    delta_tm_c: Optional[float] = None
    delta_dg_kcal: Optional[float] = None
    delta_p_promoter: Optional[float] = None
    delta_p_cpg: Optional[float] = None
    delta_p_splice: Optional[float] = None
    pathogenicity: Optional[float] = Field(default=None, ge=0, le=1)  # research heuristic (C-9)
    created_at: datetime

# ───────────── Errors ─────────────
ErrorCode = Literal[
    "INVALID_ACCESSION", "NCBI_NOT_FOUND", "NCBI_RATE_LIMITED", "UPSTREAM_TIMEOUT",
    "PDB_NOT_FOUND", "PDB_NO_NUCLEIC_ACID", "INVALID_IUPAC", "EMPTY_SEQUENCE",
    "SEQUENCE_TOO_LONG", "UNKNOWN_SEQUENCE", "CORE_UNAVAILABLE", "MODEL_UNAVAILABLE",
    "PROTOCOL_ERROR", "INTERNAL",
]
class ErrorBody(ApiModel):
    code: ErrorCode
    message: str
    detail: Optional[dict] = None     # e.g. {"offset": 812, "char": "Z"} for INVALID_IUPAC

# ───────────── WebSocket: client → server ─────────────
class WsHello(ApiModel):
    type: Literal["hello"] = "hello"
    contract: int = CONTRACT_VERSION
    client: str = "web"

class WsStartScan(ApiModel):
    type: Literal["start_scan"] = "start_scan"
    sha256: str
    window_bp: int = 40
    speed_bps: float = 50.0
    want: list[int] = Field(default_factory=lambda: list(range(13)))   # channel ids
    force_recompute: bool = False

class WsAck(ApiModel):
    type: Literal["ack"] = "ack"
    stream_seq: int

class WsCheckpoint(ApiModel):
    type: Literal["checkpoint"] = "checkpoint"
    scan_id: str
    last_scanned_pos: int

class WsMutate(ApiModel):
    type: Literal["mutate"] = "mutate"
    request_id: str
    scan_id: str
    position: int
    alt: Literal["A", "C", "G", "T"]

class WsStop(ApiModel):
    type: Literal["stop"] = "stop"

class WsPing(ApiModel):
    type: Literal["ping"] = "ping"
    t: int

ClientMsg = Annotated[
    Union[WsHello, WsStartScan, WsAck, WsCheckpoint, WsMutate, WsStop, WsPing],
    Field(discriminator="type"),
]

# ───────────── WebSocket: server → client (JSON) ─────────────
class ChannelInfo(ApiModel):
    id: int
    name: str
    unit: str
    min: float
    max: float

class WsHelloAck(ApiModel):
    type: Literal["hello_ack"] = "hello_ack"
    session_id: str
    contract: int
    core_version: str
    model_version: str

class WsScanReady(ApiModel):
    type: Literal["scan_ready"] = "scan_ready"
    sha256: str
    length: int
    channels: list[ChannelInfo]
    chunk_positions: int
    cache: Literal["HIT", "MISS"]
    params_hash: str
    overview_bins: int

class WsProgress(ApiModel):
    type: Literal["progress"] = "progress"
    pos: int
    fraction: float

class WsAnomalyAlert(ApiModel):
    type: Literal["anomaly_alert"] = "anomaly_alert"
    start: int
    end: int
    score: float
    kind: Literal["composition_shift", "possible_hgt", "low_complexity", "unknown"]

class WsScanComplete(ApiModel):
    type: Literal["scan_complete"] = "scan_complete"
    anomaly_count: int
    duration_ms: int

class WsMutationResult(ApiModel):
    type: Literal["mutation_result"] = "mutation_result"
    request_id: str
    mutation: Mutation

class WsError(ApiModel):
    type: Literal["error"] = "error"
    error: ErrorBody
    fatal: bool = False

class WsPong(ApiModel):
    type: Literal["pong"] = "pong"
    t: int

# /ws/events
class EvIngestComplete(ApiModel):
    type: Literal["ingest_complete"] = "ingest_complete"
    item: IngestItem

class EvHistoryChanged(ApiModel):
    type: Literal["history_changed"] = "history_changed"
    latest_rev: int

class EvWatcherStatus(ApiModel):
    type: Literal["watcher_status"] = "watcher_status"
    watching: bool
    path: str
    mode: Literal["inotify", "polling"]
```

`anomaly_alert.kind` is a coarse heuristic label (C-9): `possible_hgt` means "composition differs from the surrounding sequence in a way consistent with horizontal transfer", not a confirmed HGT call.

**Binary frame packing (Python reference):**
```python
import struct
HEADER = struct.Struct("<2sBBIIIHHI")   # 24 bytes; magic,ver,type,seq,start,count,C,flags,reserved
def pack_chunk(stream_seq: int, start: int, planes: "np.ndarray[C, N] float32", flags: int) -> bytes:
    C, N = planes.shape
    hdr = HEADER.pack(b"HS", 1, 0x01, stream_seq, start, N, C, flags, 0)
    return hdr + planes.tobytes(order="C")        # planar: channel-major
```

---

## 11. DATA CONTRACTS — TYPESCRIPT (MIRROR)

`frontend/src/contracts/*.ts`

```ts
// contracts/ingest.ts & history.ts
export const CONTRACT_VERSION = 1 as const;

export type SourceKind = "NCBI" | "PDB" | "PASTE" | "FILE";
export type Molecule = "DNA" | "RNA";
export type CacheStatus = "HIT_ACCESSION" | "HIT_SHA" | "MISS_STORED";

export interface NcbiIngestRequest { accession: string; db?: "nuccore"; force_refresh?: boolean; }
export interface PdbIngestRequest  { pdb_id: string; entity_id?: number | null; all_nucleic_acid?: boolean; force_refresh?: boolean; }
export interface PasteIngestRequest { text: string; label?: string | null; }

export interface HistoryRecord {
  scan_id: string;
  sha256: string;               // 64 hex
  source: SourceKind;
  display_name: string;
  accession: string | null;
  organism: string | null;
  molecule: Molecule;
  length: number;
  gc_pct: number;
  anomaly_count: number;
  last_scanned_pos: number;
  mutation_count: number;
  created_at: string;           // ISO-8601 UTC
  updated_at: string;
  rev: number;
}

export interface IngestItem {
  sha256: string;
  cache_status: CacheStatus;
  record: HistoryRecord;
  has_analysis_cache: boolean;
}
export interface IngestResponse { contract_version: number; items: IngestItem[]; warnings: string[]; }
export interface HistoryPage { items: HistoryRecord[]; next_cursor: string | null; }
export interface HistorySyncResponse { since_rev: number; latest_rev: number; upserts: HistoryRecord[]; deleted: string[]; }

export interface Mutation {
  mutation_id: string; scan_id: string; sha256: string;
  position: number; ref: "A"|"C"|"G"|"T"|"N"; alt: "A"|"C"|"G"|"T";
  delta_tm_c: number | null; delta_dg_kcal: number | null;
  delta_p_promoter: number | null; delta_p_cpg: number | null; delta_p_splice: number | null;
  pathogenicity: number | null;  // research heuristic (C-9)
  created_at: string;
}
export interface MutationRequest { request_id: string; scan_id: string; position: number; alt: "A"|"C"|"G"|"T"; }

export type ErrorCode =
  | "INVALID_ACCESSION" | "NCBI_NOT_FOUND" | "NCBI_RATE_LIMITED" | "UPSTREAM_TIMEOUT"
  | "PDB_NOT_FOUND" | "PDB_NO_NUCLEIC_ACID" | "INVALID_IUPAC" | "EMPTY_SEQUENCE"
  | "SEQUENCE_TOO_LONG" | "UNKNOWN_SEQUENCE" | "CORE_UNAVAILABLE" | "MODEL_UNAVAILABLE"
  | "PROTOCOL_ERROR" | "INTERNAL";
export interface ErrorBody { code: ErrorCode; message: string; detail?: Record<string, unknown>; }
```

```ts
// contracts/ws.ts
export const FRAME_MAGIC = [0x48, 0x53] as const;      // "HS"
export const FRAME_HEADER_BYTES = 24 as const;
export const FRAME_TYPE = { TELEMETRY_CHUNK: 0x01, OVERVIEW: 0x02 } as const;
export const FLAG = { FINAL: 1 << 0, FROM_CACHE: 1 << 1, HAS_NAN: 1 << 2 } as const;

export const CHANNEL = {
  gc_pct: 0, gc_skew: 1, tm_c: 2, dg_kcal: 3, z_propensity: 4,
  cgr_x: 5, cgr_y: 6, attention: 7,
  p_promoter: 8, p_cpg_island: 9, p_splice_donor: 10, p_splice_acceptor: 11,
  anomaly_score: 12,
} as const;
export type ChannelId = (typeof CHANNEL)[keyof typeof CHANNEL];

export interface ChannelInfo { id: number; name: string; unit: string; min: number; max: number; }

// client -> server
export type ClientMsg =
  | { type: "hello"; contract: number; client: string }
  | { type: "start_scan"; sha256: string; window_bp?: number; speed_bps?: number; want?: number[]; force_recompute?: boolean }
  | { type: "ack"; stream_seq: number }
  | { type: "checkpoint"; scan_id: string; last_scanned_pos: number }
  | { type: "mutate"; request_id: string; scan_id: string; position: number; alt: "A"|"C"|"G"|"T" }
  | { type: "stop" }
  | { type: "ping"; t: number };

// server -> client (JSON)
export type ServerMsg =
  | { type: "hello_ack"; session_id: string; contract: number; core_version: string; model_version: string }
  | { type: "scan_ready"; sha256: string; length: number; channels: ChannelInfo[]; chunk_positions: number;
      cache: "HIT" | "MISS"; params_hash: string; overview_bins: number }
  | { type: "progress"; pos: number; fraction: number }
  | { type: "anomaly_alert"; start: number; end: number; score: number;
      kind: "composition_shift" | "possible_hgt" | "low_complexity" | "unknown" }
  | { type: "scan_complete"; anomaly_count: number; duration_ms: number }
  | { type: "mutation_result"; request_id: string; mutation: import("./history").Mutation }
  | { type: "error"; error: import("./history").ErrorBody; fatal: boolean }
  | { type: "pong"; t: number };

export type EventMsg =
  | { type: "ingest_complete"; item: import("./history").IngestItem }
  | { type: "history_changed"; latest_rev: number }
  | { type: "watcher_status"; watching: boolean; path: string; mode: "inotify" | "polling" };

// binary frame (decoded by stream.worker.ts)
export interface TelemetryFrame {
  streamSeq: number;
  startPos: number;
  count: number;
  channelCount: number;
  flags: number;
  planes: Float32Array;   // length = channelCount * count (planar, channel-major) — a VIEW on the received buffer
}

export function decodeFrame(buf: ArrayBuffer): TelemetryFrame {
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 0x48 || dv.getUint8(1) !== 0x53) throw new Error("bad magic");
  if (dv.getUint8(2) !== 1) throw new Error("unsupported frame version");
  const count = dv.getUint32(12, true);
  const channelCount = dv.getUint16(16, true);
  return {
    streamSeq: dv.getUint32(4, true),
    startPos: dv.getUint32(8, true),
    count,
    channelCount,
    flags: dv.getUint16(18, true),
    planes: new Float32Array(buf, FRAME_HEADER_BYTES, channelCount * count), // zero-copy (24 is 4-aligned)
  };
}
```

```ts
// db/schema.ts — IndexedDB (via idb)
export interface HelixDB {
  history:   { key: string /*scan_id*/; value: HistoryRecord; indexes: { by_created: string; by_sha: string; by_source: string } };
  sequences: { key: string /*sha256*/;  value: { sha256: string; molecule: Molecule; length: number; codes: ArrayBuffer /*u8*/; display: string } };
  tensors:   { key: string /*`${sha256}|${model_version}|${params_hash}`*/;
               value: { sha256: string; channel_ids: number[]; length: number; planes: ArrayBuffer /*f32 [C×L]*/; anomaly_regions: {start:number;end:number;score:number}[] } };
  mutations: { key: string /*mutation_id*/; value: Mutation; indexes: { by_sha: string; by_scan: string } };
  meta:      { key: string; value: { last_rev?: number; model_version?: string } };
}
```

**Contract-sync rule:** any change to `schemas/*.py` requires the matching change in `contracts/*.ts` in the same commit; CI (P0.6) diffs field names/types; bump `CONTRACT_VERSION` on breaking changes and reject mismatched `hello`.

---

## 12. FRONTEND RENDER PIPELINE (60 fps)

```text
 WS binary ─► main thread onmessage(ArrayBuffer) ─► worker.postMessage(buf, [buf])   (transfer, no copy)
 stream.worker.ts:
     decodeFrame(buf) ─► copy planes into per-channel ring buffers (Float32Array[L] preallocated from scan_ready.length)
     update `filledUpTo`; post {type:"filled", upTo} (tiny JSON) to main thread
     send ack via main thread (workers may hold the WS directly if moved; v1 keeps WS on main thread)
 main thread rAF loop (HelixCanvas2D):
     t = performance.now(); headPos += speed_bps * dt           (clamped to filledUpTo)
     slice = [floor(headPos)-20 , +20]  → read ring buffers (no allocation)
     draw: backbones, base pairs (2 vs 3 H-bond lines), purine (double ring) / pyrimidine (single ring),
           groove overlays (major 2.2 nm / minor 1.2 nm), turn counter (pos/10.5), Tm/ΔG heat strip,
           attention glow (alpha = attention[i]), classifier tracks, anomaly banner, CGR radar (offscreen canvas)
     budget: ≤ 8 ms JS per frame; never allocate in the loop
 Sonification (Web Audio): scheduled from headPos using AudioContext time; base→pitch, attention→gain; muted by default.
```

---

## 13. ERROR MODEL & FAILURE BEHAVIOR

| Failure | Detected by | HTTP / WS | UI behavior |
|---|---|---|---|
| Bad accession format | client regex + `NcbiIngestRequest` | 422 `INVALID_ACCESSION` | inline field error |
| NCBI no record | efetch empty/`Error` text, esummary empty | 404 `NCBI_NOT_FOUND` | message + keep form |
| NCBI throttled | HTTP 429 after retries | 503 `NCBI_RATE_LIMITED` (+`Retry-After`) | toast; offer cached items |
| Network down | httpx timeout | 504 `UPSTREAM_TIMEOUT` | "Offline: showing History only" |
| PDB has no nucleic acid | entity classification | 422 `PDB_NO_NUCLEIC_ACID` + entity list in `detail` | explain; suggest NCBI |
| Invalid IUPAC | sanitizer | 422 `INVALID_IUPAC` `{offset,char}` | highlight char in paste box |
| Too long / empty | sanitizer | 413 / 422 | message |
| Unknown `sha256` on `start_scan` | DB miss | WS `error UNKNOWN_SEQUENCE` | re-ingest prompt |
| C++ wheel missing | `native.py` import | WS `error CORE_UNAVAILABLE` (non-fatal if fallback) | banner "slow mode" |
| WS protocol violation | `ClientMsg` validation | WS `error PROTOCOL_ERROR`, close 4400 | reconnect |
| Client too slow | >8 unacked frames for 10 s | server closes 4409 | auto-reconnect (cache replay) |

---

## 14. PERFORMANCE BUDGETS (16 GB WSL2 target)

| Operation | Target |
|---|---|
| History item open from IndexedDB (≤ 50 kb seq + tensors) | **< 5 ms** (single multi-store read transaction, ArrayBuffers handed to store without copying) |
| Canonicalize + SHA-256 of 100 kb paste (browser) | < 15 ms |
| C++ thermo + GC + Z-propensity + CGR for 1 Mbp | < 100 ms total (O(L) with prefix sums) |
| k-mer matrix k=4, 1 Mbp, win 1024 / stride 256 | < 150 ms |
| CNN+BiLSTM inference, 14 kb sequence, CPU | < 1.5 s (INT8 ONNX path ≤ 0.8 s) |
| IsolationForest scoring, ~60 windows | < 20 ms |
| Mutation round-trip (local window recompute) | < 80 ms end-to-end |
| WebSocket stream of 14 kb tensor (cache HIT) | < 150 ms to first frame |
| Canvas frame | ≤ 16.6 ms (JS ≤ 8 ms) |

Budgets are measurement targets for P1.8 and P8.4 and may be refined with ADRs after profiling.

---

## 15. INTERCONNECTION MATRIX (WHO CALLS WHOM, WITH WHAT)

| Caller | Callee | Channel / payload | Purpose |
|---|---|---|---|
| `NcbiForm` / `PdbForm` / `PasteModal` / `FileDropZone` | `api/http.ts` | typed JSON / multipart | start ingestion |
| `api/http.ts` | `routes_ingest.py` | `POST /api/ingest/*` → `IngestResponse` | all lanes |
| `routes_ingest.py` | `pipeline.ingest_records` | Python call with `list[RawRecord]` | converge lanes |
| `pipeline` | `sanitizer.canonicalize` + `hasher` | `str → CanonicalRecord(sha256, residues, stats)` | identity |
| `pipeline` | `duckdb_store` | write-queue + read cursor | dedup, history rows |
| `ncbi_client` | NCBI `efetch.fcgi` / `esummary.fcgi` | HTTPS GET | live FASTA + metadata |
| `pdb_client` | RCSB FASTA + Data API | HTTPS GET | FASTA + entity metadata |
| `watcher` | `pipeline` | asyncio queue of file paths | folder ingestion |
| `ws_events` | UI `wsClient` | JSON events | `history_changed`, `ingest_complete` |
| UI `sync.ts` | `routes_history` | `GET /api/history/sync?since_rev` | IDB reconciliation |
| UI | `ws_scan` | `hello` / `start_scan` / `ack` / `mutate` | scan control |
| `ScanSession` | `duckdb_store` | cache lookup + write-through | skip recompute |
| `ScanSession` | `core_bridge` → `helixsight_core` | numpy buffers (zero-copy) | thermo, GC, CGR, k-mers |
| `ScanSession` | `ml.inference` / `ml.anomaly` | `float32` windows / k-mer matrix | classifiers, attention, anomaly |
| `ScanSession` | `streaming.framing` | `planes[C,N]` → bytes | binary frames |
| `wsClient` | `stream.worker` | transferable `ArrayBuffer` | off-main-thread decode |
| `stream.worker` | `HelixCanvas2D` / HUD | ring buffers + `filled` messages | rendering |
| `HelixCanvas2D` click | `ws_scan` `mutate` | JSON → `mutation_result` | in-silico mutation |
| scan complete | `db/repo.ts` | `IDB.tensors.put`, `history.put` | enable instant reload |
| History click | `db/repo.ts` | one IDB transaction | <5 ms reload |

---

## 16. OPEN DECISIONS (TO RESOLVE IN LATER SPEC FILES)

1. Exact CNN+BiLSTM layer sizes, training data recipe (free public sources only), and edge-window rule for per-position thermo → doc `03`.
2. Whether `stream.worker` also owns the WebSocket (moves ack handling off main thread) → doc `04`.
3. Optional zstd compression of `channels_blob` and IDB tensors → doc `02`/`03`.
4. WASM port of the thermo/k-mer core for full offline parity → future ADR.
5. Z-DNA propensity heuristic definition and the B→Z morph interpolation curve → doc `03`/`04`.