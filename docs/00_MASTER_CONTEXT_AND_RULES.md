# 00_MASTER_CONTEXT_AND_RULES.md

> **HelixSight AI** — open-source, local-first PWA and AI Bioinformatics Workbench
> Spec version: `1.0.0` · Document set: `00` of `05` · Status: LIVING DOCUMENT (update the Phase Tracker every session)

---

## 0. HOW TO USE THIS DOCUMENT (READ FIRST, EVERY SESSION)

This file is the **root context**. Paste it at the top of every new Claude/Gemini coding session, followed by whichever numbered spec file is relevant to the task. Any AI assistant reading this file MUST:

1. Obey Section 3 (Strict Constraints) without exception.
2. Use the canonical names, paths, units, and data contracts in Sections 6, 7 and in `01_SYSTEM_ARCHITECTURE_AND_DATAFLOW.md`. Never invent parallel names.
3. Explain interconnections (what calls what, with which payload) for every file, function, or stream it creates (Rule C-3).
4. Update the Phase Tracker (Section 8) at the end of the session by emitting the changed checkbox lines.
5. Ask for the relevant spec file if it is missing rather than guessing a contract.

### 0.1 Document set index

| File | Purpose | Status |
|---|---|---|
| `00_MASTER_CONTEXT_AND_RULES.md` | Vision, constraints, tree, phase tracker | ✅ This file |
| `01_SYSTEM_ARCHITECTURE_AND_DATAFLOW.md` | Sequence diagrams, dataflow, data contracts | ✅ Turn 1 |
| `02_*` | Backend, ingestion & persistence deep-dive (tentative) | ⏳ Turn 2 |
| `03_*` | C++ core + ML/DL pipeline deep-dive (tentative) | ⏳ Turn 2 |
| `04_*` | Frontend, visualizer, HUD, PWA deep-dive (tentative) | ⏳ Turn 3 |
| `05_*` | Build, test, packaging, roadmap deep-dive (tentative) | ⏳ Turn 3 |

> Files 02–05 are provisional titles; they may be renamed when generated. If renamed, update this table.

---

## 1. PROJECT OVERVIEW

**HelixSight AI** is a local-first, installable PWA that behaves like a real-time B-DNA scanning telemetry dashboard. A user loads a nucleotide sequence from one of four sources; a native C++20 core computes thermodynamics and k-mer statistics at microsecond scale; a PyTorch/ONNX model stack annotates the sequence; and a 60 fps Canvas "reading head" sweeps a 5'→3' window while HUD panels light up with attention, promoter/CpG/splice probabilities, anomaly alerts, and mutation deltas.

Everything (sequences, tensors, mutations, history) persists locally: **DuckDB** on the backend, **IndexedDB** in the browser. After a sequence has been analyzed once, re-opening it is a local cache read (target < 5 ms) with no network calls and no model inference.

### 1.1 Design principles

1. **Local-first.** The only outbound traffic ever permitted is to the free public NCBI E-Utilities and RCSB PDB endpoints, triggered by explicit user action.
2. **Content-addressed identity.** A sequence's identity is the SHA-256 of its canonical residues. Source (NCBI/PDB/paste/file) is metadata, not identity.
3. **Compute once, replay forever.** AI tensors are cached by `(sha256, model_version, params_hash)`.
4. **Native where hot, Python where glue.** C++ for sliding-window math; Python for orchestration, I/O and ML; TypeScript for UI.
5. **Streaming, not polling.** The scan is a WebSocket stream of binary telemetry frames plus small JSON control events.
6. **Honest science.** Pathogenicity and anomaly outputs are research heuristics. The UI must label them as such (see C-9).

---

## 2. FOUR-WAY INGESTION & HISTORY OVERVIEW

### 2.1 The four ingestion lanes

| # | Lane | Trigger | Backend entry | External call (free, public) |
|---|---|---|---|---|
| 1 | **NCBI Entrez** | User types accession (`NM_004006`, `NC_045512.2`) | `POST /api/ingest/ncbi` | `efetch.fcgi` (FASTA) + `esummary.fcgi` (metadata) |
| 2 | **RCSB PDB** | User types PDB ID (`1BNA`) | `POST /api/ingest/pdb` | `rcsb.org/fasta/entry/{id}` + `data.rcsb.org/rest/v1/core/...` |
| 3 | **Direct paste** | User pastes FASTA or raw `ATGC…` | `POST /api/ingest/paste` | none |
| 4 | **File drop / watch folder** | Drag `.fasta/.fa/.fna` or drop into watched dir | `POST /api/ingest/file` (drag) · `watchdog` (folder) | none |

All four lanes converge on **one pipeline** (`ingestion/pipeline.py::ingest_records`) that: sanitizes → validates IUPAC → canonicalizes → hashes (SHA-256) → checks DuckDB → (on miss) stores sequence + source metadata → writes a `scan_history` row → returns `IngestResponse`.

### 2.2 Persistent Analysis History & Offline Cache

- **Server of record:** DuckDB file `data/helixsight.duckdb`.
- **Client mirror:** IndexedDB database `helixsight` (via `idb`), synced by a monotonically increasing `rev` counter.
- **History Sidebar** (slide-out drawer) lists each run with: Accession/Name · Source badge `[NCBI | PDB | PASTE | FILE]` · Length · GC% · AI Anomaly Count · Last Scanned Position · Timestamp.
- **Instant reload (<5 ms):** clicking a history item reads sequence + cached tensors + saved mutations from IndexedDB into memory and renders. No fetch, no inference. (Server is consulted only if the item is missing locally, e.g. first sync on a new browser profile.)

---

## 3. STRICT NON-NEGOTIABLE CONSTRAINTS CHECKLIST

Treat each as a hard gate in code review. Tick when verified for the current codebase state.

### 3.1 Licensing & cost

- [ ] **C-1 FREE & OPEN-SOURCE ONLY.** Every library, model weight, and runtime is MIT / Apache-2.0 / BSD (or equivalently permissive). No GPL/AGPL dependency may be linked into distributed code. Verify model-weight licenses individually before bundling (some public genomic checkpoints are non-commercial or share-alike; reject those). Prefer **custom-trained lightweight models**.
- [ ] **C-2 NO PAID/CLOUD SERVICES.** No AWS, GCP, Azure, Firebase, MongoDB Atlas, OpenAI/Anthropic APIs, no SaaS telemetry, no "free tier" cloud. The *only* network egress is NCBI E-Utilities and RCSB PDB public REST APIs. (An NCBI API key is a free optional identifier, not a cloud product; it is read from `.env` and never committed.)
- [ ] **C-3 INTERCONNECTION EXPLANATION RULE.** Every generated document and every significant code file includes a section explaining workflow + interconnections: exact REST endpoints, SHA-256 cache lookup flow, JSON/binary payloads, Python↔C++ memory handoffs, WebSocket event lifecycle.

### 3.2 Platform

- [ ] **C-4 RUNS ON Windows 11 / WSL2 Ubuntu, 16 GB RAM.** Peak resident memory for a 5 Mbp sequence with full analysis must stay < 2 GB backend, < 700 MB browser tab.
- [ ] **C-5 WSL2 FILESYSTEM CAVEAT.** `watchdog` inotify events do **not** fire reliably for Windows drives mounted under `/mnt/c`. Default watch dir lives in the Linux filesystem (`~/helixsight_watch`); if the user points at `/mnt/*`, automatically fall back to `watchdog.observers.polling.PollingObserver`.
- [ ] **C-6 TOOLING.** `uv` for Python envs/lockfile, `pnpm` for Node. No `pip install` / `npm install` in docs or scripts.

### 3.3 Stack lock

- [ ] **C-7 TECH STACK (see Section 4).** No substitutions without an ADR in `docs/adr/`.
- [ ] **C-8 LOCAL-FIRST DATA.** Sequences and caches never leave the machine. DuckDB file and IndexedDB are the only stores.

### 3.4 Scientific integrity

- [ ] **C-9 LABEL HEURISTICS.** UI copy for pathogenicity, anomaly, and HGT alerts must say "research heuristic, not a clinical or diagnostic result".
- [ ] **C-10 DETERMINISM.** Same canonical sequence + same `model_version` + same `params_hash` ⇒ byte-identical cached tensors (fixed seeds, no nondeterministic ops in inference path).

---

## 4. TECH STACK & LICENSE MATRIX

| Layer | Component | License | Role |
|---|---|---|---|
| Frontend | React 18 + TypeScript | MIT | UI |
| Frontend | Vite, `vite-plugin-pwa` | MIT | Build, service worker, manifest |
| Frontend | TailwindCSS | MIT | Styling |
| Frontend | Zustand (state) | MIT | Client state store |
| Frontend | `idb` | ISC | IndexedDB wrapper |
| Frontend | Three.js | MIT | Optional 3D helix |
| Frontend | ONNX Runtime Web | MIT | Offline inference in Web Worker |
| Frontend | Web Workers, Web Audio API, Canvas 2D, WebCrypto | Browser std | Streaming decode, sonification, render, hashing |
| Backend | Python 3.11+, FastAPI, Uvicorn | MIT/BSD | API + WebSockets |
| Backend | `httpx` | BSD | Async NCBI/PDB client |
| Backend | `watchdog` | Apache-2.0 | Folder monitor |
| Backend | Biopython (optional) | BSD-3 / Biopython | FASTA parsing helper |
| Backend | Pydantic v2 | MIT | Schemas |
| Native | C++20, CMake, `pybind11`, `scikit-build-core` | BSD / Apache | Hot-loop math |
| Native tests | `doctest` | MIT | C++ unit tests |
| ML | PyTorch, scikit-learn, ONNX, `optimum`, `transformers` | BSD / Apache | Models, anomaly detection, export, quantization |
| Storage | DuckDB | MIT | Embedded history/cache store |
| Tooling | `uv`, `pnpm`, `ruff`, `pytest`, `vitest`, `playwright` | MIT/Apache | Dev tooling |

---

## 5. MONOREPO DIRECTORY TREE

```text
helixsight-ai/
├── README.md
├── LICENSE                          # MIT
├── Makefile                         # make dev | make native | make test | make export-onnx
├── .env.example                     # NCBI_TOOL, NCBI_EMAIL, NCBI_API_KEY (optional), WATCH_DIR, DB_PATH
├── .editorconfig
├── .gitignore
├── pnpm-workspace.yaml
├── package.json                     # root scripts only
├── pyproject.toml                   # uv workspace root (members: backend, cpp_core)
├── uv.lock
│
├── docs/
│   ├── 00_MASTER_CONTEXT_AND_RULES.md
│   ├── 01_SYSTEM_ARCHITECTURE_AND_DATAFLOW.md
│   ├── 02_..._.md  03_..._.md  04_..._.md  05_..._.md     # generated in later turns
│   ├── adr/                         # Architecture Decision Records (0001-*.md)
│   └── diagrams/
│
├── frontend/
│   ├── package.json
│   ├── vite.config.ts               # vite-plugin-pwa config, worker bundling
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── index.html
│   ├── public/
│   │   ├── icons/                   # PWA icons
│   │   └── models/                  # *.int8.onnx served statically (offline inference)
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── contracts/
│       │   ├── ingest.ts            # mirrors backend/schemas/ingest.py
│       │   ├── history.ts
│       │   └── ws.ts                # JSON + binary frame constants
│       ├── api/
│       │   ├── http.ts              # typed fetch wrappers for /api/*
│       │   └── wsClient.ts          # /ws/scan + /ws/events connection manager
│       ├── db/
│       │   ├── schema.ts            # idb stores: history, sequences, tensors, mutations, meta
│       │   ├── repo.ts              # CRUD, <5ms reload path
│       │   └── sync.ts              # rev-based delta sync with backend
│       ├── lib/
│       │   ├── canonicalize.ts      # MUST match backend sanitizer.py byte-for-byte
│       │   ├── sha256.ts            # WebCrypto digest
│       │   ├── iupac.ts
│       │   └── constants.ts         # helix geometry, channel registry, colors
│       ├── store/
│       │   └── useWorkbench.ts      # active sequence, reading-head state, HUD toggles
│       ├── workers/
│       │   ├── stream.worker.ts     # decodes binary frames -> ring buffers (SharedArrayBuffer optional)
│       │   ├── onnx.worker.ts       # offline INT8 inference
│       │   └── cgr.worker.ts        # CGR point accumulation / density grid
│       ├── audio/
│       │   └── sonifier.ts          # Web Audio sequence sonification
│       └── components/
│           ├── ingestion/           # IngestionPanel, NcbiForm, PdbForm, PasteModal, FileDropZone
│           ├── history/             # HistoryDrawer, HistoryItem, SourceBadge
│           ├── helix/               # HelixCanvas2D, HelixThree3D, GrooveDimensions, ConformationMorph
│           ├── hud/                 # AttentionTrack, ClassifierTracks, AnomalyBanner, MutationPanel,
│           │                        # ThermoHeatmap, CgrRadar, ReadingHeadWindow
│           └── common/
│
├── backend/
│   ├── pyproject.toml
│   └── src/helixsight/
│       ├── main.py                  # FastAPI app factory, lifespan (DB, watcher, model registry)
│       ├── config.py                # pydantic-settings from .env
│       ├── api/
│       │   ├── routes_ingest.py     # /api/ingest/{ncbi,pdb,paste,file}
│       │   ├── routes_history.py    # /api/history, /api/history/sync, /api/history/{sha}
│       │   ├── routes_analysis.py   # /api/analysis/{sha}/run, /api/sequences/{sha}/mutations
│       │   ├── ws_scan.py           # /ws/scan  (per-session stream)
│       │   ├── ws_events.py         # /ws/events (global notifications, watcher events)
│       │   └── errors.py            # error codes -> HTTP/WS mapping
│       ├── schemas/                 # Pydantic v2 models (source of truth for contracts)
│       │   ├── common.py  ingest.py  history.py  ws.py
│       ├── ingestion/
│       │   ├── pipeline.py          # ingest_records(): THE convergence point
│       │   ├── sanitizer.py         # FASTA/raw cleaning, IUPAC validation, canonicalization
│       │   ├── hasher.py            # sha256_canonical()
│       │   ├── fasta.py             # tolerant FASTA splitter
│       │   ├── ncbi_client.py       # httpx: efetch + esummary, rate limiter
│       │   ├── pdb_client.py        # httpx: FASTA + core entry/entity metadata
│       │   ├── file_ingest.py       # upload + disk-file ingestion
│       │   └── watcher.py           # watchdog Observer -> asyncio queue -> pipeline
│       ├── db/
│       │   ├── duckdb_store.py      # single-writer connection, write queue, read cursors
│       │   └── migrations/001_init.sql
│       ├── core_bridge/
│       │   ├── native.py            # imports helixsight_core; guards + fallbacks
│       │   └── buffers.py           # numpy preallocation, dtype/contiguity asserts
│       ├── ml/
│       │   ├── models.py            # 1D-CNN + BiLSTM (+ attention head) definitions
│       │   ├── inference.py         # windowed batch inference, overlap stitching
│       │   ├── anomaly.py           # IsolationForest / autoencoder on k-mer vectors
│       │   ├── pathogenicity.py     # mutation delta scoring (heuristic)
│       │   ├── registry.py          # model_version, weights path, params_hash
│       │   └── onnx_export.py       # torch -> ONNX -> INT8 (optimum / onnxruntime quantization)
│       ├── streaming/
│       │   ├── session.py           # ScanSession state machine
│       │   ├── framing.py           # binary frame pack/unpack (matches contracts/ws.ts)
│       │   └── scheduler.py         # chunking, backpressure (ack window)
│       └── tests/
│
├── cpp_core/
│   ├── CMakeLists.txt
│   ├── pyproject.toml               # scikit-build-core -> wheel "helixsight_core"
│   ├── include/helixsight/
│   │   ├── encode.hpp  kmer.hpp  gc.hpp  cgr.hpp  thermo.hpp  zdna.hpp
│   ├── src/                         # implementations
│   ├── bindings/module.cpp          # pybind11 module (releases GIL, zero-copy buffers)
│   └── tests/                       # doctest
│
├── ml_models/
│   ├── training/                    # train_cnn_bilstm.py, train_autoencoder.py, configs/*.yaml
│   ├── datasets/README.md           # how to fetch FREE public training data (never committed)
│   ├── checkpoints/                 # *.pt (git-ignored)
│   ├── onnx/                        # *.onnx, *.int8.onnx (copied to frontend/public/models)
│   └── MODEL_CARDS/                 # per-model: data, license, metrics, limitations
│
├── data/                            # runtime (git-ignored)
│   ├── helixsight.duckdb
│   └── watch/                       # default watched folder (Linux FS)
│
└── scripts/
    ├── dev.sh                       # starts uvicorn + vite
    ├── build_native.sh              # uv build of cpp_core wheel
    └── gen_ts_from_pydantic.py      # optional: emit contracts/*.ts from schemas
```

### 5.1 How the top-level folders interconnect

- `frontend/` ⇄ `backend/` over **HTTP** (`/api/*`, JSON) and **WebSocket** (`/ws/scan` binary+JSON, `/ws/events` JSON). Contracts in `backend/.../schemas/*.py` are the source of truth; `frontend/src/contracts/*.ts` mirror them and CI diffs them.
- `backend/` → `cpp_core/` via the compiled Python module `helixsight_core` (built by `uv build` using scikit-build-core). `core_bridge/native.py` is the *only* file allowed to import it.
- `backend/ml/` ← `ml_models/`: checkpoints/ONNX files are loaded by `ml/registry.py`; `onnx_export.py` writes into `ml_models/onnx/`, and `make export-onnx` copies INT8 files to `frontend/public/models/` for the browser.
- `backend/db/` owns `data/helixsight.duckdb`. `frontend/src/db/` owns the browser IndexedDB. They are reconciled only by `rev`-based sync (`/api/history/sync`).

---

## 6. CANONICAL CONVENTIONS (SHARED BY ALL DOCUMENTS)

| Topic | Convention |
|---|---|
| **Sequence identity** | `sha256` = lowercase hex SHA-256 over UTF-8 bytes of `"hs1:" + canonical_residues` (the `hs1:` domain prefix allows future algorithm versioning). |
| **Canonical residues** | Strip FASTA header lines, all whitespace, digits, `*`, `-`; uppercase; if sequence contains `U` and no `T`, map `U→T` and set `molecule="RNA"`. Remaining chars must be in IUPAC nucleotide set `ACGTRYSWKMBDHVN`. |
| **Numeric encoding for C++** | `uint8` array: `A=0, C=1, G=2, T=3, any ambiguity/N=4`. Original IUPAC string is kept in DuckDB for display. |
| **Coordinates** | 0-based, half-open `[start, end)` in all APIs; UI may display 1-based. |
| **Endianness / dtype** | Little-endian. Telemetry is `float32`, planar layout (one contiguous array per channel). |
| **Sequence limit** | Soft cap 5,000,000 bp (configurable); larger inputs rejected with `SEQUENCE_TOO_LONG`. |
| **Units** | Tm in °C; ΔG in kcal/mol at 37 °C; lengths in nm; default Na⁺ 50 mM. |
| **B-DNA geometry constants** | Rise 0.34 nm/bp; pitch 3.4 nm (~10 bp/turn); major groove width 2.2 nm; minor groove width 1.2 nm; helix diameter ~2.0 nm. A=T → 2 H-bonds, G≡C → 3 H-bonds. |
| **Time** | ISO-8601 UTC strings in JSON; DuckDB `TIMESTAMP` (UTC). |
| **IDs** | `scan_id`, `mutation_id`: UUIDv7 strings (time-sortable). |
| **Versioning** | `model_version` (string), `core_version` (from C++ module), `contract_version` (`"1"`) are attached to cache rows and WS `scan_ready`. |
| **Thermodynamic model** | SantaLucia (1998) unified nearest-neighbor ΔH/ΔS with salt correction; default window 20 nt, stride 1. |
| **Chaos Game Representation** | Unit-square corners `A(0,0) C(0,1) G(1,1) T(1,0)`; each point is the midpoint between previous point and the corner of the current base. |

---

## 7. END-TO-END INTERCONNECTION SUMMARY (EXECUTIVE VIEW)

```text
 USER ACTION          FRONTEND                 BACKEND                         NATIVE/ML              STORES
 ───────────          ────────                 ───────                         ─────────              ──────
 type NM_004006  ──►  NcbiForm ──POST /api/ingest/ncbi──► routes_ingest ─► ncbi_client ─► NCBI efetch
 type 1BNA       ──►  PdbForm  ──POST /api/ingest/pdb───► routes_ingest ─► pdb_client  ─► RCSB REST
 paste text      ──►  PasteModal ─POST /api/ingest/paste► routes_ingest ─► sanitizer
 drop file       ──►  FileDropZone POST /api/ingest/file► file_ingest   ─► sanitizer
 file in watch/  ─────────────────────────────────────────► watcher ─────► sanitizer
                                                │
                                                ▼
                                   ingestion.pipeline.ingest_records
                                   canonicalize → sha256 → DuckDB lookup ─────────────────► DuckDB
                                                │ (hit: skip network & inference)
                                                ▼
                                   IngestResponse (JSON) ───────────────► IndexedDB (history, sequences)
                                                │
              click "Scan"                      ▼
 WS /ws/scan ◄──────────────────────► ScanSession ─► core_bridge ─► helixsight_core (C++ via pybind11)
                                                │   ─► ml.inference (PyTorch/ONNX)
                                                │   ─► DuckDB analysis_cache (write-through)
                                                ▼
                         binary telemetry frames ─► stream.worker ─► ring buffers ─► Canvas @60fps
```

Full step-by-step narratives, diagrams, and contracts are in `01_SYSTEM_ARCHITECTURE_AND_DATAFLOW.md`.

---

## 8. STATEFUL PHASE TRACKER

> Tick `[x]` as phases complete. When asking an assistant for work, state the Phase ID (e.g. "P3.2"). Keep this section in sync.

### P0 — Specification & Repo Bootstrap
- [x] P0.1 `00_MASTER_CONTEXT_AND_RULES.md` generated
- [x] P0.2 `01_SYSTEM_ARCHITECTURE_AND_DATAFLOW.md` generated
- [ ] P0.3 Spec files 02–03 generated
- [ ] P0.4 Spec files 04–05 generated
- [ ] P0.5 Monorepo skeleton created per Section 5; `uv` + `pnpm` workspaces resolve
- [ ] P0.6 CI script: license audit (C-1), contract diff (Pydantic ↔ TS)

### P1 — Native C++ Core (`cpp_core/`)
- [ ] P1.1 `encode`, `gc` (windowed GC%, GC-skew) + doctest
- [ ] P1.2 `kmer` sliding-window counting (k=1..8, rolling 2-bit hash)
- [ ] P1.3 `cgr` coordinate generation
- [ ] P1.4 `thermo` SantaLucia NN (prefix-sum Tm/ΔG per window)
- [ ] P1.5 `zdna` alternating purine/pyrimidine Z-propensity heuristic
- [ ] P1.6 pybind11 bindings: zero-copy NumPy, GIL release, version string
- [ ] P1.7 scikit-build-core wheel builds under WSL2 via `uv`
- [ ] P1.8 Benchmarks recorded (targets in doc 01 §14)

### P2 — Backend Foundations
- [ ] P2.1 FastAPI app factory, config, lifespan, error model
- [ ] P2.2 DuckDB store: single-writer queue, `001_init.sql`, `rev` sequence
- [ ] P2.3 `sanitizer.py` + `hasher.py` + golden-vector tests (shared with TS)
- [ ] P2.4 `ingest_records` pipeline + `/api/ingest/paste`
- [ ] P2.5 `/api/history`, `/api/history/{sha}`, `/api/history/sync`

### P3 — External Ingestion Lanes
- [ ] P3.1 `ncbi_client.py` (efetch + esummary, 3 req/s limiter, retries)
- [ ] P3.2 `pdb_client.py` (FASTA + entity metadata, nucleic-acid entity selection)
- [ ] P3.3 `/api/ingest/file` multipart + `watcher.py` (inotify/polling fallback)
- [ ] P3.4 `/ws/events` publishes `ingest_complete` from watcher

### P4 — ML / DL Stack
- [ ] P4.1 1D-CNN + BiLSTM (+ attention pooling head) architecture
- [ ] P4.2 Training script + free public dataset recipe + model card
- [ ] P4.3 IsolationForest/autoencoder on k-mer vectors (`anomaly.py`)
- [ ] P4.4 ONNX export + INT8 quantization; parity tests (torch vs ORT)
- [ ] P4.5 `pathogenicity.py` mutation delta scoring + labeling per C-9

### P5 — Streaming Engine
- [ ] P5.1 Binary frame packer/unpacker (`framing.py` ⇄ `contracts/ws.ts`)
- [ ] P5.2 `ScanSession` state machine + ack-window backpressure
- [ ] P5.3 Cache-aware streaming (replay from `analysis_cache`)
- [ ] P5.4 `mutate` command: local-window recompute + `mutation_result`

### P6 — Frontend Shell & Persistence
- [ ] P6.1 Vite + React + Tailwind + PWA scaffold (installable, offline shell)
- [ ] P6.2 `canonicalize.ts` + `sha256.ts` matching backend golden vectors
- [ ] P6.3 IndexedDB schema + `repo.ts` (<5 ms reload benchmark)
- [ ] P6.4 `sync.ts` rev-based delta sync
- [ ] P6.5 Ingestion panel (4 lanes) + History Drawer

### P7 — Visualization & HUD
- [ ] P7.1 `stream.worker.ts` + ring buffers
- [ ] P7.2 2D Canvas helix with reading head (60 fps)
- [ ] P7.3 Groove/pitch/rise overlays, H-bond rendering, purine/pyrimidine rings
- [ ] P7.4 Thermo heatmap (Tm, ΔG), B→Z conformation morph
- [ ] P7.5 Attention glow, classifier tracks, anomaly alerts
- [ ] P7.6 Mutation panel (click-to-flip, deltas, history log)
- [ ] P7.7 CGR radar + Web Audio sonification
- [ ] P7.8 Optional Three.js 3D toggle

### P8 — Offline & Polish
- [ ] P8.1 ONNX Runtime Web offline inference path
- [ ] P8.2 Service worker precache + runtime caching of `/models/*`
- [ ] P8.3 Accessibility, reduced-motion, mute defaults for audio
- [ ] P8.4 Perf pass vs budgets; memory profiling at 5 Mbp

### P9 — Release
- [ ] P9.1 E2E (Playwright) for all four lanes + history reload
- [ ] P9.2 Packaging docs (WSL2 setup, one-command dev)
- [ ] P9.3 License audit + MODEL_CARDS complete
- [ ] P9.4 v0.1.0 tag

---

## 9. AI-ASSISTANT SESSION PROTOCOL

When a coding session starts, the assistant must reply with:
1. **Understood constraints** (one-line each for C-1…C-10).
2. **Target Phase ID(s)** for this session.
3. **Files to be created/modified** with their interconnections (what calls them, what they call, payload types).
4. After coding: **updated Phase Tracker lines** and any **new ADR** needed.

**Definition of Done (per file):** type-checks (`tsc --noEmit` / `mypy`), lint-clean (`ruff` / `eslint`), unit test present, interconnection paragraph in the file header docstring, no new dependency outside the Section 4 matrix.

---

## 10. GLOSSARY

- **Reading head:** the moving 5'→3' window (default 40 bp visible) highlighted on the helix and tracks.
- **Telemetry channel:** one `float32` per-position series (e.g. `gc_pct`, `attention`).
- **Content-addressed:** identified by hash of content rather than by name/source.
- **`rev`:** monotonically increasing server revision used for delta sync of history.
- **Params hash:** SHA-256 of canonical JSON of analysis parameters (window size, stride, Na⁺, k, etc.).