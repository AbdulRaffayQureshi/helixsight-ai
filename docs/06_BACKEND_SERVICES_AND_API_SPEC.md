# 06_BACKEND_SERVICES_AND_API_SPEC.md

> **HelixSight AI** · Document `06` of `06` · Depends on: `00`–`05` (uses `04`'s `repo.py`, `duckdb_store.py`, `native.py`, `ids.py`)
> Scope: complete backend service code — configuration, error model, Pydantic contracts, sanitizer, NCBI/RCSB clients, ingestion pipeline, folder watcher, ML glue, binary framing, ack backpressure, `ScanSession`, mutation service, REST + WebSocket routers, app factory — with the tests that exercised it.
> **Verification status:** all code below ran under `pytest` on Ubuntu 24.04 / Python 3.12 / FastAPI 0.162 / DuckDB / the compiled `helixsight_core` from doc 04: **19 tests passed** (6 sanitizer, 6 REST/ingestion, 5 WebSocket, 2 watcher incl. polling mode). **Not exercised:** live NCBI/RCSB endpoints (fixtures follow the documented JSON shapes — re-check field names on the first real call in build step B5), real ONNX/torch runners (a stub model stood in), 5 Mbp scale, `/mnt/*` polling on real WSL2, static-file serving.

---

## 0. PURPOSE & INTERCONNECTION

```text
 BROWSER                           FASTAPI (this doc)                                            DOC 04 / DOC 03
 ───────                           ──────────────────                                            ───────────────
 NcbiForm ─POST /api/ingest/ncbi─► routes_ingest ─► Ingestor.ingest_ncbi ─► NcbiClient (httpx) ─► eutils.ncbi.nlm.nih.gov
 PdbForm  ─POST /api/ingest/pdb──►               ─► Ingestor.ingest_pdb  ─► PdbClient (httpx) ─► data.rcsb.org
 PasteModal─POST /api/ingest/paste►              ─► Ingestor.ingest_paste ┐
 FileDropZone─POST /api/ingest/file►             ─► Ingestor.ingest_file  ┤  canonicalize() ─► sha256
 folder drop ─► watchdog thread ─► loop.call_soon_threadsafe ─► FolderWatcher._process ─► ingest_file ┘
                                                  every lane ─► repo.ingest_one (doc 04) ─► DuckDB (sequences, source_records,
                                                                 accession_index, analysis_history) ─► IngestResponse
 /ws/events ◄─ EventHub.publish ◄─ history_changed / ingest_complete / watcher_status / server_notice
 History click(miss) / Scan ─WS /ws/scan─► ScanSession ─► repo.get_analysis_meta ─HIT─► repo.get_chunk ─► frames
                                                       └MISS─► native.compute_core_channels_async (C++, doc 04)
                                                              ► predict_sequence (ONNX/torch, doc 03)  ► anomaly_scores (doc 03)
                                                              ► repo.put_analysis (one tx) ► frames ► scan_complete
 mutate / REST mutation ─► apply_mutation ─► native.local_thermo + score_mutation ─► repo.add_mutation ─► mutation_result
```

**Concurrency rules (binding):** the event loop never runs CPU-heavy code (encode, native kernels, inference, anomaly forest run via `asyncio.to_thread` / the `hs-core` pool); DuckDB is touched only through `DuckStore.read/write_tx`; watchdog threads do nothing except `loop.call_soon_threadsafe`; all WebSocket sends go through one `asyncio.Lock` per session (frames and JSON never interleave mid-message).

---

## 1. DECISIONS & DEVIATIONS FROM EARLIER DOCS

| # | Decision |
|---|---|
| S1 | **PDB sequences come from the polymer-entity JSON** (`entity_poly.pdbx_seq_one_letter_code_can`); the `rcsb.org/fasta/entry/{id}` endpoint is only a fallback when that field is empty. Calls per default ingest: 1 entry + N entity requests (was FASTA + entry + N). `X` → `N` before canonicalization. |
| S2 | **Alias accession keys:** a default PDB ingest also stores `"{ID}:*"` → sha so repeat requests need zero network; an unversioned NCBI request also stores the immutable versioned key (`NM_000001.2`). |
| S3 | **Expired unversioned NCBI accessions** revalidate with `esummary`; same `accessionversion` → TTL extended, no FASTA download; network down/throttled → serve the cached copy with a warning. |
| S4 | **Error mapping:** HTTP 5xx / transport / timeout after retries → `UPSTREAM_TIMEOUT` (504); 429 after retries → `NCBI_RATE_LIMITED` (503 + `Retry-After`); malformed `accession`/`pdb_id` (pydantic) → `INVALID_ACCESSION` (422); oversized file → `SEQUENCE_TOO_LONG` (413). `INVALID_IUPAC.detail` = `{offset, raw_offset, char}`: `offset` indexes the cleaned residues, `raw_offset` indexes the newline-normalised input (what `<textarea>.value` holds) so the UI can highlight the character. |
| S5 | **Overview frame** is stream frame `seq 0` (`frame_type 0x02`, `start` = bin size in bp, `count` = bins). Bin count is `ceil(L / ceil(L/4096))` (e.g. 4000 for 20 kb), not a fixed 4096. |
| S6 | **Idle timeout is 45 s** (3 missed 15 s client pings → close `4408`), superseding the 120 s in doc 01's §7.2 diagram. Unacked-frame stall > 10 s → close `4409`. Protocol violations → fatal `error` + close `4400`. |
| S7 | **Cross-site WebSocket hijacking guard (new constraint C-11):** a browser `Origin` must be in `HS_CORS_ORIGINS` or equal the request `Host`; otherwise the handshake is rejected (`4403`/HTTP 403). Without this any web page could open `ws://localhost:8000/ws/scan` and read local data. Clients with no `Origin` header (scripts) are allowed. |
| S8 | **Degraded modes are first-class:** no model → `MODEL_UNAVAILABLE` notice, rows 7–11 NaN, anomaly/thermo/CGR still stream; no native wheel → `CORE_UNAVAILABLE` notice (doc 04 D11). `GET /api/health` reports `degraded`. |
| S9 | **Two new read endpoints** for hydration: `GET /api/analysis/{sha}/meta` (regions, ids, versions) and `GET /api/analysis/{sha}` (planar float32 `[C × L]`, same layout as the IndexedDB `tensors` store, headers `X-HS-Channels/Length/Params-Hash`). Mutations: `GET /api/history/{scan_id}/mutations`, `DELETE /api/mutations/{id}`. |
| S10 | History `created_at/updated_at` are serialised as UTC with a `Z` suffix (naive DuckDB timestamps are tagged UTC on the way out). |

---

## 2. FILE LAYOUT (additions/changes to doc 00 §5)

```text
backend/src/helixsight/
├── config.py            main.py            errors.py          events.py          services.py      ids.py (doc 04)
├── schemas/{__init__,models}.py                              # one module replaces common/ingest/history/ws
├── ingestion/{hasher,sanitizer,http_util,ncbi_client,pdb_client,pipeline,watcher}.py   # fasta.py merged into sanitizer.py
├── db/{duckdb_store,repo (doc 04),queries}.py  db/migrations/001_init.sql (doc 04)
├── core_bridge/native.py (doc 04)
├── ml/{inference,anomaly,anomaly_kind,pathogenicity,registry}.py   (+ models.py, onnx_export.py from doc 03)
├── streaming/{framing,params,scheduler,mutations,session}.py
└── api/{deps,routes_ingest,routes_history,routes_analysis,ws_scan,ws_events}.py
backend/tests/{conftest,test_sanitizer,test_api,test_ws,test_watcher}.py  (+ test_core_bridge, test_duckdb_repo from doc 04)
```

---

## 3. APPLICATION CORE

### 3.1 `config.py` (supersedes doc 05 §3.3: adds `watch_enabled`, `max_upload_mb`)
```python
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration comes from HS_* environment variables / .env (see .env.example)."""
    model_config = SettingsConfigDict(env_prefix="HS_", env_file=".env", extra="ignore")

    db_path: Path = Path("data/helixsight.duckdb")
    duckdb_memory_limit: str = "1GB"
    watch_dir: Path = Path("~/helixsight_watch")
    watch_enabled: bool = True
    ncbi_tool: str = "helixsight"
    ncbi_email: str = ""
    ncbi_api_key: str = ""
    runner: Literal["ort", "torch"] = "ort"
    model_dir: Path = Path("ml_models/onnx")
    ort_threads: int = 1
    core_executor_threads: int = 2
    cache_codec: Literal["raw", "zstd"] = "raw"
    max_seq_bp: int = 5_000_000
    max_upload_mb: int = 50
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    serve_static: bool = False
    log_level: str = "info"

    @field_validator("watch_dir", "db_path", "model_dir")
    @classmethod
    def _expand(cls, v: Path) -> Path:
        return v.expanduser()

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def watch_uses_polling(self) -> bool:
        return str(self.watch_dir.resolve()).startswith("/mnt/")   # WSL2 /mnt/* has no reliable inotify (C-5)
```
Add `HS_WATCH_ENABLED=1` and `HS_MAX_UPLOAD_MB=50` to `.env.example`.

### 3.2 `errors.py`
```python
"""One error vocabulary for REST and WebSocket (doc 01 section 13)."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .schemas.models import ErrorBody, ErrorCode

HTTP_STATUS: dict[str, int] = {
    "INVALID_ACCESSION": 422, "NCBI_NOT_FOUND": 404, "NCBI_RATE_LIMITED": 503, "UPSTREAM_TIMEOUT": 504,
    "PDB_NOT_FOUND": 404, "PDB_NO_NUCLEIC_ACID": 422, "INVALID_IUPAC": 422, "EMPTY_SEQUENCE": 422,
    "SEQUENCE_TOO_LONG": 413, "UNKNOWN_SEQUENCE": 404, "CORE_UNAVAILABLE": 503, "MODEL_UNAVAILABLE": 503,
    "PROTOCOL_ERROR": 400, "INTERNAL": 500,
}


class HSError(Exception):
    def __init__(self, code: ErrorCode, message: str, detail: Optional[dict[str, Any]] = None,
                 retry_after: Optional[float] = None) -> None:
        super().__init__(message)
        self.code, self.message, self.detail, self.retry_after = code, message, detail, retry_after

    @property
    def status(self) -> int:
        return HTTP_STATUS[self.code]

    def body(self) -> ErrorBody:
        return ErrorBody(code=self.code, message=self.message, detail=self.detail)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(HSError)
    async def _hs(_: Request, exc: HSError) -> JSONResponse:
        headers = {"Retry-After": str(int(exc.retry_after) + 1)} if exc.retry_after else None
        return JSONResponse(exc.body().model_dump(mode="json"), status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _val(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = {str(p) for e in exc.errors() for p in e.get("loc", ())}
        code: ErrorCode = "INVALID_ACCESSION" if fields & {"accession", "pdb_id"} else "PROTOCOL_ERROR"
        body = ErrorBody(code=code, message="Request validation failed",
                         detail={"errors": [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]})
        return JSONResponse(body.model_dump(mode="json"), status_code=422)
```
Error bodies are the top-level `ErrorBody` JSON (`{"code","message","detail"}`) with the HTTP status from the table; the WebSocket `error` message wraps the same `ErrorBody`.

### 3.3 `schemas/__init__.py` and `schemas/models.py`
```python
from .models import *  # noqa: F401,F403
```
```python
"""Pydantic v2 contracts: source of truth for frontend/src/contracts/*.ts (doc 01 sections 10-11)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

CONTRACT_VERSION = 1

SourceKind = Literal["NCBI", "PDB", "PASTE", "FILE"]
Molecule = Literal["DNA", "RNA"]
CacheStatus = Literal["HIT_ACCESSION", "HIT_SHA", "MISS_STORED"]
ErrorCode = Literal[
    "INVALID_ACCESSION", "NCBI_NOT_FOUND", "NCBI_RATE_LIMITED", "UPSTREAM_TIMEOUT", "PDB_NOT_FOUND",
    "PDB_NO_NUCLEIC_ACID", "INVALID_IUPAC", "EMPTY_SEQUENCE", "SEQUENCE_TOO_LONG", "UNKNOWN_SEQUENCE",
    "CORE_UNAVAILABLE", "MODEL_UNAVAILABLE", "PROTOCOL_ERROR", "INTERNAL",
]
Base4 = Literal["A", "C", "G", "T"]


class Req(BaseModel):          # inbound: unknown fields are a protocol error
    model_config = ConfigDict(extra="forbid")


class Res(BaseModel):          # outbound: DB rows may carry extra columns (e.g. `deleted`)
    model_config = ConfigDict(extra="ignore")


def _utc(v: Any) -> Any:
    return v.replace(tzinfo=timezone.utc) if isinstance(v, datetime) and v.tzinfo is None else v


# ───────────── ingestion requests ─────────────
class NcbiIngestRequest(Req):
    accession: Annotated[str, Field(pattern=r"^[A-Za-z]{1,4}_?[0-9]+(\.[0-9]+)?$", max_length=32)]
    db: Literal["nuccore"] = "nuccore"
    force_refresh: bool = False


class PdbIngestRequest(Req):
    pdb_id: Annotated[str, Field(pattern=r"^[0-9][A-Za-z0-9]{3}$")]
    entity_id: Optional[int] = Field(default=None, ge=1)
    all_nucleic_acid: bool = False
    force_refresh: bool = False


class PasteIngestRequest(Req):
    text: Annotated[str, Field(min_length=1, max_length=20_000_000)]
    label: Optional[Annotated[str, Field(max_length=120)]] = None


class ProgressRequest(Req):
    last_scanned_pos: int = Field(ge=0)


class MutationRequest(Req):
    request_id: str
    scan_id: str
    position: int = Field(ge=0)
    alt: Base4


# ───────────── records ─────────────
class HistoryRecord(Res):
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

    _tz = field_validator("created_at", "updated_at", mode="before")(_utc)


class IngestItem(Res):
    sha256: str
    cache_status: CacheStatus
    record: HistoryRecord
    has_analysis_cache: bool


class IngestResponse(Res):
    contract_version: int = CONTRACT_VERSION
    items: list[IngestItem]
    warnings: list[str] = []


class HistoryPage(Res):
    items: list[HistoryRecord]
    next_cursor: Optional[str] = None


class HistorySyncResponse(Res):
    since_rev: int
    latest_rev: int
    upserts: list[HistoryRecord]
    deleted: list[str]


class SequencePayload(Res):
    sha256: str
    molecule: Molecule
    length: int
    residues: str


class Mutation(Res):
    mutation_id: str
    scan_id: str
    sha256: str
    position: int
    ref: Literal["A", "C", "G", "T", "N"]
    alt: Base4
    delta_tm_c: Optional[float] = None
    delta_dg_kcal: Optional[float] = None
    delta_p_promoter: Optional[float] = None
    delta_p_cpg: Optional[float] = None
    delta_p_splice: Optional[float] = None
    pathogenicity: Optional[float] = Field(default=None, ge=0, le=1)   # research heuristic (C-9)
    created_at: datetime

    _tz = field_validator("created_at", mode="before")(_utc)


class ErrorBody(Res):
    code: ErrorCode
    message: str
    detail: Optional[dict[str, Any]] = None


class ModelScope(Res):
    trained_on: str
    warning: str


class ChannelInfo(Res):
    id: int
    name: str
    unit: str
    min: float
    max: float


class AnomalyRegion(Res):
    start: int
    end: int
    score: float
    kind: Literal["composition_shift", "possible_hgt", "low_complexity", "unknown"]


class AnalysisMeta(Res):
    analysis_id: str
    sha256: str
    length: int
    channel_ids: list[int]
    params_hash: str
    model_version: str
    core_version: str
    anomaly_count: int
    regions: list[AnomalyRegion]
    overview_bins: int


class Health(Res):
    status: Literal["ok", "degraded"]
    core_version: str
    core_available: bool
    model_version: str
    model_available: bool
    watcher: Optional[dict[str, Any]] = None
    integrity: Optional[dict[str, int]] = None


# ───────────── WebSocket: client -> server ─────────────
class WsHello(Req):
    type: Literal["hello"] = "hello"
    contract: int = CONTRACT_VERSION
    client: str = "web"


class WsStartScan(Req):
    type: Literal["start_scan"] = "start_scan"
    sha256: str
    window_bp: int = 40
    speed_bps: float = 50.0
    want: list[int] = Field(default_factory=lambda: list(range(13)))
    force_recompute: bool = False


class WsAck(Req):
    type: Literal["ack"] = "ack"
    stream_seq: int


class WsCheckpoint(Req):
    type: Literal["checkpoint"] = "checkpoint"
    scan_id: str
    last_scanned_pos: int = Field(ge=0)


class WsMutate(Req):
    type: Literal["mutate"] = "mutate"
    request_id: str
    scan_id: str
    position: int = Field(ge=0)
    alt: Base4


class WsStop(Req):
    type: Literal["stop"] = "stop"


class WsPing(Req):
    type: Literal["ping"] = "ping"
    t: int


ClientMsg = Annotated[Union[WsHello, WsStartScan, WsAck, WsCheckpoint, WsMutate, WsStop, WsPing],
                      Field(discriminator="type")]


# ───────────── WebSocket: server -> client (JSON) ─────────────
class WsHelloAck(Res):
    type: Literal["hello_ack"] = "hello_ack"
    session_id: str
    contract: int
    core_version: str
    model_version: str


class WsScanReady(Res):
    type: Literal["scan_ready"] = "scan_ready"
    sha256: str
    length: int
    channels: list[ChannelInfo]
    chunk_positions: int
    cache: Literal["HIT", "MISS"]
    params_hash: str
    overview_bins: int
    model_scope: Optional[ModelScope] = None


class WsProgress(Res):
    type: Literal["progress"] = "progress"
    pos: int
    fraction: float


class WsAnomalyAlert(Res):
    type: Literal["anomaly_alert"] = "anomaly_alert"
    start: int
    end: int
    score: float
    kind: Literal["composition_shift", "possible_hgt", "low_complexity", "unknown"]


class WsScanComplete(Res):
    type: Literal["scan_complete"] = "scan_complete"
    anomaly_count: int
    duration_ms: int


class WsMutationResult(Res):
    type: Literal["mutation_result"] = "mutation_result"
    request_id: str
    mutation: Mutation


class WsError(Res):
    type: Literal["error"] = "error"
    error: ErrorBody
    fatal: bool = False


class WsPong(Res):
    type: Literal["pong"] = "pong"
    t: int


# ───────────── /ws/events ─────────────
class EvIngestComplete(Res):
    type: Literal["ingest_complete"] = "ingest_complete"
    item: IngestItem


class EvHistoryChanged(Res):
    type: Literal["history_changed"] = "history_changed"
    latest_rev: int


class EvWatcherStatus(Res):
    type: Literal["watcher_status"] = "watcher_status"
    watching: bool
    path: str
    mode: Literal["inotify", "polling"]
```
Mirror every added or changed model in `frontend/src/contracts/*.ts` in the same commit: `AnalysisMeta`, `AnomalyRegion`, `Health`, `ModelScope`, `ProgressRequest`, `WsScanReady.model_scope`, and `INVALID_IUPAC.detail.raw_offset`. `/ws/events` also carries `{"type":"server_notice","level":"warning","message":str}` (plain dict).

### 3.4 `events.py`
```python
"""In-process pub/sub for /ws/events (history changes, watcher ingests, notices)."""
from __future__ import annotations

import asyncio
from typing import Any, Union

from pydantic import BaseModel


class EventHub:
    def __init__(self, queue_size: int = 100) -> None:
        self._subs: set[asyncio.Queue] = set()
        self._size = queue_size

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(self._size)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    async def publish(self, event: Union[BaseModel, dict[str, Any]]) -> None:
        data = event.model_dump(mode="json") if isinstance(event, BaseModel) else event
        for q in list(self._subs):
            if q.full():
                q.get_nowait()          # slow consumer: drop the oldest event, never block the producer
            q.put_nowait(data)
```

### 3.5 `services.py`
```python
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Optional

import httpx
import numpy as np

from .config import Settings
from .core_bridge.native import CoreParams
from .db.duckdb_store import DuckStore
from .events import EventHub
from .ingestion.ncbi_client import NcbiClient
from .ingestion.pdb_client import PdbClient
from .ingestion.pipeline import Ingestor
from .ingestion.watcher import FolderWatcher
from .ml.registry import ModelBundle


class CodesCache:
    """Tiny LRU of encoded sequences (uint8 codes) so mutations/rescans do not re-encode multi-Mbp strings."""

    def __init__(self, size: int = 4) -> None:
        self._d: OrderedDict[str, np.ndarray] = OrderedDict()
        self._size = size

    def get(self, sha: str) -> Optional[np.ndarray]:
        if sha in self._d:
            self._d.move_to_end(sha)
            return self._d[sha]
        return None

    def put(self, sha: str, codes: np.ndarray) -> None:
        self._d[sha] = codes
        self._d.move_to_end(sha)
        while len(self._d) > self._size:
            self._d.popitem(last=False)


@dataclass
class Services:
    settings: Settings
    store: DuckStore
    http: httpx.AsyncClient
    ncbi: NcbiClient
    pdb: PdbClient
    hub: EventHub
    ingestor: Ingestor
    bundle: ModelBundle
    core_params: CoreParams
    params_hash: str
    codes_cache: CodesCache = field(default_factory=CodesCache)
    watcher: Optional[FolderWatcher] = None
```

### 3.6 `db/queries.py` (read/maintenance helpers; `repo.py` from doc 04 stays authoritative for writes)
```python
"""Read/maintenance helpers used by services (kept apart from repo.py so doc 04 stays authoritative for writes)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from .repo import CanonicalRecord, Cur, _one


def get_sequence(cur: Cur, sha256: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute("SELECT * FROM sequences WHERE sha256 = ?", [sha256]))


def to_canonical(row: dict[str, Any], display_name: str, description: Optional[str]) -> CanonicalRecord:
    return CanonicalRecord(row["sha256"], row["residues"], row["molecule"], int(row["length"]), float(row["gc_pct"]),
                           int(row["a_count"]), int(row["c_count"]), int(row["g_count"]), int(row["t_count"]),
                           int(row["ambiguous_count"]), display_name, description)


def latest_source(cur: Cur, sha256: str, source: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute("SELECT * FROM source_records WHERE sha256 = ? AND source = ? "
                            "ORDER BY fetched_at DESC LIMIT 1", [sha256, source]))


def accession_any(cur: Cur, source: str, key: str) -> Optional[dict[str, Any]]:
    """accession_index row regardless of TTL (expired rows trigger revalidation, doc 01 section 3.1)."""
    return _one(cur.execute("SELECT * FROM accession_index WHERE source = ? AND accession_key = ?", [source, key]))


def touch_accession(cur: Cur, source: str, key: str, ttl_expires_at: Optional[datetime], now: datetime) -> None:
    cur.execute("UPDATE accession_index SET ttl_expires_at = ?, fetched_at = ? WHERE source = ? AND accession_key = ?",
                [ttl_expires_at, now, source, key])


def get_history(cur: Cur, scan_id: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute("SELECT * FROM v_history_record WHERE scan_id = ? AND NOT deleted", [scan_id]))


def latest_history_for_sha(cur: Cur, sha256: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute("SELECT * FROM v_history_record WHERE sha256 = ? AND NOT deleted ORDER BY rev DESC LIMIT 1", [sha256]))


def watch_get(cur: Cur, path: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute("SELECT * FROM watch_files WHERE path = ?", [path]))


def watch_put(cur: Cur, path: str, size: int, mtime_ns: int, status: str, error: Optional[str], now: datetime) -> None:
    cur.execute("INSERT INTO watch_files (path, size_bytes, mtime_ns, status, error, ingested_at) VALUES (?,?,?,?,?,?) "
                "ON CONFLICT (path) DO UPDATE SET size_bytes = excluded.size_bytes, mtime_ns = excluded.mtime_ns, "
                "status = excluded.status, error = excluded.error, ingested_at = excluded.ingested_at",
                [path, size, mtime_ns, status, error, now])


def put_accession(cur: Cur, source: str, key: str, sha256: str, resolved: Optional[str],
                  ttl_expires_at: Optional[datetime], now: datetime) -> None:
    cur.execute("INSERT INTO accession_index (source, accession_key, sha256, resolved_acc, fetched_at, ttl_expires_at) "
                "VALUES (?,?,?,?,?,?) ON CONFLICT (source, accession_key) DO UPDATE SET sha256 = excluded.sha256, "
                "resolved_acc = excluded.resolved_acc, fetched_at = excluded.fetched_at, "
                "ttl_expires_at = excluded.ttl_expires_at", [source, key, sha256, resolved, now, ttl_expires_at])
```

---

## 4. INGESTION

### 4.1 `ingestion/hasher.py`
```python
from __future__ import annotations

import hashlib


def sha256_canonical(residues: str) -> str:
    """Identity of a sequence: SHA-256 over UTF-8 bytes of 'hs1:' + canonical residues (doc 00 section 6)."""
    return hashlib.sha256(("hs1:" + residues).encode("utf-8")).hexdigest()
```

### 4.2 `ingestion/sanitizer.py`
```python
"""FASTA / raw-sequence canonicalization (doc 01 section 3.0). Mirrors frontend/src/lib/canonicalize.ts.

Offsets in errors are 0-based. `offset` indexes the cleaned residue string, `raw_offset` indexes the
input text after newline normalisation (\\r\\n and \\r -> \\n), which is what a browser <textarea>.value holds."""
from __future__ import annotations

import re
from typing import Optional

from ..db.repo import CanonicalRecord
from ..errors import HSError
from .hasher import sha256_canonical

_STRIP = re.compile(r"[\s\d*\-\ufeff]+")          # whitespace, GenBank line numbers, terminators, gaps, BOM
_BAD = re.compile(r"[^ACGTRYSWKMBDHVN]")


def _split(text: str) -> list[tuple[Optional[str], list[tuple[int, int]]]]:
    """-> [(header|None, [(line_start, line_end), ...])] in file order."""
    recs: list[tuple[Optional[str], list[tuple[int, int]]]] = []
    header: Optional[str] = None
    spans: list[tuple[int, int]] = []
    pos = 0
    for line in text.split("\n"):
        start, pos = pos, pos + len(line) + 1
        if line.startswith(">"):
            recs.append((header, spans))
            header, spans = line[1:].strip(), []
        else:
            spans.append((start, start + len(line)))
    recs.append((header, spans))
    return recs


def _raw_offset(text: str, spans: list[tuple[int, int]], idx: int) -> Optional[int]:
    n = 0
    for s, e in spans:
        for j in range(s, e):
            if _STRIP.fullmatch(text[j]):
                continue
            if n == idx:
                return j
            n += 1
    return None


def canonicalize(text: str, *, label: Optional[str] = None, name_hint: Optional[str] = None,
                 max_bp: int = 5_000_000) -> tuple[list[CanonicalRecord], list[str]]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[CanonicalRecord] = []
    warnings: list[str] = []
    parsed = []
    for header, spans in _split(text):
        cleaned = _STRIP.sub("", "".join(text[s:e] for s, e in spans)).upper()
        if not cleaned:
            if header is not None:
                warnings.append(f"record {header.split(None, 1)[0] if header else 'unnamed'!r} is empty and was skipped")
            continue
        parsed.append((header, spans, cleaned))
    if not parsed:
        raise HSError("EMPTY_SEQUENCE", "No nucleotide residues found in the input")

    for header, spans, cleaned in parsed:
        molecule = "DNA"
        if "U" in cleaned and "T" not in cleaned:
            cleaned, molecule = cleaned.replace("U", "T"), "RNA"
        if len(cleaned) > max_bp:
            raise HSError("SEQUENCE_TOO_LONG", f"Sequence has {len(cleaned):,} bases; the limit is {max_bp:,}",
                          {"length": len(cleaned), "max": max_bp})
        bad = _BAD.search(cleaned)
        if bad:
            raise HSError("INVALID_IUPAC", f"Invalid nucleotide {bad.group()!r} at residue offset {bad.start()}",
                          {"offset": bad.start(), "raw_offset": _raw_offset(text, spans, bad.start()), "char": bad.group()})
        sha = sha256_canonical(cleaned)
        a, c, g, t = (cleaned.count(x) for x in "ACGT")
        acgt = a + c + g + t
        hdr_name, _, hdr_desc = (header or "").partition(" ")
        if header:
            name = hdr_name
            if label:
                name = label if len(parsed) == 1 else f"{label}:{hdr_name}"
        else:
            name = label or name_hint or f"pasted-{sha[:8]}"
        out.append(CanonicalRecord(sha, cleaned, molecule, len(cleaned), 100.0 * (g + c) / acgt if acgt else 0.0,
                                   a, c, g, t, len(cleaned) - acgt, name, hdr_desc.strip() or None))
    return out, warnings
```
Rules: headers start a record at `>`; content before the first header is an unnamed record; empty records are skipped with a warning (all-empty → `EMPTY_SEQUENCE`); `U` maps to `T` only when no `T` is present (mixed `U`+`T` is `INVALID_IUPAC`); a `label` renames a single record or prefixes `label:` on multi-record input; header-less input is named `label`, else `name_hint` (file stem / accession), else `pasted-<sha8>`.

### 4.3 `ingestion/http_util.py`
```python
"""Shared retry/backoff and token-bucket limiter for NCBI and RCSB clients."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Optional

import httpx

from ..errors import HSError
from ..schemas.models import ErrorCode


class RateLimiter:
    """Evenly spaces requests: at most `per_second` starts per second (NCBI: 3/s, 10/s with an API key)."""

    def __init__(self, per_second: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        self._interval, self._clock, self._sleep = 1.0 / per_second, clock, sleep
        self._next = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self._lock:
            now = self._clock()
            delay = max(0.0, self._next - now)
            self._next = max(now, self._next) + self._interval
        if delay:
            await self._sleep(delay)


async def get_with_retry(http: httpx.AsyncClient, url: str, *, params: Optional[dict[str, Any]] = None,
                         limiter: Optional[RateLimiter] = None, retries: int = 3, backoff: float = 0.5,
                         sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep, service: str = "upstream",
                         rate_code: ErrorCode = "UPSTREAM_TIMEOUT") -> httpx.Response:
    """Retries timeouts, transport errors, HTTP 429 and 5xx; returns any other response (404 etc.) to the caller."""
    kind, info, retry_after = "timeout", "", 0.0
    for attempt in range(retries):
        retry_after = 0.0
        if limiter:
            await limiter.wait()
        try:
            r = await http.get(url, params=params)
        except httpx.TimeoutException as e:
            kind, info = "timeout", f"timeout {e.__class__.__name__}"
        except httpx.TransportError as e:
            kind, info = "transport", e.__class__.__name__
        else:
            if r.status_code == 429:
                kind, info = "rate", "HTTP 429"
                try:
                    retry_after = float(r.headers.get("Retry-After", "0"))
                except ValueError:
                    retry_after = 0.0
            elif r.status_code >= 500:
                kind, info = "http", f"HTTP {r.status_code}"
            else:
                return r
        if attempt < retries - 1:
            await sleep(max(retry_after, backoff * (2 ** attempt)))
    if kind == "rate":
        raise HSError(rate_code, f"{service} is rate limiting requests; try again shortly or add an API key",
                      {"retry_after": retry_after}, retry_after=retry_after or 1.0)
    raise HSError("UPSTREAM_TIMEOUT", f"{service} did not respond ({info}); showing cached items only",
                  {"service": service})
```

### 4.4 `ingestion/ncbi_client.py`
```python
"""NCBI E-Utilities client (free, public). efetch -> FASTA, esummary -> metadata (doc 01 section 3.2)."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

import httpx

from ..errors import HSError
from .http_util import RateLimiter, get_with_retry

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


@dataclass(frozen=True, slots=True)
class NcbiSummary:
    uid: str
    accessionversion: str
    title: str
    organism: Optional[str]
    slen: Optional[int]


class NcbiClient:
    def __init__(self, http: httpx.AsyncClient, *, tool: str = "helixsight", email: str = "", api_key: str = "",
                 retries: int = 3, backoff: float = 0.5, limiter: Optional[RateLimiter] = None,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        self.http, self.tool, self.email, self.api_key = http, tool, email, api_key
        self.retries, self.backoff, self.sleep = retries, backoff, sleep
        self.limiter = limiter or RateLimiter(10.0 if api_key else 3.0)

    def _params(self, **extra: str) -> dict[str, str]:
        p = {"tool": self.tool, **extra}
        if self.email:
            p["email"] = self.email
        if self.api_key:
            p["api_key"] = self.api_key
        return p

    async def _get(self, endpoint: str, **params: str) -> httpx.Response:
        return await get_with_retry(self.http, f"{BASE}/{endpoint}", params=self._params(**params), limiter=self.limiter,
                                    retries=self.retries, backoff=self.backoff, sleep=self.sleep, service="NCBI",
                                    rate_code="NCBI_RATE_LIMITED")

    async def esummary(self, accession: str) -> NcbiSummary:
        r = await self._get("esummary.fcgi", db="nuccore", id=accession, retmode="json")
        try:
            data = r.json()
            result = data["result"]
            uids = result.get("uids", [])
            rec = result[uids[0]] if uids else None
        except (ValueError, KeyError, TypeError):
            rec = None
        if not rec or "error" in rec or not rec.get("accessionversion"):
            raise HSError("NCBI_NOT_FOUND", f"NCBI has no nucleotide record for {accession!r}", {"accession": accession})
        return NcbiSummary(str(rec.get("uid", uids[0])), rec["accessionversion"], rec.get("title", ""),
                           rec.get("organism"), int(rec["slen"]) if rec.get("slen") is not None else None)

    async def efetch_fasta(self, accession: str) -> str:
        r = await self._get("efetch.fcgi", db="nuccore", id=accession, rettype="fasta", retmode="text")
        text = r.text if r.status_code == 200 else ""
        if not text.lstrip().startswith(">"):
            raise HSError("NCBI_NOT_FOUND", f"NCBI returned no FASTA for {accession!r}", {"accession": accession})
        return text
```
Exact requests: `GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?tool=…&email=…&db=nuccore&id=…&retmode=json` and `…/efetch.fcgi?…&db=nuccore&id=…&rettype=fasta&retmode=text`. `api_key` is added only when configured (free; 3 → 10 req/s).

### 4.5 `ingestion/pdb_client.py`
```python
"""RCSB PDB client (free, public). Entry + polymer-entity JSON from data.rcsb.org; FASTA only as a fallback."""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional

import httpx

from ..errors import HSError
from .http_util import RateLimiter, get_with_retry

DATA = "https://data.rcsb.org/rest/v1/core"
FASTA = "https://www.rcsb.org/fasta/entry"


@dataclass(frozen=True, slots=True)
class PdbEntity:
    entity_id: int
    kind: Literal["nucleic", "protein", "other"]
    poly_type: str
    description: str
    organism: Optional[str]
    chains: list[str]
    sequence: str


def _kind(poly_type: str) -> str:
    t = poly_type.lower()
    if "ribonucleotide" in t:
        return "nucleic"
    return "protein" if t.startswith("polypeptide") else "other"


class PdbClient:
    def __init__(self, http: httpx.AsyncClient, *, retries: int = 3, backoff: float = 0.5,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        self.http, self.retries, self.backoff, self.sleep = http, retries, backoff, sleep
        self.limiter = RateLimiter(5.0)

    async def _get(self, url: str) -> httpx.Response:
        return await get_with_retry(self.http, url, limiter=self.limiter, retries=self.retries, backoff=self.backoff,
                                    sleep=self.sleep, service="RCSB PDB")

    async def entry(self, pdb_id: str) -> dict[str, Any]:
        r = await self._get(f"{DATA}/entry/{pdb_id}")
        if r.status_code != 200:                      # 404 (unknown id) and other 4xx (malformed id)
            raise HSError("PDB_NOT_FOUND", f"No PDB entry {pdb_id!r}", {"pdb_id": pdb_id})
        return r.json()

    async def _fasta_sequence(self, pdb_id: str, entity_id: int) -> str:
        r = await self._get(f"{FASTA}/{pdb_id}")
        if r.status_code != 200:
            return ""
        for block in r.text.split(">")[1:]:
            head, _, body = block.partition("\n")
            if re.match(rf"^{re.escape(pdb_id)}_{entity_id}\|", head, re.I):
                return "".join(body.split())
        return ""

    async def entity(self, pdb_id: str, entity_id: int) -> PdbEntity:
        r = await self._get(f"{DATA}/polymer_entity/{pdb_id}/{entity_id}")
        if r.status_code == 404:
            raise HSError("PDB_NOT_FOUND", f"PDB entry {pdb_id!r} has no polymer entity {entity_id}",
                          {"pdb_id": pdb_id, "entity_id": entity_id})
        j = r.json()
        poly = j.get("entity_poly", {})
        ptype = poly.get("type", "")
        seq = "".join((poly.get("pdbx_seq_one_letter_code_can") or "").split())
        if not seq:
            seq = await self._fasta_sequence(pdb_id, entity_id)
        src = (j.get("rcsb_entity_source_organism") or [{}])[0]
        chains = (j.get("rcsb_polymer_entity_container_identifiers") or {}).get("auth_asym_ids", [])
        return PdbEntity(entity_id, _kind(ptype), ptype, (j.get("rcsb_polymer_entity") or {}).get("pdbx_description", ""),
                         src.get("ncbi_scientific_name"), list(chains), seq)

    async def entities(self, pdb_id: str) -> tuple[dict[str, Any], list[PdbEntity]]:
        entry = await self.entry(pdb_id)
        ids = (entry.get("rcsb_entry_container_identifiers") or {}).get("polymer_entity_ids")
        if not ids:
            n = (entry.get("rcsb_entry_info") or {}).get("polymer_entity_count", 0)
            ids = [str(i) for i in range(1, int(n) + 1)]
        ents = await asyncio.gather(*(self.entity(pdb_id, int(i)) for i in ids))
        return entry, list(ents)


def select_entities(entities: list[PdbEntity], entity_id: Optional[int], all_nucleic: bool,
                    pdb_id: str) -> tuple[list[PdbEntity], list[str]]:
    """Nucleic-acid selection rules (doc 01 section 3.3). Returns (selected, warnings)."""
    listing = [{"entity_id": e.entity_id, "type": e.poly_type, "description": e.description} for e in entities]
    if entity_id is not None:
        match = next((e for e in entities if e.entity_id == entity_id), None)
        if match is None:
            raise HSError("PDB_NOT_FOUND", f"PDB entry {pdb_id!r} has no polymer entity {entity_id}", {"entities": listing})
        if match.kind != "nucleic":
            raise HSError("PDB_NO_NUCLEIC_ACID", f"Entity {entity_id} of {pdb_id} is {match.poly_type or 'not a nucleic acid'}",
                          {"entities": listing})
        chosen = [match]
    else:
        nucleic = [e for e in entities if e.kind == "nucleic"]
        if not nucleic:
            raise HSError("PDB_NO_NUCLEIC_ACID", f"PDB entry {pdb_id} contains no DNA/RNA entity; use the NCBI tab for nucleotide records",
                          {"entities": listing})
        chosen = nucleic if all_nucleic else nucleic[:1]
    warnings = [f"entity {e.entity_id} skipped: {e.poly_type or 'unknown type'}" for e in entities if e not in chosen]
    return chosen, warnings
```
Endpoints: `GET https://data.rcsb.org/rest/v1/core/entry/{ID}`, `GET …/core/polymer_entity/{ID}/{n}`, fallback `GET https://www.rcsb.org/fasta/entry/{ID}`. Entity JSON fields read: `entity_poly.type`, `entity_poly.pdbx_seq_one_letter_code_can`, `rcsb_polymer_entity.pdbx_description`, `rcsb_entity_source_organism[0].ncbi_scientific_name`, `rcsb_polymer_entity_container_identifiers.auth_asym_ids`; entry JSON: `struct.title`, `exptl[0].method`, `rcsb_entry_container_identifiers.polymer_entity_ids`.

### 4.6 `ingestion/pipeline.py`
```python
"""THE convergence point of the four ingestion lanes (doc 01 section 3): canonicalize -> SHA-256 ->
DuckDB lookup -> (miss: network/store) -> analysis_history row -> IngestResponse items."""
from __future__ import annotations

import dataclasses
from datetime import timedelta
from pathlib import Path
from typing import Callable, Optional

from ..config import Settings
from ..db import queries as q
from ..db import repo
from ..db.duckdb_store import DuckStore
from ..db.repo import CanonicalRecord, SourceMeta
from ..errors import HSError
from ..events import EventHub
from ..schemas.models import (EvHistoryChanged, HistoryRecord, IngestItem, NcbiIngestRequest, PasteIngestRequest,
                              PdbIngestRequest)
from .ncbi_client import NcbiClient
from .pdb_client import PdbClient, select_entities
from .sanitizer import canonicalize

AnalysisKey = Callable[[], tuple[str, str, str]]   # -> (model_version, core_version, params_hash)
_UNVERSIONED_TTL_DAYS = 30


class Ingestor:
    def __init__(self, store: DuckStore, settings: Settings, ncbi: NcbiClient, pdb: PdbClient, hub: EventHub,
                 analysis_key: AnalysisKey) -> None:
        self.store, self.settings, self.ncbi, self.pdb, self.hub, self.analysis_key = store, settings, ncbi, pdb, hub, analysis_key

    # ------------------------------------------------------------------ shared commit
    async def _commit(self, records: list[tuple[CanonicalRecord, SourceMeta]], forced_status: Optional[str] = None,
                      announce: bool = True) -> list[IngestItem]:
        items: list[IngestItem] = []
        key = self.analysis_key()
        for rec, meta in records:
            res = await self.store.write_tx(lambda c, rec=rec, meta=meta: repo.ingest_one(c, rec, meta, key))
            status = forced_status or ("HIT_SHA" if res["sequence_existed"] else "MISS_STORED")
            items.append(IngestItem(sha256=rec.sha256, cache_status=status, record=HistoryRecord.model_validate(res["record"]),
                                    has_analysis_cache=res["has_analysis_cache"]))
        if items and announce:
            await self.hub.publish(EvHistoryChanged(latest_rev=max(i.record.rev for i in items)))
        return items

    # ------------------------------------------------------------------ lane 3: paste
    async def ingest_paste(self, req: PasteIngestRequest) -> tuple[list[IngestItem], list[str]]:
        recs, warns = canonicalize(req.text, label=req.label, max_bp=self.settings.max_seq_bp)
        return await self._commit([(r, SourceMeta("PASTE")) for r in recs]), warns

    # ------------------------------------------------------------------ lane 4: file (drop or watched folder)
    async def ingest_file(self, filename: str, data: bytes, announce: bool = True) -> tuple[list[IngestItem], list[str]]:
        if len(data) > self.settings.max_upload_mb * 1024 * 1024:
            raise HSError("SEQUENCE_TOO_LONG", f"{filename} exceeds {self.settings.max_upload_mb} MB",
                          {"size": len(data)})
        recs, warns = canonicalize(data.decode("utf-8", errors="replace"), name_hint=Path(filename).stem,
                                   max_bp=self.settings.max_seq_bp)
        return await self._commit([(r, SourceMeta("FILE", accession=filename)) for r in recs], announce=announce), warns

    # ------------------------------------------------------------------ lane 1: NCBI
    async def ingest_ncbi(self, req: NcbiIngestRequest) -> tuple[list[IngestItem], list[str]]:
        key = req.accession.upper()
        warnings: list[str] = []
        row = await self.store.read(lambda c: q.accession_any(c, "NCBI", key))
        if row and not req.force_refresh:
            fresh = row["ttl_expires_at"] is None or row["ttl_expires_at"] > repo.utcnow()
            if not fresh:
                try:                                    # unversioned accession past its TTL: cheap esummary revalidation
                    summ = await self.ncbi.esummary(key)
                    fresh = summ.accessionversion == row["resolved_acc"]
                    if fresh:
                        ttl = repo.utcnow() + timedelta(days=_UNVERSIONED_TTL_DAYS)
                        await self.store.write_tx(lambda c: q.touch_accession(c, "NCBI", key, ttl, repo.utcnow()))
                except HSError as e:
                    if e.code not in ("UPSTREAM_TIMEOUT", "NCBI_RATE_LIMITED"):
                        raise
                    fresh = True                        # offline / throttled: serve the cached copy and say so
                    warnings.append("NCBI unreachable: showing the locally cached copy")
            if fresh:
                return await self._from_cache(row, "NCBI", key), warnings

        summ = await self.ncbi.esummary(key)
        fasta = await self.ncbi.efetch_fasta(key)
        recs, w = canonicalize(fasta, name_hint=summ.accessionversion, max_bp=self.settings.max_seq_bp)
        warnings += w
        rec = recs[0]
        if summ.slen and summ.slen != rec.length:
            warnings.append(f"NCBI reports {summ.slen} bp but the FASTA has {rec.length}")
        versioned = "." in key
        meta = SourceMeta("NCBI", accession=summ.accessionversion, organism=summ.organism,
                          meta_json={"uid": summ.uid, "title": summ.title, "slen": summ.slen,
                                     "accessionversion": summ.accessionversion},
                          accession_key=key, resolved_acc=summ.accessionversion,
                          ttl_days=None if versioned else _UNVERSIONED_TTL_DAYS)
        items = await self._commit([(rec, meta)])
        if summ.accessionversion.upper() != key:        # alias the immutable versioned key too
            await self.store.write_tx(lambda c: q.put_accession(c, "NCBI", summ.accessionversion.upper(), rec.sha256,
                                                                summ.accessionversion, None, repo.utcnow()))
        return items, warnings

    async def _from_cache(self, row: dict, source: str, key: str) -> list[IngestItem]:
        seq = await self.store.read(lambda c: q.get_sequence(c, row["sha256"]))
        src = await self.store.read(lambda c: q.latest_source(c, row["sha256"], source))
        rec = q.to_canonical(seq, src["display_name"] if src else key, src["description"] if src else None)
        meta = SourceMeta(source, accession=row.get("resolved_acc") or key, entity_id=src["entity_id"] if src else None,
                          organism=src["organism"] if src else None)
        return await self._commit([(rec, meta)], forced_status="HIT_ACCESSION")

    # ------------------------------------------------------------------ lane 2: PDB
    async def ingest_pdb(self, req: PdbIngestRequest) -> tuple[list[IngestItem], list[str]]:
        pid = req.pdb_id.upper()
        cache_key = f"{pid}:{req.entity_id}" if req.entity_id else (f"{pid}:*" if not req.all_nucleic_acid else None)
        if cache_key and not req.force_refresh:
            row = await self.store.read(lambda c: q.accession_any(c, "PDB", cache_key))
            if row:
                return await self._from_cache(row, "PDB", cache_key), []

        entry, entities = await self.pdb.entities(pid)
        chosen, warnings = select_entities(entities, req.entity_id, req.all_nucleic_acid, pid)
        title = (entry.get("struct") or {}).get("title")
        method = ((entry.get("exptl") or [{}])[0]).get("method")
        pairs: list[tuple[CanonicalRecord, SourceMeta]] = []
        for e in chosen:
            if not e.sequence:
                raise HSError("PDB_NOT_FOUND", f"PDB {pid} entity {e.entity_id} has no sequence", {"pdb_id": pid})
            recs, w = canonicalize(e.sequence.upper().replace("X", "N"), name_hint=f"{pid}_{e.entity_id}",
                                   max_bp=self.settings.max_seq_bp)
            warnings += w
            rec = dataclasses.replace(recs[0], description=e.description or title)
            pairs.append((rec, SourceMeta("PDB", accession=pid, entity_id=e.entity_id, organism=e.organism,
                                          meta_json={"title": title, "method": method, "chains": e.chains,
                                                     "poly_type": e.poly_type, "description": e.description},
                                          accession_key=f"{pid}:{e.entity_id}")))
        items = await self._commit(pairs)
        if req.entity_id is None and not req.all_nucleic_acid:       # default-selection alias "1BNA:*"
            await self.store.write_tx(lambda c: q.put_accession(c, "PDB", f"{pid}:*", pairs[0][0].sha256, None, None, repo.utcnow()))
        return items, warnings
```
**Cache-status rules (as implemented):** accession hit → `HIT_ACCESSION` with **zero** network calls; network used and the sha already stored → `HIT_SHA`; new sequence → `MISS_STORED`. Every outcome still inserts a new `analysis_history` row (activity log) and bumps `rev`; each commit publishes `history_changed`.

### 4.7 `ingestion/watcher.py`
```python
"""Watched-folder ingestion (doc 01 section 3.5). watchdog threads ONLY enqueue paths onto the asyncio loop;
all file reads, DuckDB writes and WS publishing happen in the event loop / executors."""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Optional

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.polling import PollingObserver

from ..db import queries as q
from ..db import repo
from ..db.duckdb_store import DuckStore
from ..errors import HSError
from ..events import EventHub
from ..schemas.models import EvIngestComplete, EvWatcherStatus
from .pipeline import Ingestor

log = logging.getLogger("helixsight.watcher")
EXTENSIONS = {".fasta", ".fa", ".fna", ".fas", ".txt"}


def _ok(path: str) -> bool:
    p = Path(path)
    return p.suffix.lower() in EXTENSIONS and not p.name.startswith(".") and not p.name.endswith("~")


class _Handler(FileSystemEventHandler):
    def __init__(self, loop: asyncio.AbstractEventLoop, on_path) -> None:
        self.loop, self.on_path = loop, on_path

    def _push(self, path: str) -> None:
        if _ok(path):
            self.loop.call_soon_threadsafe(self.on_path, path)      # the ONLY thing done on the watchdog thread

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._push(os.fsdecode(event.src_path))

    on_modified = on_created

    def on_moved(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._push(os.fsdecode(event.dest_path))


class FolderWatcher:
    def __init__(self, directory: Path, ingestor: Ingestor, store: DuckStore, hub: EventHub, *, polling: bool,
                 debounce: float = 0.5, poll_interval: float = 2.0) -> None:
        self.dir, self.ingestor, self.store, self.hub = directory, ingestor, store, hub
        self.polling, self.debounce, self.poll_interval = polling, debounce, poll_interval
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._pending: set[str] = set()
        self._observer = None
        self._task: Optional[asyncio.Task] = None

    def status(self) -> EvWatcherStatus:
        return EvWatcherStatus(watching=self._observer is not None, path=str(self.dir),
                               mode="polling" if self.polling else "inotify")

    def _on_path(self, path: str) -> None:                          # runs on the loop thread
        if path not in self._pending:
            self._pending.add(path)
            self._queue.put_nowait(path)

    async def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        loop = asyncio.get_running_loop()
        self._observer = PollingObserver(timeout=self.poll_interval) if self.polling else Observer()
        self._observer.schedule(_Handler(loop, self._on_path), str(self.dir), recursive=False)
        self._observer.start()
        self._task = asyncio.create_task(self._consume())
        for p in sorted(self.dir.iterdir()):                        # files that arrived while the server was down
            if p.is_file() and _ok(str(p)):
                self._on_path(str(p))
        await self.hub.publish(self.status())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        if self._observer:
            self._observer.stop()
            await asyncio.to_thread(self._observer.join, 2.0)
            self._observer = None

    async def _consume(self) -> None:
        while True:
            path = await self._queue.get()
            try:
                await self._process(Path(path))
            except asyncio.CancelledError:
                raise
            except Exception:                                       # never let one bad file kill the watcher
                log.exception("watcher failed on %s", path)
            finally:
                self._pending.discard(path)

    async def _stable_stat(self, path: Path) -> Optional[os.stat_result]:
        last = None
        for _ in range(60):                                         # wait until size+mtime stop changing (copy in progress)
            try:
                st = path.stat()
            except FileNotFoundError:
                return None
            if last is not None and (st.st_size, st.st_mtime_ns) == last:
                return st
            last = (st.st_size, st.st_mtime_ns)
            await asyncio.sleep(self.debounce)
        return None

    async def _process(self, path: Path) -> None:
        st = await self._stable_stat(path)
        if st is None or st.st_size == 0:
            return
        prev = await self.store.read(lambda c: q.watch_get(c, str(path)))
        if prev and prev["status"] == "ingested" and prev["size_bytes"] == st.st_size and prev["mtime_ns"] == st.st_mtime_ns:
            return
        data = await asyncio.to_thread(path.read_bytes)
        try:
            items, _ = await self.ingestor.ingest_file(path.name, data)
            status, err = "ingested", None
        except HSError as e:
            items, status, err = [], "failed", e.message
            await self.hub.publish({"type": "server_notice", "level": "warning", "message": f"{path.name}: {e.message}"})
        await self.store.write_tx(lambda c: q.watch_put(c, str(path), st.st_size, st.st_mtime_ns, status, err, repo.utcnow()))
        for item in items:
            await self.hub.publish(EvIngestComplete(item=item))
```
Behavior: `.fasta/.fa/.fna/.fas/.txt` only; hidden and `~` files ignored; a file is processed once its size and mtime are unchanged across two 0.5 s polls (copy-in-progress safe); `(path, size, mtime_ns)` unchanged and previously ingested → skipped; a modified file re-ingests (same letters → `HIT_SHA`); invalid files record `failed` in `watch_files` and emit a `server_notice`; files present at startup are ingested too. On WSL2 `/mnt/*` paths automatically use `PollingObserver` (2 s).

---

## 5. ML GLUE (doc 03 code, as exercised) 

### 5.1 `ml/inference.py` (torch/onnxruntime imported lazily — **supersedes** the top-level `import torch` in doc 03 §5.1)
```python
"""Windowed inference + stitching (doc 03 section 5). torch / onnxruntime are imported lazily so the backend
starts (in degraded mode) on machines without them."""
from __future__ import annotations

from typing import Protocol

import numpy as np


class Runner(Protocol):
    model_version: str
    win: int

    def predict(self, onehot: np.ndarray) -> tuple[np.ndarray, np.ndarray]: ...   # (B,4,win) -> probs (B,4,win), attn (B,win)


class TorchRunner:
    def __init__(self, net, model_version: str, threads: int = 4):
        import torch
        torch.set_num_threads(threads)
        self._torch, self.net, self.model_version, self.win = torch, net.eval(), model_version, 1024

    def predict(self, onehot):
        with self._torch.inference_mode():
            p, a = self.net(self._torch.from_numpy(onehot))
        return p.numpy(), a.numpy()


class OrtRunner:
    def __init__(self, path: str, model_version: str, threads: int = 1):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = threads, 1
        self.sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        self.model_version, self.win = model_version, 1024

    def predict(self, onehot):
        p, a = self.sess.run(["probs", "attn"], {"onehot": onehot})
        return p, a


def onehot_from_codes(codes: np.ndarray) -> np.ndarray:                  # uint8[L] (0..4) -> float32 (4,L); code 4 -> zeros
    L = len(codes)
    oh = np.zeros((4, L), np.float32)
    idx = np.flatnonzero(codes < 4)
    oh[codes[idx], idx] = 1.0
    return oh


def window_starts(L: int, win: int, stride: int) -> list[int]:
    if L <= win:
        return [0]
    s = list(range(0, L - win + 1, stride))
    if s[-1] != L - win:
        s.append(L - win)                                                # final window flush with the end
    return s


def predict_sequence(codes: np.ndarray, runner: Runner, stride: int = 512, batch: int = 16):
    """Returns probs (4,L) float32 and attn (L,) float32 in [0,1]."""
    L, W = len(codes), runner.win
    oh = onehot_from_codes(codes)
    if L < W:
        oh = np.pad(oh, ((0, 0), (0, W - L)))                            # zero-pad (ambiguity-like), cropped below
    Lp = oh.shape[1]
    starts = window_starts(Lp, W, stride)
    wgt = np.hanning(W + 2)[1:-1].astype(np.float32)                     # strictly > 0, tapers edge effects
    acc = np.zeros((4, Lp), np.float32)
    acca = np.zeros(Lp, np.float32)
    wsum = np.zeros(Lp, np.float32)
    for b0 in range(0, len(starts), batch):
        ss = starts[b0:b0 + batch]
        x = np.stack([oh[:, s:s + W] for s in ss]).astype(np.float32)    # (B,4,W)
        p, a = runner.predict(x)
        a = a / (a.max(axis=1, keepdims=True) + 1e-9)                    # per-window normalisation to [0,1]
        for j, s in enumerate(ss):
            acc[:, s:s + W] += p[j] * wgt
            acca[s:s + W] += a[j] * wgt
            wsum[s:s + W] += wgt
    return (acc / wsum)[:, :L], (acca / wsum)[:L]
```

### 5.2 `ml/anomaly.py` (identical to doc 03 §7; shown because the integration tests ran it)
```python
"""Per-scan composition-drift detection on k=4 window frequencies (doc 03 section 7)."""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import IsolationForest


def anomaly_scores(counts: np.ndarray, seed: int = 42):
    n = counts.shape[0]
    if n < 8:                                                             # too few windows for a meaningful baseline
        return np.zeros(n, np.float32), "insufficient_windows"
    tot = counts.sum(axis=1, keepdims=True).clip(min=1)
    X = np.sqrt(counts / tot)                                             # Hellinger transform stabilises frequencies
    forest = IsolationForest(n_estimators=200, max_samples=min(256, n), random_state=seed, n_jobs=1).fit(X)
    raw = -forest.score_samples(X)                                        # higher = more anomalous
    med = np.median(raw)
    mad = np.median(np.abs(raw - med)) * 1.4826 + 1e-9
    z = (raw - med) / mad                                                 # robust z-score
    return z.astype(np.float32), "ok"


def to_position_scores(z_win: np.ndarray, L: int, window: int = 1024, stride: int = 256, z_alert: float = 3.5):
    """Average window z over covering windows; channel value = clip(z / (2*z_alert), 0, 1) so the alert threshold maps to 0.5."""
    diff_s = np.zeros(L + 1, np.float64)
    diff_c = np.zeros(L + 1, np.float64)
    for i, z in enumerate(z_win):
        s = i * stride
        e = min(L, s + window)
        diff_s[s] += z; diff_s[e] -= z; diff_c[s] += 1; diff_c[e] -= 1
    cnt = np.cumsum(diff_c)[:L]
    zs = np.cumsum(diff_s)[:L]
    zpos = np.divide(zs, cnt, out=np.zeros(L), where=cnt > 0)
    return np.clip(zpos / (2 * z_alert), 0, 1).astype(np.float32)


def regions(z_win, L, window=1024, stride=256, z_alert=3.5, min_run=3):
    """Merge runs of >= min_run consecutive windows with z >= z_alert -> [(start,end,peak_z)]."""
    out, run = [], []
    for i, z in enumerate(list(z_win) + [-1e9]):
        if z >= z_alert:
            run.append(i)
        else:
            if len(run) >= min_run:
                out.append((run[0] * stride, min(L, run[-1] * stride + window), float(max(z_win[j] for j in run))))
            run = []
    return out
```
Integration result: a 20 kb sequence at 45 % GC with a 3 kb 75 %-GC insert (8000–11000) produced alerts overlapping the insert, `anomaly_score` above 0.5 inside it and below 0.5 at position 3000.

### 5.3 `ml/anomaly_kind.py` (new: the region labelling doc 03 §7 described in prose)
```python
"""Coarse, heuristic labelling of anomaly regions (doc 03 section 7; research heuristic, C-9)."""
from __future__ import annotations

import numpy as np


def window_entropy_bits(counts_row: np.ndarray) -> float:
    tot = float(counts_row.sum())
    if tot <= 0:
        return 0.0
    p = counts_row[counts_row > 0] / tot
    return float(-(p * np.log2(p)).sum())                                 # max 8 bits for k=4


def region_kind(codes: np.ndarray, counts: np.ndarray, start: int, end: int, *, stride: int, global_gc: float) -> str:
    i0, i1 = start // stride, min(counts.shape[0] - 1, max(start, end - 1) // stride)
    entropy = float(np.mean([window_entropy_bits(counts[i]) for i in range(i0, i1 + 1)]))
    if entropy < 3.0:
        return "low_complexity"
    seg = codes[start:end]
    acgt = int((seg < 4).sum())
    gc = 100.0 * int(((seg == 1) | (seg == 2)).sum()) / acgt if acgt else global_gc
    if abs(gc - global_gc) >= 5.0 and (end - start) >= 1500:
        return "possible_hgt"
    return "composition_shift"
```

### 5.4 `ml/pathogenicity.py` (doc 03 §9 **with a bug fix**: a NaN thermo delta used to turn the whole score into NaN)
```python
"""Heuristic mutation impact (doc 03 section 9). Research heuristic, not clinical (C-9)."""
from __future__ import annotations

import numpy as np

from .inference import onehot_from_codes


def _window(codes, s, W):
    w = codes[s:s + W]
    return np.pad(w, (0, W - len(w)), constant_values=4) if len(w) < W else w


def score_mutation(runner, codes, pos, alt_code, local_thermo, radius=16):
    """local_thermo(codes, pos) -> (tm, dg); may return NaNs when the window holds an ambiguity code."""
    W, L = runner.win, len(codes)
    s = int(np.clip(pos - W // 2, 0, max(0, L - W)))
    c = pos - s                                                            # centre index inside the window
    ref = _window(codes, s, W).copy()
    alt = ref.copy()
    alt[c] = alt_code
    x = np.stack([onehot_from_codes(ref), onehot_from_codes(alt)])         # (2,4,W) - one batched call
    p, _ = runner.predict(x)
    d = p[1] - p[0]                                                        # (4,W) signed deltas
    lo, hi = max(0, c - radius), min(W, c + radius + 1)

    def site_delta(h):
        seg = d[h, lo:hi]
        return float(seg[np.argmax(np.abs(seg))])                          # signed delta at max |delta| within +-radius

    d_prom, d_cpg, d_don, d_acc = site_delta(0), site_delta(1), site_delta(2), site_delta(3)
    d_splice = d_don if abs(d_don) >= abs(d_acc) else d_acc
    tm_r, dg_r = local_thermo(codes, pos)
    codes_alt = codes.copy()
    codes_alt[pos] = alt_code
    tm_a, dg_a = local_thermo(codes_alt, pos)
    d_tm, d_dg = tm_a - tm_r, dg_a - dg_r                                  # ddG > 0 = destabilising
    thermo_term = 0.25 * min(abs(d_dg), 4.0) / 4.0 if np.isfinite(d_dg) else 0.0   # NaN thermo: drop the term
    impact = 1.0 * abs(d_splice) + 0.8 * abs(d_prom) + 0.4 * abs(d_cpg) + thermo_term
    score = float(1.0 - np.exp(-2.0 * impact))                             # in [0,1)
    return dict(delta_tm_c=d_tm, delta_dg_kcal=d_dg, delta_p_promoter=d_prom, delta_p_cpg=d_cpg,
                delta_p_splice=d_splice, pathogenicity=score)
```

### 5.5 `ml/registry.py`
```python
"""Model discovery (doc 03 section 6). A missing/unloadable model is NOT fatal: the bundle has runner=None and the
scan streams native + anomaly channels with ML rows as NaN (MODEL_UNAVAILABLE notice)."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Optional

from ..config import Settings
from .inference import OrtRunner, Runner, TorchRunner

log = logging.getLogger("helixsight.ml")


@dataclass(frozen=True)
class ModelBundle:
    runner: Optional[Runner]
    model_version: str = "none"
    runner_name: str = "none"
    scope: Optional[dict] = None


def load_bundle(settings: Settings) -> ModelBundle:
    meta_path = settings.model_dir / "model.json"
    if not meta_path.exists():
        log.warning("no model.json in %s: ML channels disabled", settings.model_dir)
        return ModelBundle(None)
    try:
        meta = json.loads(meta_path.read_text())
        version = f"{meta['model_id']}+{meta['weights_sha256'][:8]}"
        arts = meta["artifacts"]
        if settings.runner == "ort":
            runner: Runner = OrtRunner(str(settings.model_dir / arts["onnx_fp32"]), version, settings.ort_threads)
            name = "ort-fp32"
        else:
            import torch
            from .models import ExportWrapper, HelixSightNet
            net = HelixSightNet()
            net.load_state_dict(torch.load(settings.model_dir.parent / "checkpoints" / arts["pt"], map_location="cpu")["state_dict"])
            runner, name = TorchRunner(ExportWrapper(net), version, settings.ort_threads), "torch"
        return ModelBundle(runner, version, name, meta.get("scope"))
    except Exception:                                                    # ImportError, missing file, corrupt model ...
        log.exception("model failed to load: ML channels disabled")
        return ModelBundle(None)
```
(The `torch` branch and real ONNX loading were not exercised here; the degraded path and a stub runner were.)

---

## 6. STREAMING ENGINE

### 6.1 `streaming/framing.py`
```python
"""Binary telemetry frames and the channel registry (doc 01 section 7.3). Header = 24 bytes, little-endian, so the
float32 payload starts 4-byte aligned (required by `new Float32Array(buf, 24, n)` in the browser)."""
from __future__ import annotations

import struct
import warnings

import numpy as np

from ..schemas.models import ChannelInfo

HEADER = struct.Struct("<2sBBIIIHHI")          # magic, version, type, stream_seq, start, count, channels, flags, reserved
HEADER_BYTES = HEADER.size
assert HEADER_BYTES == 24
MAGIC, VERSION = b"HS", 1
T_TELEMETRY, T_OVERVIEW = 0x01, 0x02
F_FINAL, F_FROM_CACHE, F_HAS_NAN = 1, 2, 4

CHANNELS: list[ChannelInfo] = [
    ChannelInfo(id=0, name="gc_pct", unit="%", min=0, max=100),
    ChannelInfo(id=1, name="gc_skew", unit="(G-C)/(G+C)", min=-1, max=1),
    ChannelInfo(id=2, name="tm_c", unit="degC", min=0, max=120),
    ChannelInfo(id=3, name="dg_kcal", unit="kcal/mol", min=-60, max=0),
    ChannelInfo(id=4, name="z_propensity", unit="0-1", min=0, max=1),
    ChannelInfo(id=5, name="cgr_x", unit="0-1", min=0, max=1),
    ChannelInfo(id=6, name="cgr_y", unit="0-1", min=0, max=1),
    ChannelInfo(id=7, name="attention", unit="0-1", min=0, max=1),
    ChannelInfo(id=8, name="p_promoter", unit="0-1", min=0, max=1),
    ChannelInfo(id=9, name="p_cpg_island", unit="0-1", min=0, max=1),
    ChannelInfo(id=10, name="p_splice_donor", unit="0-1", min=0, max=1),
    ChannelInfo(id=11, name="p_splice_acceptor", unit="0-1", min=0, max=1),
    ChannelInfo(id=12, name="anomaly_score", unit="0-1", min=0, max=1),
]
CHANNEL_BY_ID = {c.id: c for c in CHANNELS}


def pack_frame(frame_type: int, stream_seq: int, start: int, planes: np.ndarray, flags: int = 0) -> bytes:
    """planes: float32 [C, N], channel-major (planar). For OVERVIEW frames `start` carries the bin size in bp."""
    c, n = planes.shape
    return HEADER.pack(MAGIC, VERSION, frame_type, stream_seq, start, n, c, flags, 0) + \
        np.ascontiguousarray(planes, dtype="<f4").tobytes(order="C")


def unpack_frame(buf: bytes) -> dict:
    magic, ver, ftype, seq, start, count, c, flags, _ = HEADER.unpack_from(buf, 0)
    if magic != MAGIC or ver != VERSION:
        raise ValueError("bad frame header")
    planes = np.frombuffer(buf, dtype="<f4", count=c * count, offset=HEADER_BYTES).reshape(c, count)
    return {"type": ftype, "seq": seq, "start": start, "count": count, "channels": c, "flags": flags, "planes": planes}


def make_overview(planes: np.ndarray, max_bins: int = 4096) -> tuple[np.ndarray, int]:
    """Mean per bin (NaN-aware) -> float32 [C, n_bins], bin size in bp. Channel-at-a-time to bound memory."""
    c, length = planes.shape
    nb = max(1, min(max_bins, length))
    size = -(-length // nb)
    nb = -(-length // size)
    out = np.empty((c, nb), np.float32)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for i in range(c):
            row = planes[i]
            if nb * size != length:
                row = np.concatenate([row, np.full(nb * size - length, np.nan, np.float32)])
            out[i] = np.nanmean(row.reshape(nb, size), axis=1)
    return out, size
```

### 6.2 `streaming/params.py`
```python
"""params / params_hash for the analysis cache key (doc 03 section 12)."""
from __future__ import annotations

import hashlib
import json

from ..core_bridge.native import CoreParams
from ..ml.registry import ModelBundle

ANOMALY = {"kind": "isolation_forest", "n_estimators": 200, "seed": 42, "z_alert": 3.5, "min_run": 3}


def canonical_json(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def build_params(core: CoreParams, bundle: ModelBundle) -> tuple[dict, str]:
    params = {**core.as_dict(), "win_ml": 1024, "stride_ml": 512, "runner": bundle.runner_name,
              "anomaly": {**ANOMALY, "window": core.kmer_window, "stride": core.kmer_stride},
              "mask_ambiguity": True, "channel_registry_version": 1}
    return params, hashlib.sha256(canonical_json(params).encode()).hexdigest()
```
The cache key is `(sha256, model_version, core_version, params_hash)`; with no model installed `model_version="none"` and `runner="none"`, so installing a model later never reuses a no-ML analysis.

### 6.3 `streaming/scheduler.py`
```python
"""Ack-based backpressure: at most `size` unacknowledged binary frames in flight (doc 01 section 7.4)."""
from __future__ import annotations

import asyncio


class SlowClient(Exception):
    """The client stopped acknowledging frames; the server closes the socket with code 4409."""


class AckWindow:
    def __init__(self, size: int = 8, timeout: float = 10.0) -> None:
        self.size, self.timeout = size, timeout
        self._next = 0          # next stream_seq to send
        self._acked = 0         # frames [0, _acked) are acknowledged
        self._cv = asyncio.Condition()

    async def acquire(self) -> int:
        async with self._cv:
            try:
                await asyncio.wait_for(self._cv.wait_for(lambda: self._next - self._acked < self.size), self.timeout)
            except asyncio.TimeoutError as e:
                raise SlowClient() from e
            seq = self._next
            self._next += 1
            return seq

    async def ack(self, stream_seq: int) -> None:
        async with self._cv:
            self._acked = max(self._acked, stream_seq + 1)   # acks are cumulative
            self._cv.notify_all()
```

### 6.4 `streaming/mutations.py`
```python
"""In-silico mutation: shared by WS `mutate` and POST /api/sequences/{sha}/mutations (doc 01 section 4.4)."""
from __future__ import annotations

import asyncio
from typing import Any, Optional

import numpy as np

from ..core_bridge import native
from ..db import queries as q
from ..db import repo
from ..errors import HSError
from ..ml.pathogenicity import score_mutation
from ..schemas.models import Mutation
from ..services import Services

_NAN = float("nan")


async def load_codes(svc: Services, sha256: str) -> np.ndarray:
    codes = svc.codes_cache.get(sha256)
    if codes is None:
        seq = await svc.store.read(lambda c: q.get_sequence(c, sha256))
        if seq is None:
            raise HSError("UNKNOWN_SEQUENCE", f"Unknown sequence {sha256[:8]}", {"sha256": sha256})
        codes = await asyncio.to_thread(native.encode, seq["residues"])
        svc.codes_cache.put(sha256, codes)
    return codes


def mutation_from_row(row: dict[str, Any]) -> Mutation:
    return Mutation.model_validate({**row, "ref": row["ref_base"], "alt": row["alt_base"]})


def _clean(d: dict[str, Any]) -> dict[str, Optional[float]]:
    return {k: (None if v is None or not np.isfinite(v) else float(v)) for k, v in d.items()}


def _score(svc: Services, codes: np.ndarray, pos: int, alt_code: int) -> dict[str, Optional[float]]:
    p = svc.core_params

    def thermo(c: np.ndarray, i: int) -> tuple[float, float]:
        try:
            r = native.local_thermo(c, i, p)
        except native.CoreUnavailableError:
            r = None
        return r if r is not None else (_NAN, _NAN)

    runner = svc.bundle.runner
    if runner is not None:
        return _clean(score_mutation(runner, codes, pos, alt_code, thermo))
    alt = codes.copy()
    alt[pos] = alt_code
    (tm_r, dg_r), (tm_a, dg_a) = thermo(codes, pos), thermo(alt, pos)
    return _clean({"delta_tm_c": tm_a - tm_r, "delta_dg_kcal": dg_a - dg_r, "pathogenicity": None})


async def apply_mutation(svc: Services, *, scan_id: str, position: int, alt: str,
                         sha256: Optional[str] = None) -> Mutation:
    hist = await svc.store.read(lambda c: q.get_history(c, scan_id))
    if hist is None or (sha256 is not None and hist["sha256"] != sha256):
        raise HSError("UNKNOWN_SEQUENCE", f"Unknown scan {scan_id!r} for this sequence", {"scan_id": scan_id})
    codes = await load_codes(svc, hist["sha256"])
    if position >= len(codes):
        raise HSError("PROTOCOL_ERROR", f"position {position} is outside the sequence ({len(codes)} bp)")
    ref = "ACGTN"[int(codes[position])]
    deltas = await asyncio.to_thread(_score, svc, codes, position, "ACGT".index(alt))
    row = await svc.store.write_tx(lambda c: repo.add_mutation(c, scan_id=scan_id, sha256=hist["sha256"], position=position,
                                                              ref=ref, alt=alt, deltas=deltas))
    return mutation_from_row(row)
```
With a model: full deltas + heuristic pathogenicity; without: thermo deltas only and `pathogenicity=None`; ambiguity-window thermo → `None` fields. Mutations are edits on the parent sequence (no derived sequence rows).

### 6.5 `streaming/session.py`
```python
"""ScanSession: one per /ws/scan connection (doc 01 sections 4 and 7). Owns the state machine
CONNECTED -> READY -> ANALYZING -> STREAMING -> COMPLETE, serial sends, ack backpressure and cancellation."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Optional

import numpy as np
from pydantic import BaseModel, TypeAdapter, ValidationError
from starlette.websockets import WebSocket

from ..core_bridge import native
from ..db import queries as q
from ..db import repo
from ..errors import HSError
from ..ids import uuid7
from ..ml.anomaly import anomaly_scores, regions, to_position_scores
from ..ml.anomaly_kind import region_kind
from ..ml.inference import predict_sequence
from ..schemas.models import (CONTRACT_VERSION, ClientMsg, ErrorBody, EvHistoryChanged, ModelScope, WsAck,
                              WsAnomalyAlert, WsCheckpoint, WsError, WsHello, WsHelloAck, WsMutate, WsMutationResult,
                              WsPing, WsPong, WsProgress, WsScanComplete, WsScanReady, WsStartScan, WsStop)
from ..services import Services
from . import framing as fr
from .mutations import apply_mutation, load_codes
from .params import build_params
from .scheduler import AckWindow, SlowClient

log = logging.getLogger("helixsight.session")
_ADAPTER = TypeAdapter(ClientMsg)
IDLE_TIMEOUT_S = 45.0                      # 3 missed 15 s client pings -> close 4408 (doc 01 section 7.4)


class ScanSession:
    CHUNK = 256                            # positions per WS frame

    def __init__(self, ws: WebSocket, svc: Services) -> None:
        self.ws, self.svc, self.id = ws, svc, uuid7()
        self.window = AckWindow()
        self._lock = asyncio.Lock()
        self._scan_task: Optional[asyncio.Task] = None
        self._tasks: set[asyncio.Task] = set()
        self._hello = False

    # ------------------------------------------------------------------ sending
    async def _json(self, msg: BaseModel) -> None:
        async with self._lock:
            await self.ws.send_text(msg.model_dump_json())

    async def _bytes(self, data: bytes) -> None:
        async with self._lock:
            await self.ws.send_bytes(data)

    async def _error(self, code: str, message: str, fatal: bool = False, detail: Optional[dict] = None) -> None:
        await self._json(WsError(error=ErrorBody(code=code, message=message, detail=detail), fatal=fatal))  # type: ignore[arg-type]

    # ------------------------------------------------------------------ receive loop
    async def run(self) -> None:
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(self.ws.receive(), IDLE_TIMEOUT_S)
                except asyncio.TimeoutError:
                    await self.ws.close(code=4408)
                    return
                if msg["type"] == "websocket.disconnect":
                    return
                text = msg.get("text")
                try:
                    if text is None:
                        raise ValueError("binary frames are not accepted from clients")
                    m = _ADAPTER.validate_json(text)
                except (ValidationError, ValueError) as e:
                    await self._error("PROTOCOL_ERROR", f"Invalid message: {str(e)[:200]}", fatal=True)
                    await self.ws.close(code=4400)
                    return
                if not await self._dispatch(m):
                    return
        finally:
            for t in [self._scan_task, *self._tasks]:
                if t and not t.done():
                    t.cancel()

    async def _dispatch(self, m: Any) -> bool:
        if isinstance(m, WsHello):
            if m.contract != CONTRACT_VERSION:
                await self._error("PROTOCOL_ERROR", f"contract {m.contract} != {CONTRACT_VERSION}", fatal=True)
                await self.ws.close(code=4400)
                return False
            self._hello = True
            await self._json(WsHelloAck(session_id=self.id, contract=CONTRACT_VERSION, core_version=native.CORE_VERSION,
                                        model_version=self.svc.bundle.model_version))
            return True
        if not self._hello:
            await self._error("PROTOCOL_ERROR", "send `hello` first", fatal=True)
            await self.ws.close(code=4400)
            return False
        if isinstance(m, WsPing):
            await self._json(WsPong(t=m.t))
        elif isinstance(m, WsAck):
            await self.window.ack(m.stream_seq)
        elif isinstance(m, WsStartScan):
            if self._scan_task and not self._scan_task.done():
                self._scan_task.cancel()
            self._scan_task = asyncio.create_task(self._scan_guard(m))
        elif isinstance(m, WsStop):
            if self._scan_task and not self._scan_task.done():
                self._scan_task.cancel()
        elif isinstance(m, WsCheckpoint):
            self._spawn(self._checkpoint(m))
        elif isinstance(m, WsMutate):
            self._spawn(self._mutate(m))
        return True

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    # ------------------------------------------------------------------ small commands
    async def _checkpoint(self, m: WsCheckpoint) -> None:
        row = await self.svc.store.write_tx(lambda c: repo.checkpoint(c, m.scan_id, m.last_scanned_pos))
        if row is None:
            await self._error("UNKNOWN_SEQUENCE", f"Unknown scan {m.scan_id!r}")
        else:
            await self.svc.hub.publish(EvHistoryChanged(latest_rev=int(row["rev"])))

    async def _mutate(self, m: WsMutate) -> None:
        try:
            mut = await apply_mutation(self.svc, scan_id=m.scan_id, position=m.position, alt=m.alt)
            await self._json(WsMutationResult(request_id=m.request_id, mutation=mut))
            await self.svc.hub.publish(EvHistoryChanged(latest_rev=await self.svc.store.read(_latest_rev)))
        except HSError as e:
            await self._error(e.code, e.message, detail={**(e.detail or {}), "request_id": m.request_id})
        except Exception:
            log.exception("mutate failed")
            await self._error("INTERNAL", "Mutation failed", detail={"request_id": m.request_id})

    # ------------------------------------------------------------------ scanning
    async def _scan_guard(self, m: WsStartScan) -> None:
        try:
            await self._scan(m)
        except asyncio.CancelledError:
            raise
        except HSError as e:
            await self._error(e.code, e.message, detail=e.detail)
        except SlowClient:
            await self.ws.close(code=4409)
        except Exception:
            log.exception("scan failed")
            await self._error("INTERNAL", "Scan failed")

    async def _compute(self, seq: dict, L: int):
        svc, cp = self.svc, self.svc.core_params
        codes = await asyncio.to_thread(native.encode, seq["residues"])
        svc.codes_cache.put(seq["sha256"], codes)
        planes = native.alloc_planes(L)
        counts = None
        try:
            counts = await native.compute_core_channels_async(codes, planes, cp)
        except native.CoreUnavailableError as e:
            await self._error("CORE_UNAVAILABLE", f"{e}; thermodynamic, k-mer and CGR tracks are empty")
        runner = svc.bundle.runner
        if runner is None:
            await self._error("MODEL_UNAVAILABLE", "No model is installed; promoter/CpG/splice/attention tracks are empty")
        else:
            probs, attn = await asyncio.to_thread(predict_sequence, codes, runner)
            planes[7], planes[8:12] = attn, probs
            planes[7:12, codes == 4] = np.nan                                  # ambiguity -> "no data"
        regs: list[dict] = []
        if counts is not None:
            z_win, _ = await asyncio.to_thread(anomaly_scores, counts)
            planes[12] = to_position_scores(z_win, L, cp.kmer_window, cp.kmer_stride)
            for s, e, z in regions(z_win, L, cp.kmer_window, cp.kmer_stride):
                kind = region_kind(codes, counts, s, e, stride=cp.kmer_stride, global_gc=float(seq["gc_pct"]))
                regs.append({"start": s, "end": e, "score": min(1.0, z / 7.0), "kind": kind})   # z_alert 3.5 -> 0.5
        overview, _ = fr.make_overview(planes)
        return planes, regs, overview

    async def _scan(self, m: WsStartScan) -> None:
        t0, svc = time.monotonic(), self.svc
        seq = await svc.store.read(lambda c: q.get_sequence(c, m.sha256))
        if seq is None:
            raise HSError("UNKNOWN_SEQUENCE", f"Unknown sequence {m.sha256[:8]}; ingest it first", {"sha256": m.sha256})
        L = int(seq["length"])
        params, phash = build_params(svc.core_params, svc.bundle)
        key = (svc.bundle.model_version, native.CORE_VERSION, phash)
        meta = None if m.force_recompute else await svc.store.read(lambda c: repo.get_analysis_meta(c, m.sha256, *key))
        self.window = AckWindow()                                              # fresh stream_seq numbering per scan
        cached = meta is not None

        if cached:
            ids = json.loads(meta["channel_ids"])
            regs = json.loads(meta["summary_json"] or "{}").get("regions", [])
            n_ch, aid = int(meta["n_channels"]), meta["analysis_id"]
            overview = await svc.store.read(lambda c: repo.get_overview(c, aid, n_ch))
            blocks = self._db_blocks(aid, int(meta["n_chunks"]), n_ch, meta["codec"])
        else:
            planes, regs, overview = await self._compute(seq, L)
            ids = list(range(native.N_CHANNELS))
            await svc.store.write_tx(lambda c: repo.put_analysis(
                c, sha256=m.sha256, model_version=key[0], core_version=key[1], params_hash=phash, params=params,
                planes=planes, channel_ids=ids, anomaly_count=len(regs), summary={"regions": regs},
                overview=overview, codec=svc.settings.cache_codec))
            await svc.hub.publish(EvHistoryChanged(latest_rev=await svc.store.read(_latest_rev)))
            blocks = self._mem_blocks(planes)

        want = sorted({c for c in m.want if c in ids}) or ids
        rows = [ids.index(c) for c in want]
        scope = ModelScope(**svc.bundle.scope) if svc.bundle.scope else None
        await self._json(WsScanReady(sha256=m.sha256, length=L, channels=[fr.CHANNEL_BY_ID[c] for c in want],
                                     chunk_positions=self.CHUNK, cache="HIT" if cached else "MISS", params_hash=phash,
                                     overview_bins=int(overview.shape[1]) if overview is not None else 0, model_scope=scope))
        flags_base = fr.F_FROM_CACHE if cached else 0
        if overview is not None:
            size = -(-L // overview.shape[1])
            await self._bytes(fr.pack_frame(fr.T_OVERVIEW, await self.window.acquire(), size, overview[rows], flags_base))
        await self._stream(blocks, rows, L, regs, flags_base)
        await self._json(WsScanComplete(anomaly_count=len(regs), duration_ms=int((time.monotonic() - t0) * 1000)))

    async def _mem_blocks(self, planes: np.ndarray) -> AsyncIterator[tuple[int, np.ndarray]]:
        for s in range(0, planes.shape[1], repo.CHUNK_POSITIONS):
            yield s, planes[:, s:s + repo.CHUNK_POSITIONS]

    async def _db_blocks(self, aid: str, n_chunks: int, n_ch: int, codec: str) -> AsyncIterator[tuple[int, np.ndarray]]:
        for ci in range(n_chunks):
            got = await self.svc.store.read(lambda c, ci=ci: repo.get_chunk(c, aid, ci, n_ch, codec))
            if got is None:
                raise HSError("INTERNAL", "analysis cache is incomplete; re-scan with force_recompute")
            yield got

    async def _stream(self, blocks, rows: list[int], L: int, regs: list[dict], flags_base: int) -> None:
        alerts, ai, last_progress = sorted(regs, key=lambda r: r["start"]), 0, 0.0
        async for start, block in blocks:
            sel = block[rows]
            for off in range(0, sel.shape[1], self.CHUNK):
                part = sel[:, off:off + self.CHUNK]
                s = start + off
                e = s + part.shape[1]
                flags = flags_base | (fr.F_FINAL if e >= L else 0) | (fr.F_HAS_NAN if np.isnan(part).any() else 0)
                await self._bytes(fr.pack_frame(fr.T_TELEMETRY, await self.window.acquire(), s, part, flags))
                while ai < len(alerts) and alerts[ai]["start"] < e:           # alert fires as the stream passes its start
                    a = alerts[ai]
                    await self._json(WsAnomalyAlert(start=a["start"], end=a["end"], score=a["score"], kind=a["kind"]))
                    ai += 1
                now = time.monotonic()
                if now - last_progress >= 0.1 or e >= L:
                    last_progress = now
                    await self._json(WsProgress(pos=e, fraction=e / L))


def _latest_rev(cur) -> int:
    return int(cur.execute("SELECT coalesce(max(rev), 0) FROM analysis_history").fetchone()[0])
```

**Per-scan message order (verified by `test_ws.py`):**
```text
 C: hello ──► S: hello_ack{session_id, core_version, model_version}
 C: start_scan{sha256, want?, force_recompute?}
 S: [error MODEL_UNAVAILABLE | CORE_UNAVAILABLE]*            (non-fatal notices, MISS path only)
 S: scan_ready{cache MISS|HIT, channels, chunk_positions 256, params_hash, overview_bins, model_scope?}
 S: BINARY seq 0  OVERVIEW  (start = bin size, count = bins, rows = requested channels)
 S: BINARY seq 1..n TELEMETRY 256 positions each (flags: FROM_CACHE on hits, HAS_NAN, FINAL on the last)
    interleaved: anomaly_alert (when the stream passes region.start), progress (>= 100 ms apart, and at 100 %)
 C: ack{stream_seq} for every binary frame (cumulative; <= 8 unacked frames in flight)
 S: scan_complete{anomaly_count, duration_ms}
 C: mutate{request_id, scan_id, position, alt} ──► S: mutation_result | error{detail.request_id}
 C: checkpoint{scan_id, last_scanned_pos} (no reply; server publishes history_changed on /ws/events)
 C: stop | new start_scan cancels the running scan task; close codes: 4400 protocol, 4403 origin, 4408 idle, 4409 slow client
```
A MISS computes everything first (native kernels in parallel, then inference, then anomaly), commits `put_analysis` in one transaction, **then** streams from memory; a HIT streams `analysis_chunks` (65,536 positions per stored chunk, re-sliced into 256-position frames).

---

## 7. API LAYER

### 7.1 `api/deps.py`
```python
from __future__ import annotations

from fastapi import Request, WebSocket

from ..services import Services


def get_services(request: Request) -> Services:
    return request.app.state.services


def origin_allowed(ws: WebSocket, svc: Services) -> bool:
    """Blocks cross-site WebSocket hijacking: any web page could otherwise open ws://localhost:8000 and read local data.
    Non-browser clients (no Origin header) are allowed; browsers must come from the configured UI origins or same host."""
    origin = ws.headers.get("origin")
    if not origin:
        return True
    host = ws.headers.get("host")
    return origin in svc.settings.cors_list or (host is not None and origin.split("://", 1)[-1] == host)
```

### 7.2 `api/routes_ingest.py`
```python
from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile

from ..errors import HSError
from ..schemas.models import IngestResponse, NcbiIngestRequest, PasteIngestRequest, PdbIngestRequest
from ..services import Services
from .deps import get_services

router = APIRouter(prefix="/api/ingest", tags=["ingest"])


@router.post("/ncbi", response_model=IngestResponse)
async def ingest_ncbi(req: NcbiIngestRequest, svc: Services = Depends(get_services)) -> IngestResponse:
    items, warnings = await svc.ingestor.ingest_ncbi(req)
    return IngestResponse(items=items, warnings=warnings)


@router.post("/pdb", response_model=IngestResponse)
async def ingest_pdb(req: PdbIngestRequest, svc: Services = Depends(get_services)) -> IngestResponse:
    items, warnings = await svc.ingestor.ingest_pdb(req)
    return IngestResponse(items=items, warnings=warnings)


@router.post("/paste", response_model=IngestResponse)
async def ingest_paste(req: PasteIngestRequest, svc: Services = Depends(get_services)) -> IngestResponse:
    items, warnings = await svc.ingestor.ingest_paste(req)
    return IngestResponse(items=items, warnings=warnings)


@router.post("/file", response_model=IngestResponse)
async def ingest_file(files: list[UploadFile] = File(...), svc: Services = Depends(get_services)) -> IngestResponse:
    limit = svc.settings.max_upload_mb * 1024 * 1024
    items, warnings = [], []
    for f in files:
        data = await f.read(limit + 1)                      # never buffer more than limit+1 bytes
        if len(data) > limit:
            raise HSError("SEQUENCE_TOO_LONG", f"{f.filename} exceeds {svc.settings.max_upload_mb} MB")
        got, w = await svc.ingestor.ingest_file(f.filename or "upload.fasta", data)
        items += got
        warnings += [f"{f.filename}: {x}" for x in w]
    return IngestResponse(items=items, warnings=warnings)
```

### 7.3 `api/routes_history.py`
```python
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query, Response

from ..db import queries as q
from ..db import repo
from ..errors import HSError
from ..events import EventHub
from ..schemas.models import (EvHistoryChanged, HistoryPage, HistoryRecord, HistorySyncResponse, Mutation,
                              ProgressRequest, SourceKind)
from ..services import Services
from ..streaming.mutations import mutation_from_row
from .deps import get_services

router = APIRouter(tags=["history"])


async def _changed(hub: EventHub, rev: int) -> None:
    await hub.publish(EvHistoryChanged(latest_rev=rev))


@router.get("/api/history", response_model=HistoryPage)
async def list_history(limit: int = Query(50, ge=1, le=200), cursor: Optional[str] = None,
                       source: Optional[SourceKind] = None, q_: Optional[str] = Query(None, alias="q"),
                       svc: Services = Depends(get_services)) -> HistoryPage:
    before = int(cursor) if cursor and cursor.isdigit() else None
    rows = await svc.store.read(lambda c: repo.history_page(c, limit + 1, before, source, q_))
    more = len(rows) > limit
    items = [HistoryRecord.model_validate(r) for r in rows[:limit]]
    return HistoryPage(items=items, next_cursor=str(items[-1].rev) if more and items else None)


@router.get("/api/history/sync", response_model=HistorySyncResponse)
async def sync_history(since_rev: int = Query(0, ge=0), svc: Services = Depends(get_services)) -> HistorySyncResponse:
    return HistorySyncResponse.model_validate(await svc.store.read(lambda c: repo.history_sync(c, since_rev)))


@router.get("/api/history/{scan_id}", response_model=HistoryRecord)
async def get_history(scan_id: str, svc: Services = Depends(get_services)) -> HistoryRecord:
    row = await svc.store.read(lambda c: q.get_history(c, scan_id))
    if row is None:
        raise HSError("UNKNOWN_SEQUENCE", f"Unknown scan {scan_id!r}")
    return HistoryRecord.model_validate(row)


@router.delete("/api/history/{scan_id}", status_code=204)
async def delete_history(scan_id: str, svc: Services = Depends(get_services)) -> Response:
    await svc.store.write_tx(lambda c: repo.delete_history(c, scan_id))
    rev = await svc.store.read(lambda c: int(c.execute("SELECT coalesce(max(rev),0) FROM analysis_history").fetchone()[0]))
    await _changed(svc.hub, rev)
    return Response(status_code=204)


@router.post("/api/history/{scan_id}/progress", response_model=HistoryRecord)
async def checkpoint(scan_id: str, body: ProgressRequest, svc: Services = Depends(get_services)) -> HistoryRecord:
    row = await svc.store.write_tx(lambda c: repo.checkpoint(c, scan_id, body.last_scanned_pos))
    if row is None:
        raise HSError("UNKNOWN_SEQUENCE", f"Unknown scan {scan_id!r}")
    await _changed(svc.hub, int(row["rev"]))
    return HistoryRecord.model_validate(row)


@router.get("/api/history/{scan_id}/mutations", response_model=list[Mutation])
async def list_mutations(scan_id: str, svc: Services = Depends(get_services)) -> list[Mutation]:
    rows = await svc.store.read(lambda c: repo.list_mutations(c, scan_id))
    return [mutation_from_row(r) for r in rows]


@router.delete("/api/mutations/{mutation_id}", status_code=204)
async def delete_mutation(mutation_id: str, svc: Services = Depends(get_services)) -> Response:
    ok = await svc.store.write_tx(lambda c: repo.delete_mutation(c, mutation_id))
    if not ok:
        raise HSError("UNKNOWN_SEQUENCE", f"Unknown mutation {mutation_id!r}")
    return Response(status_code=204)
```
Route order matters: `/api/history/sync` is declared before `/api/history/{scan_id}`. Paging cursor = the `rev` of the last returned item (`rev < cursor`, newest first).

### 7.4 `api/routes_analysis.py`
```python
from __future__ import annotations

import json
from typing import Iterator, Optional

import numpy as np
from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import StreamingResponse

from ..core_bridge import native
from ..db import queries as q
from ..db import repo
from ..errors import HSError
from ..schemas.models import AnalysisMeta, Health, Mutation, MutationRequest, SequencePayload
from ..services import Services
from ..streaming.mutations import apply_mutation, load_codes
from .deps import get_services

router = APIRouter(tags=["analysis"])


@router.get("/api/sequences/{sha256}")
async def get_sequence(sha256: str, format: str = Query("json", pattern="^(json|u8)$"),
                       svc: Services = Depends(get_services)):
    row = await svc.store.read(lambda c: q.get_sequence(c, sha256))
    if row is None:
        raise HSError("UNKNOWN_SEQUENCE", f"Unknown sequence {sha256[:8]}", {"sha256": sha256})
    if format == "u8":                                       # new-device hydration: 1 byte/base, codes A0 C1 G2 T3 N4
        codes = await load_codes(svc, sha256)
        return Response(codes.tobytes(), media_type="application/octet-stream",
                        headers={"X-HS-Length": str(len(codes)), "X-HS-Molecule": row["molecule"]})
    return SequencePayload(sha256=sha256, molecule=row["molecule"], length=int(row["length"]), residues=row["residues"])


async def _meta(svc: Services, sha256: str, params_hash: Optional[str]):
    key = (svc.bundle.model_version, native.CORE_VERSION, params_hash or svc.params_hash)
    meta = await svc.store.read(lambda c: repo.get_analysis_meta(c, sha256, *key))
    if meta is None:
        raise HSError("UNKNOWN_SEQUENCE", "No cached analysis for this sequence and configuration", {"sha256": sha256})
    return meta, key


@router.get("/api/analysis/{sha256}/meta", response_model=AnalysisMeta)
async def analysis_meta(sha256: str, params_hash: Optional[str] = None, svc: Services = Depends(get_services)) -> AnalysisMeta:
    meta, key = await _meta(svc, sha256, params_hash)
    regions = json.loads(meta["summary_json"] or "{}").get("regions", [])
    return AnalysisMeta(analysis_id=meta["analysis_id"], sha256=sha256, length=int(meta["length"]),
                        channel_ids=json.loads(meta["channel_ids"]), params_hash=key[2], model_version=key[0],
                        core_version=key[1], anomaly_count=int(meta["anomaly_count"]), regions=regions,
                        overview_bins=int(meta["overview_bins"]))


@router.get("/api/analysis/{sha256}")
async def analysis_tensor(sha256: str, params_hash: Optional[str] = None, svc: Services = Depends(get_services)):
    """Planar float32 [n_channels x length] (little-endian) - exactly the IndexedDB `tensors` layout."""
    meta, key = await _meta(svc, sha256, params_hash)
    n_ch, length = int(meta["n_channels"]), int(meta["length"])
    full = np.empty((n_ch, length), dtype="<f4")
    for ci in range(int(meta["n_chunks"])):
        got = await svc.store.read(lambda c, ci=ci: repo.get_chunk(c, meta["analysis_id"], ci, n_ch, meta["codec"]))
        if got is None:
            raise HSError("INTERNAL", "analysis cache is incomplete")
        start, arr = got
        full[:, start:start + arr.shape[1]] = arr

    def body() -> Iterator[bytes]:
        for row in full:
            mv = memoryview(row).cast("B")
            for off in range(0, len(mv), 1 << 20):
                yield bytes(mv[off:off + (1 << 20)])

    return StreamingResponse(body(), media_type="application/octet-stream",
                             headers={"X-HS-Channels": meta["channel_ids"], "X-HS-Length": str(length),
                                      "X-HS-Params-Hash": key[2], "Content-Length": str(full.nbytes)})


@router.post("/api/sequences/{sha256}/mutations", response_model=Mutation)
async def create_mutation(sha256: str, body: MutationRequest, svc: Services = Depends(get_services)) -> Mutation:
    return await apply_mutation(svc, scan_id=body.scan_id, position=body.position, alt=body.alt, sha256=sha256)


@router.get("/api/health", response_model=Health)
async def health(deep: bool = False, svc: Services = Depends(get_services)) -> Health:
    ok = native.CORE_AVAILABLE and svc.bundle.runner is not None
    integrity = await svc.store.read(repo.verify_integrity) if deep else None
    return Health(status="ok" if ok else "degraded", core_version=native.CORE_VERSION, core_available=native.CORE_AVAILABLE,
                  model_version=svc.bundle.model_version, model_available=svc.bundle.runner is not None,
                  watcher=svc.watcher.status().model_dump(mode="json") if svc.watcher else None, integrity=integrity)
```
`GET /api/analysis/{sha}` reassembles chunks into the full `[C × L]` tensor in memory (≈ 260 MB at 5 Mbp) and streams it row by row in 1 MiB pieces; it is the new-device hydration path, not the streaming path.

### 7.5 `api/ws_scan.py` and `api/ws_events.py`
```python
from __future__ import annotations

from fastapi import APIRouter, WebSocket

from ..streaming.session import ScanSession
from .deps import origin_allowed

router = APIRouter()


@router.websocket("/ws/scan")
async def ws_scan(ws: WebSocket) -> None:
    svc = ws.app.state.services
    if not origin_allowed(ws, svc):
        await ws.close(code=4403)                            # before accept -> HTTP 403 on the handshake
        return
    await ws.accept()
    await ScanSession(ws, svc).run()
```
```python
from __future__ import annotations

import asyncio

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from .deps import origin_allowed

router = APIRouter()


@router.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    svc = ws.app.state.services
    if not origin_allowed(ws, svc):
        await ws.close(code=4403)
        return
    await ws.accept()
    q = svc.hub.subscribe()
    try:
        if svc.watcher:
            await ws.send_text(svc.watcher.status().model_dump_json())

        async def drain_client() -> None:                    # detect disconnects; clients send nothing meaningful
            while True:
                await ws.receive_text()

        reader = asyncio.create_task(drain_client())
        try:
            while not reader.done():
                try:
                    await ws.send_json(await asyncio.wait_for(q.get(), 1.0))
                except asyncio.TimeoutError:
                    continue
        finally:
            reader.cancel()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        svc.hub.unsubscribe(q)
```

### 7.6 `main.py`
```python
"""FastAPI application factory + lifespan (doc 00 section 5). Dependency injection hooks (`http_transport`, `bundle`)
exist so tests run with recorded HTTP responses and a stub model, and so degraded modes are testable."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from .api import routes_analysis, routes_history, routes_ingest, ws_events, ws_scan
from .config import Settings
from .core_bridge import native
from .db import repo
from .db.duckdb_store import DuckStore
from .errors import install_error_handlers
from .events import EventHub
from .ingestion.ncbi_client import NcbiClient
from .ingestion.pdb_client import PdbClient
from .ingestion.pipeline import Ingestor
from .ingestion.watcher import FolderWatcher
from .ml.registry import ModelBundle, load_bundle
from .services import Services
from .streaming.params import build_params

log = logging.getLogger("helixsight")


class IsolationHeaders(BaseHTTPMiddleware):
    """COOP/COEP: cross-origin isolation for multi-threaded WASM (onnxruntime-web) in single-process mode."""

    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        return resp


def create_app(settings: Optional[Settings] = None, *, http_transport: Optional[httpx.AsyncBaseTransport] = None,
               bundle: Optional[ModelBundle] = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.basicConfig(level=settings.log_level.upper())
        store = DuckStore(str(settings.db_path), settings.duckdb_memory_limit)
        store.open()
        http = httpx.AsyncClient(transport=http_transport, timeout=30.0, follow_redirects=True,
                                 headers={"User-Agent": f"HelixSight/0.1 ({settings.ncbi_email or 'local'})"})
        mb = bundle or load_bundle(settings)
        core = native.CoreParams()
        _, phash = build_params(core, mb)
        hub = EventHub()
        ncbi = NcbiClient(http, tool=settings.ncbi_tool, email=settings.ncbi_email, api_key=settings.ncbi_api_key)
        pdb = PdbClient(http)
        ingestor = Ingestor(store, settings, ncbi, pdb, hub, lambda: (mb.model_version, native.CORE_VERSION, phash))
        svc = Services(settings, store, http, ncbi, pdb, hub, ingestor, mb, core, phash)
        if settings.watch_enabled:
            svc.watcher = FolderWatcher(settings.watch_dir, ingestor, store, hub, polling=settings.watch_uses_polling)
            await svc.watcher.start()
        app.state.services = svc
        bad = {k: v for k, v in (await store.read(repo.verify_integrity)).items() if v}
        if bad:
            log.warning("database integrity audit found issues: %s", bad)
        log.info("HelixSight ready: core=%s model=%s", native.CORE_VERSION, mb.model_version)
        try:
            yield
        finally:
            if svc.watcher:
                await svc.watcher.stop()
            await http.aclose()
            store.close()

    app = FastAPI(title="HelixSight AI", version="0.1.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_list, allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["X-HS-Channels", "X-HS-Length", "X-HS-Params-Hash"])
    install_error_handlers(app)
    for r in (routes_ingest.router, routes_history.router, routes_analysis.router, ws_scan.router, ws_events.router):
        app.include_router(r)
    dist = Path("frontend/dist")
    if settings.serve_static and dist.exists():
        app.add_middleware(IsolationHeaders)
        app.mount("/", StaticFiles(directory=dist, html=True), name="ui")        # mounted last so /api and /ws win
    return app
```
Run with `uv run uvicorn helixsight.main:create_app --factory --host 127.0.0.1 --port 8000 --reload` (doc 05 §3.5). Startup order: DuckDB open + migrations → HTTP client → model bundle → services → watcher → integrity audit (warning only).

### 7.7 REST surface (final)

| Method & path | Body → response | Notes |
|---|---|---|
| `POST /api/ingest/{ncbi,pdb,paste}` | request model → `IngestResponse` | errors per §3.2 |
| `POST /api/ingest/file` | multipart `files[]` → `IngestResponse` | ≤ `max_upload_mb` each |
| `GET /api/history` | `limit, cursor, source, q` → `HistoryPage` | newest first |
| `GET /api/history/sync` | `since_rev` → `HistorySyncResponse` | upserts + tombstones |
| `GET/DELETE /api/history/{scan_id}` | → `HistoryRecord` / 204 | |
| `POST /api/history/{scan_id}/progress` | `{last_scanned_pos}` → `HistoryRecord` | |
| `GET /api/history/{scan_id}/mutations` | → `Mutation[]` | |
| `DELETE /api/mutations/{mutation_id}` | → 204 / 404 | bumps history `rev` |
| `GET /api/sequences/{sha}` | `?format=json\|u8` → `SequencePayload` / octets | |
| `POST /api/sequences/{sha}/mutations` | `MutationRequest` → `Mutation` | REST twin of WS `mutate` |
| `GET /api/analysis/{sha}/meta` | `?params_hash` → `AnalysisMeta` | |
| `GET /api/analysis/{sha}` | → planar float32 `[C×L]` + `X-HS-*` headers | |
| `GET /api/health` | `?deep=1` → `Health` (+ integrity audit) | |
| `WS /ws/scan` · `WS /ws/events` | §6.5 · `watcher_status`, `history_changed`, `ingest_complete`, `server_notice` | origin-checked |

---

## 8. TESTS (all executed; 19 passed)

### 8.1 `tests/conftest.py`
```python
import json
import sys
from pathlib import Path

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helixsight.config import Settings
from helixsight.ingestion.http_util import RateLimiter
from helixsight.main import create_app
from helixsight.ml.registry import ModelBundle


def make_seq(n: int, gc: float, seed: int) -> str:
    rng = np.random.default_rng(seed)
    p = [(1 - gc) / 2, gc / 2, gc / 2, (1 - gc) / 2]
    return "".join(rng.choice(list("ACGT"), size=n, p=p))


NCBI_SEQ = make_seq(3000, 0.45, 1)
NCBI_SEQ2 = make_seq(2000, 0.5, 2)
WRAP = lambda s: "\n".join(s[i:i + 70] for i in range(0, len(s), 70))  # noqa: E731


def fake_network(calls: list, state: dict):
    known = {"NM_000001": ("NM_000001.2", NCBI_SEQ), "NM_000001.2": ("NM_000001.2", NCBI_SEQ),
             "NM_000002": ("NM_000002.1", NCBI_SEQ2), "NM_000003": ("NM_000003.1", NCBI_SEQ2)}
    pdb_entities = {
        "1BNA": {"1": ("polydeoxyribonucleotide", "CGCGAATTCGCG", "DNA (5'-D(*CP*GP*CP*G)-3')")},
        "2MIX": {"1": ("polypeptide(L)", "MKVL", "A protein"), "2": ("polydeoxyribonucleotide", "ACGTACGTAC", "A DNA")},
        "3PRO": {"1": ("polypeptide(L)", "MKVL", "Only protein")},
    }

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        path, params = req.url.path, dict(req.url.params)
        if "eutils" in str(req.url):
            acc = params.get("id", "")
            if acc == "NM_000003":
                return httpx.Response(429, headers={"Retry-After": "0"})
            if acc == "NM_000002" and state.setdefault("flaky", 0) < 2:
                state["flaky"] += 1
                return httpx.Response(429, headers={"Retry-After": "0"})
            if path.endswith("esummary.fcgi"):
                if acc not in known:
                    return httpx.Response(200, json={"result": {"uids": []}})
                ver, s = known[acc]
                return httpx.Response(200, json={"result": {"uids": ["77"], "77": {
                    "uid": "77", "accessionversion": ver, "title": "Test gene", "organism": "Homo sapiens", "slen": len(s)}}})
            if acc not in known:
                return httpx.Response(200, text="Error: no such id")
            ver, s = known[acc]
            return httpx.Response(200, text=f">{ver} Homo sapiens test gene\n{WRAP(s)}\n")
        if "/core/entry/" in path:
            pid = path.rsplit("/", 1)[-1]
            if pid not in pdb_entities:
                return httpx.Response(404)
            return httpx.Response(200, json={"struct": {"title": "Test entry"}, "exptl": [{"method": "X-RAY DIFFRACTION"}],
                                             "rcsb_entry_container_identifiers": {"polymer_entity_ids": list(pdb_entities[pid])}})
        if "/core/polymer_entity/" in path:
            _, pid, eid = path.rsplit("/", 2)
            typ, seq, desc = pdb_entities[pid][eid]
            return httpx.Response(200, json={"entity_poly": {"type": typ, "pdbx_seq_one_letter_code_can": seq},
                                             "rcsb_polymer_entity": {"pdbx_description": desc},
                                             "rcsb_entity_source_organism": [{"ncbi_scientific_name": "synthetic construct"}],
                                             "rcsb_polymer_entity_container_identifiers": {"auth_asym_ids": ["A", "B"]}})
        return httpx.Response(404)

    return handler


class StubRunner:
    """Deterministic stand-in for the CNN+BiLSTM: promoter rises with G, attention is flat."""
    model_version, win = "stub+0001", 1024

    def predict(self, x):
        probs = np.full((x.shape[0], 4, 1024), 0.1, np.float32)
        probs[:, 0] = 0.1 + 0.6 * x[:, 2]
        probs[:, 1] = 0.1 + 0.5 * x[:, 1]
        return probs, np.full((x.shape[0], 1024), 1.0 / 1024, np.float32)


STUB = ModelBundle(StubRunner(), "stub+0001", "stub", {"trained_on": "stub", "warning": "test model"})


def build_client(tmp_path, *, bundle=STUB, watch=False, calls=None, state=None):
    calls = calls if calls is not None else []
    s = Settings(_env_file=None, db_path=Path(":memory:"), watch_enabled=watch, watch_dir=tmp_path / "watch",
                 model_dir=tmp_path / "no-model", cors_origins="http://localhost:5173")
    app = create_app(s, http_transport=httpx.MockTransport(fake_network(calls, state if state is not None else {})), bundle=bundle)
    return TestClient(app, base_url="http://localhost:8000")


@pytest.fixture
def calls():
    return []


@pytest.fixture
def client(tmp_path, calls):
    with build_client(tmp_path, calls=calls) as c:
        svc = c.app.state.services                       # make retries instant in tests
        svc.ncbi.limiter, svc.ncbi.backoff = RateLimiter(10_000), 0.0
        svc.pdb.limiter, svc.pdb.backoff = RateLimiter(10_000), 0.0
        yield c


def ws_recv(ws):
    m = ws.receive()
    if m["type"] == "websocket.close":
        return "close", m.get("code")
    return ("b", m["bytes"]) if m.get("bytes") is not None else ("t", json.loads(m["text"]))
```
Add `pytest-asyncio` is not required by these tests (they use the sync `TestClient`); the root `pyproject.toml` `testpaths = ["backend/tests"]` picks them up.

### 8.2 `tests/test_sanitizer.py`
```python
import pytest

from helixsight.errors import HSError
from helixsight.ingestion.hasher import sha256_canonical
from helixsight.ingestion.sanitizer import canonicalize


def one(text, **kw):
    recs, warns = canonicalize(text, **kw)
    assert len(recs) == 1
    return recs[0], warns


def test_raw_lowercase_numbers_and_whitespace():
    rec, _ = one("  1 atgcatgc 9 ttgacc\n 21 gg*\r\n")
    assert rec.residues == "ATGCATGCTTGACCGG" and rec.length == 16 and rec.molecule == "DNA"
    assert rec.display_name == f"pasted-{rec.sha256[:8]}" and rec.sha256 == sha256_canonical(rec.residues)


def test_fasta_header_label_and_rna():
    rec, _ = one(">NM_1.2 Homo sapiens gene\nAUGCAUGC\n")
    assert (rec.display_name, rec.description, rec.molecule, rec.residues) == ("NM_1.2", "Homo sapiens gene", "RNA", "ATGCATGC")
    rec2, _ = one(">x desc\nACGT\n", label="mine")
    assert rec2.display_name == "mine"


def test_multi_fasta_empty_record_warning_and_label_prefix():
    recs, warns = canonicalize(">a\nACGT\n>empty\n>b\nTTGG\n", label="L")
    assert [r.display_name for r in recs] == ["L:a", "L:b"] and len(warns) == 1 and "empty" in warns[0]


def test_iupac_counts_gc_and_same_sha_across_sources():
    rec, _ = one("GGCCNNAATT")
    assert (rec.g, rec.c, rec.ambiguous, round(rec.gc_pct, 6)) == (2, 2, 2, 50.0)
    assert one(">whatever\nggcc nnaatt")[0].sha256 == rec.sha256          # identity ignores source/format


def test_invalid_char_reports_cleaned_and_raw_offsets():
    text = ">h\nAC GT\n 5 AZGT\n"
    with pytest.raises(HSError) as e:
        canonicalize(text)
    assert e.value.code == "INVALID_IUPAC" and e.value.detail["offset"] == 5 and e.value.detail["char"] == "Z"
    assert text[e.value.detail["raw_offset"]] == "Z"


def test_mixed_u_and_t_is_invalid_and_limits():
    with pytest.raises(HSError) as e:
        canonicalize("ACGU ACGT")
    assert e.value.code == "INVALID_IUPAC" and e.value.detail["char"] == "U"
    with pytest.raises(HSError) as e:
        canonicalize("ACGT" * 10, max_bp=20)
    assert e.value.code == "SEQUENCE_TOO_LONG" and e.value.status == 413
    for blank in ("", "   \n 12 34 \n", ">only header\n"):
        with pytest.raises(HSError) as e:
            canonicalize(blank)
        assert e.value.code == "EMPTY_SEQUENCE"
```

### 8.3 `tests/test_api.py`
```python
import json

import numpy as np
import pytest

from conftest import NCBI_SEQ, make_seq


def paste(client, text, label=None):
    return client.post("/api/ingest/paste", json={"text": text, "label": label})


def test_paste_dedup_history_and_errors(client):
    seq = make_seq(500, 0.5, 5)
    r1 = paste(client, f">demo\n{seq}\n").json()
    r2 = paste(client, seq.lower()).json()
    assert [r1["items"][0]["cache_status"], r2["items"][0]["cache_status"]] == ["MISS_STORED", "HIT_SHA"]
    assert r1["items"][0]["sha256"] == r2["items"][0]["sha256"] and r1["items"][0]["record"]["created_at"].endswith("Z")
    assert r1["items"][0]["record"]["source"] == "PASTE" and r1["items"][0]["record"]["length"] == 500

    sync = client.get("/api/history/sync", params={"since_rev": 0}).json()
    assert len(sync["upserts"]) == 2 and sync["latest_rev"] == max(u["rev"] for u in sync["upserts"])
    assert client.get("/api/history/sync", params={"since_rev": sync["latest_rev"]}).json()["upserts"] == []

    bad = paste(client, "ACGT ACZT")
    assert bad.status_code == 422 and bad.json()["code"] == "INVALID_IUPAC" and bad.json()["detail"]["char"] == "Z"
    assert paste(client, ">only a header").json()["code"] == "EMPTY_SEQUENCE"
    v = client.post("/api/ingest/ncbi", json={"accession": "!!"})
    assert v.status_code == 422 and v.json()["code"] == "INVALID_ACCESSION"
    assert client.post("/api/ingest/paste", json={"text": "ACGT", "bogus": 1}).json()["code"] == "PROTOCOL_ERROR"


def test_ncbi_cache_flow_and_errors(client, calls):
    r = client.post("/api/ingest/ncbi", json={"accession": "nm_000001"})
    item = r.json()["items"][0]
    assert r.status_code == 200 and item["cache_status"] == "MISS_STORED"
    assert item["record"]["accession"] == "NM_000001.2" and item["record"]["organism"] == "Homo sapiens"
    assert item["record"]["display_name"] == "NM_000001.2" and len(calls) == 2            # esummary + efetch
    again = client.post("/api/ingest/ncbi", json={"accession": "NM_000001"}).json()["items"][0]
    assert again["cache_status"] == "HIT_ACCESSION" and len(calls) == 2                   # zero network
    alias = client.post("/api/ingest/ncbi", json={"accession": "NM_000001.2"}).json()["items"][0]
    assert alias["cache_status"] == "HIT_ACCESSION" and len(calls) == 2                   # versioned alias indexed
    assert paste(client, NCBI_SEQ).json()["items"][0]["cache_status"] == "HIT_SHA"        # identity ignores source
    forced = client.post("/api/ingest/ncbi", json={"accession": "NM_000001", "force_refresh": True}).json()["items"][0]
    assert forced["cache_status"] == "HIT_SHA" and len(calls) == 4

    nf = client.post("/api/ingest/ncbi", json={"accession": "NM_999999"})
    assert nf.status_code == 404 and nf.json()["code"] == "NCBI_NOT_FOUND"
    flaky = client.post("/api/ingest/ncbi", json={"accession": "NM_000002"})              # 429, 429, then success
    assert flaky.status_code == 200
    rl = client.post("/api/ingest/ncbi", json={"accession": "NM_000003"})                 # always 429
    assert rl.status_code == 503 and rl.json()["code"] == "NCBI_RATE_LIMITED" and "retry-after" in rl.headers


def test_ncbi_offline_serves_expired_cache(client, calls):
    from helixsight.db import repo
    svc = client.app.state.services
    client.post("/api/ingest/ncbi", json={"accession": "NM_000001"})
    past = repo.utcnow().replace(year=2000)
    svc.store._con.cursor().execute("UPDATE accession_index SET ttl_expires_at = ? WHERE accession_key = 'NM_000001'", [past])
    svc.ncbi.retries = 1
    svc.http._transport = type("Down", (), {"handle_async_request": staticmethod(_raise_timeout),
                                            "aclose": staticmethod(_noop)})()                       # network down
    r = client.post("/api/ingest/ncbi", json={"accession": "NM_000001"}).json()
    assert r["items"][0]["cache_status"] == "HIT_ACCESSION" and "locally cached" in r["warnings"][0]


async def _noop():
    return None


async def _raise_timeout(request):
    import httpx
    raise httpx.ConnectTimeout("down")


def test_pdb_lane(client, calls):
    r = client.post("/api/ingest/pdb", json={"pdb_id": "1bna"}).json()
    it = r["items"][0]
    assert it["cache_status"] == "MISS_STORED" and it["record"]["length"] == 12 and it["record"]["accession"] == "1BNA"
    n = len(calls)
    assert client.post("/api/ingest/pdb", json={"pdb_id": "1BNA"}).json()["items"][0]["cache_status"] == "HIT_ACCESSION"
    assert len(calls) == n
    mix = client.post("/api/ingest/pdb", json={"pdb_id": "2MIX"}).json()
    assert mix["items"][0]["record"]["length"] == 10 and "entity 1 skipped" in mix["warnings"][0]
    prot = client.post("/api/ingest/pdb", json={"pdb_id": "3PRO"})
    assert prot.status_code == 422 and prot.json()["code"] == "PDB_NO_NUCLEIC_ACID"
    assert prot.json()["detail"]["entities"][0]["type"] == "polypeptide(L)"
    assert client.post("/api/ingest/pdb", json={"pdb_id": "9ZZZ"}).json()["code"] == "PDB_NOT_FOUND"
    assert client.post("/api/ingest/pdb", json={"pdb_id": "2MIX", "entity_id": 1}).json()["code"] == "PDB_NO_NUCLEIC_ACID"


def test_file_upload_history_paging_delete_and_mutations(client):
    files = [("files", ("a.fasta", f">ga\n{make_seq(300, .5, 7)}\n", "text/plain")),
             ("files", ("plain.txt", make_seq(200, .4, 8), "text/plain"))]
    r = client.post("/api/ingest/file", files=files).json()
    assert [i["record"]["display_name"] for i in r["items"]] == ["ga", "plain"] and r["items"][0]["record"]["source"] == "FILE"
    page = client.get("/api/history", params={"limit": 1}).json()
    assert len(page["items"]) == 1 and page["next_cursor"]
    page2 = client.get("/api/history", params={"limit": 5, "cursor": page["next_cursor"]}).json()
    assert len(page2["items"]) == 1 and page2["next_cursor"] is None
    assert len(client.get("/api/history", params={"q": "plain"}).json()["items"]) == 1
    assert client.get("/api/history", params={"source": "PDB"}).json()["items"] == []

    rec = r["items"][0]["record"]
    sha = rec["sha256"]
    seqj = client.get(f"/api/sequences/{sha}").json()
    assert seqj["length"] == 300
    u8 = client.get(f"/api/sequences/{sha}", params={"format": "u8"})
    assert len(u8.content) == 300 and set(np.frombuffer(u8.content, np.uint8)) <= {0, 1, 2, 3}
    assert client.get("/api/sequences/" + "0" * 64).status_code == 404

    cp = client.post(f"/api/history/{rec['scan_id']}/progress", json={"last_scanned_pos": 123}).json()
    assert cp["last_scanned_pos"] == 123
    m = client.post(f"/api/sequences/{sha}/mutations", json={"request_id": "r1", "scan_id": rec["scan_id"], "position": 10, "alt": "G"})
    mj = m.json()
    assert m.status_code == 200 and mj["alt"] == "G" and mj["ref"] in "ACGT" and mj["delta_dg_kcal"] is not None
    assert 0 <= mj["pathogenicity"] < 1 and mj["delta_p_promoter"] is not None
    assert client.get(f"/api/history/{rec['scan_id']}").json()["mutation_count"] == 1
    assert len(client.get(f"/api/history/{rec['scan_id']}/mutations").json()) == 1
    bad = client.post(f"/api/sequences/{sha}/mutations", json={"request_id": "r", "scan_id": rec["scan_id"], "position": 9999, "alt": "A"})
    assert bad.status_code == 400 and bad.json()["code"] == "PROTOCOL_ERROR"
    assert client.delete(f"/api/mutations/{mj['mutation_id']}").status_code == 204
    assert client.delete(f"/api/mutations/{mj['mutation_id']}").status_code == 404

    since = client.get("/api/history/sync", params={"since_rev": 0}).json()["latest_rev"]
    assert client.delete(f"/api/history/{rec['scan_id']}").status_code == 204
    sync = client.get("/api/history/sync", params={"since_rev": since}).json()
    assert sync["deleted"] == [rec["scan_id"]] and client.get(f"/api/history/{rec['scan_id']}").status_code == 404
    assert client.get("/api/health", params={"deep": True}).json()["integrity"] == {k: 0 for k in client.get("/api/health", params={"deep": True}).json()["integrity"]}


def test_health_reports_degraded_without_model(tmp_path):
    from conftest import build_client
    from helixsight.ml.registry import ModelBundle
    with build_client(tmp_path, bundle=ModelBundle(None)) as c:
        h = c.get("/api/health").json()
        assert h["status"] == "degraded" and h["model_available"] is False and h["core_available"] is True
```

### 8.4 `tests/test_ws.py`
```python
import asyncio

import numpy as np
import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import build_client, make_seq, ws_recv
from helixsight.ml.registry import ModelBundle
from helixsight.streaming import framing as fr
from helixsight.streaming.scheduler import AckWindow, SlowClient


def synthetic() -> str:
    """20 kb at 45% GC with a 3 kb 75%-GC insert at 8000-11000 (the doc 03 anomaly test)."""
    return make_seq(8000, .45, 11) + make_seq(3000, .75, 12) + make_seq(9000, .45, 13)


def ingest(client, text):
    return client.post("/api/ingest/paste", json={"text": text}).json()["items"][0]


def run_scan(ws, sha, **kw):
    ws.send_json({"type": "start_scan", "sha256": sha, **kw})
    out = {"json": [], "frames": []}
    while True:
        kind, m = ws_recv(ws)
        assert kind != "close", m
        if kind == "b":
            f = fr.unpack_frame(m)
            out["frames"].append(f)
            ws.send_json({"type": "ack", "stream_seq": f["seq"]})
        else:
            out["json"].append(m)
            if m["type"] in ("scan_complete", "error") and m.get("fatal", True):
                if m["type"] == "scan_complete" or m["error"]["code"] == "UNKNOWN_SEQUENCE":
                    return out


def hello(ws):
    ws.send_json({"type": "hello", "contract": 1})
    kind, m = ws_recv(ws)
    assert m["type"] == "hello_ack" and m["model_version"] == "stub+0001"


def test_scan_miss_then_cache_hit_and_channel_subset(client):
    item = ingest(client, synthetic())
    sha, L = item["sha256"], item["record"]["length"]
    assert L == 20000
    with client.websocket_connect("/ws/scan") as ws:
        hello(ws)
        ws.send_json({"type": "ping", "t": 7})
        assert ws_recv(ws)[1] == {"type": "pong", "t": 7}
        out = run_scan(ws, sha)
        ready = next(m for m in out["json"] if m["type"] == "scan_ready")
        assert ready["cache"] == "MISS" and ready["length"] == L and len(ready["channels"]) == 13
        assert ready["model_scope"]["warning"] == "test model" and ready["overview_bins"] == 4000
        assert out["frames"][0]["type"] == fr.T_OVERVIEW and out["frames"][0]["planes"].shape == (13, 4000)
        tel = [f for f in out["frames"] if f["type"] == fr.T_TELEMETRY]
        assert [f["seq"] for f in out["frames"]] == list(range(len(out["frames"])))
        assert tel[0]["start"] == 0 and all(a["start"] + a["count"] == b["start"] for a, b in zip(tel, tel[1:]))
        assert tel[-1]["start"] + tel[-1]["count"] == L and tel[-1]["flags"] & fr.F_FINAL and not tel[0]["flags"] & fr.F_FINAL
        planes = np.concatenate([f["planes"] for f in tel], axis=1)
        assert planes.shape == (13, L) and np.isfinite(planes[[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12]]).all()
        assert 0 <= np.nanmin(planes[5]) and np.nanmax(planes[5]) <= 1 and planes[8].max() > planes[8].min()
        assert planes[12, 9500] > 0.5 > planes[12, 3000]                                  # anomaly peaks inside the GC insert
        alerts = [m for m in out["json"] if m["type"] == "anomaly_alert"]
        done = next(m for m in out["json"] if m["type"] == "scan_complete")
        assert len(alerts) >= 1 and done["anomaly_count"] == len(alerts)
        assert any(a["start"] < 11000 and a["end"] > 8000 for a in alerts) and alerts[0]["kind"] in ("composition_shift", "possible_hgt")
        assert any(m["type"] == "progress" and m["fraction"] == 1.0 for m in out["json"])

        again = run_scan(ws, sha)                                                         # served from analysis_chunks
        r2 = next(m for m in again["json"] if m["type"] == "scan_ready")
        assert r2["cache"] == "HIT"
        tel2 = [f for f in again["frames"] if f["type"] == fr.T_TELEMETRY]
        assert all(f["flags"] & fr.F_FROM_CACHE for f in tel2)
        assert np.array_equal(np.concatenate([f["planes"] for f in tel2], axis=1), planes, equal_nan=True)

        sub = run_scan(ws, sha, want=[12, 0, 99])
        rs = next(m for m in sub["json"] if m["type"] == "scan_ready")
        assert [c["id"] for c in rs["channels"]] == [0, 12]
        assert np.array_equal(np.concatenate([f["planes"] for f in sub["frames"] if f["type"] == fr.T_TELEMETRY], axis=1),
                              planes[[0, 12]], equal_nan=True)

    rec = client.get("/api/history/sync", params={"since_rev": 0}).json()["upserts"][0]
    assert rec["anomaly_count"] == len(alerts)
    meta = client.get(f"/api/analysis/{sha}/meta").json()
    assert meta["length"] == L and len(meta["regions"]) == len(alerts) and meta["channel_ids"] == list(range(13))
    raw = client.get(f"/api/analysis/{sha}")
    assert raw.headers["x-hs-length"] == str(L) and np.array_equal(np.frombuffer(raw.content, "<f4").reshape(13, L), planes, equal_nan=True)


def test_mutation_checkpoint_and_protocol_errors(client):
    item = ingest(client, make_seq(2000, .5, 21))
    sha, scan_id = item["sha256"], item["record"]["scan_id"]
    with client.websocket_connect("/ws/scan") as ws:
        hello(ws)
        ws.send_json({"type": "mutate", "request_id": "m1", "scan_id": scan_id, "position": 500, "alt": "G"})
        k, m = ws_recv(ws)
        mut = m["mutation"]
        assert m["type"] == "mutation_result" and m["request_id"] == "m1" and mut["alt"] == "G" and mut["position"] == 500
        assert 0 <= mut["pathogenicity"] < 1 and mut["scan_id"] == scan_id
        ws.send_json({"type": "mutate", "request_id": "m2", "scan_id": scan_id, "position": 99999, "alt": "G"})
        k, m = ws_recv(ws)
        assert m["type"] == "error" and m["error"]["code"] == "PROTOCOL_ERROR" and m["error"]["detail"]["request_id"] == "m2" and not m["fatal"]
        ws.send_json({"type": "checkpoint", "scan_id": scan_id, "last_scanned_pos": 777})
        ws.send_json({"type": "start_scan", "sha256": "f" * 64})
        k, m = ws_recv(ws)
        assert m["error"]["code"] == "UNKNOWN_SEQUENCE" and not m["fatal"]
    assert client.get(f"/api/history/{scan_id}").json()["last_scanned_pos"] == 777
    assert client.get(f"/api/history/{scan_id}").json()["mutation_count"] == 1

    with client.websocket_connect("/ws/scan") as ws:                 # protocol violations are fatal and close with 4400
        ws.send_json({"type": "start_scan", "sha256": sha})
        assert ws_recv(ws)[1]["error"]["code"] == "PROTOCOL_ERROR"
        assert ws_recv(ws) == ("close", 4400)
    with client.websocket_connect("/ws/scan") as ws:
        ws.send_text("not json")
        assert ws_recv(ws)[1]["fatal"] is True and ws_recv(ws) == ("close", 4400)
    with client.websocket_connect("/ws/scan") as ws:
        ws.send_json({"type": "hello", "contract": 99})
        assert ws_recv(ws)[1]["error"]["code"] == "PROTOCOL_ERROR"


def test_cross_origin_websocket_is_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/scan", headers={"origin": "http://evil.example"}):
            pass
    with client.websocket_connect("/ws/scan", headers={"origin": "http://localhost:5173"}) as ws:     # configured UI origin
        hello(ws)


def test_degraded_scan_without_model(tmp_path):
    with build_client(tmp_path, bundle=ModelBundle(None)) as c:
        item = ingest(c, synthetic())
        with c.websocket_connect("/ws/scan") as ws:
            ws.send_json({"type": "hello", "contract": 1})
            ws_recv(ws)
            out = run_scan(ws, item["sha256"])
        codes = [m["error"]["code"] for m in out["json"] if m["type"] == "error"]
        assert codes == ["MODEL_UNAVAILABLE"]
        planes = np.concatenate([f["planes"] for f in out["frames"] if f["type"] == fr.T_TELEMETRY], axis=1)
        assert np.isnan(planes[7:12]).all() and np.isfinite(planes[[0, 2, 12]]).all()
        r = c.post("/api/sequences/%s/mutations" % item["sha256"], json={"request_id": "x", "scan_id": item["record"]["scan_id"], "position": 100, "alt": "A"}).json()
        assert r["pathogenicity"] is None and "delta_tm_c" in r                  # thermo deltas only


def test_framing_overview_and_ack_window():
    planes = np.arange(24, dtype=np.float32).reshape(2, 12)
    buf = fr.pack_frame(fr.T_TELEMETRY, 5, 100, planes, fr.F_FINAL)
    assert len(buf) == 24 + 2 * 12 * 4 and buf[:2] == b"HS" and fr.HEADER_BYTES % 4 == 0
    f = fr.unpack_frame(buf)
    assert (f["seq"], f["start"], f["count"], f["channels"], f["flags"]) == (5, 100, 12, 2, fr.F_FINAL)
    assert np.array_equal(f["planes"], planes)
    ov, size = fr.make_overview(np.array([[1, 3, np.nan, np.nan, 5, 7, 2, 2, 9]], np.float32), max_bins=3)
    assert size == 3 and ov.shape == (1, 3)
    assert ov[0, 0] == 2.0 and ov[0, 1] == 6.0 and ov[0, 2] == pytest.approx(13 / 3)

    async def window():
        w = AckWindow(size=2, timeout=0.05)
        assert [await w.acquire(), await w.acquire()] == [0, 1]
        with pytest.raises(SlowClient):
            await w.acquire()
        await w.ack(1)
        assert await w.acquire() == 2
    asyncio.run(window())
```

### 8.5 `tests/test_watcher.py`
```python
import time

import pytest

from conftest import build_client, make_seq, ws_recv
from helixsight.config import Settings


def wait_for(fn, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return v
        time.sleep(0.1)
    raise AssertionError("timed out")


@pytest.mark.parametrize("polling", [False, True])
def test_watched_folder_ingest_events_dedup_and_failures(tmp_path, monkeypatch, polling):
    if polling:
        monkeypatch.setattr(Settings, "watch_uses_polling", property(lambda s: True))
    watch = tmp_path / "watch"
    watch.mkdir()
    (watch / "preexisting.fa").write_text(f">pre\n{make_seq(400, .5, 31)}\n")       # arrived while the server was down
    with build_client(tmp_path, watch=True) as c:
        with c.websocket_connect("/ws/events") as ev:
            kind, status = ws_recv(ev)
            assert status["type"] == "watcher_status" and status["watching"] and status["mode"] == ("polling" if polling else "inotify")
            wait_for(lambda: len(c.get("/api/history").json()["items"]) == 1)
            assert ws_recv(ev)[1]["type"] in ("watcher_status", "history_changed", "ingest_complete")

            body = f">dropped one\n{make_seq(600, .4, 32)}\n"
            (watch / "dropped.fasta").write_text(body)
            (watch / "bad.fna").write_text(">x\nACGT ACZT\n")
            (watch / "ignored.pdf").write_text("nope")
            (watch / ".hidden.fa").write_text("ACGT")
            seen = []
            for _ in range(40):
                k, m = ws_recv(ev)
                seen.append(m["type"])
                if m["type"] == "ingest_complete" and m["item"]["record"]["display_name"] == "dropped":
                    break
            names = {i["display_name"] for i in c.get("/api/history").json()["items"]}
            assert names == {"pre", "dropped"} and "ingest_complete" in seen
            assert wait_for(lambda: "server_notice" in seen or _notice(ev, seen))                      # bad.fna reported, not ingested

            n = len(c.get("/api/history").json()["items"])
            svc = c.app.state.services
            c.portal.call(svc.watcher._process, watch / "dropped.fasta")      # unchanged (size, mtime): skipped via watch_files
            assert len(c.get("/api/history").json()["items"]) == n
            (watch / "dropped.fasta").write_text(body + "\n")                # content-identical rewrite, new mtime/size -> re-ingest
            wait_for(lambda: len(c.get("/api/history").json()["items"]) == n + 1)
            newest = c.get("/api/history").json()["items"][0]
            assert newest["display_name"] == "dropped" and newest["source"] == "FILE"


def _notice(ev, seen):
    for _ in range(20):
        k, m = ws_recv(ev)
        seen.append(m["type"])
        if m["type"] == "server_notice":
            return True
    return False
```
Run: `uv run pytest backend/tests -q` → expected `19 passed` (plus doc 04's `test_core_bridge.py` / `test_duckdb_repo.py`).

---

## 9. SECURITY & OPERATIONS NOTES

| Topic | Rule |
|---|---|
| Binding | `uvicorn --host 127.0.0.1` only; never `0.0.0.0` unless the user opts in and understands the data is unauthenticated. |
| WebSocket origin | C-11 (S7): enforced on both `/ws/*` endpoints; CORS (`HS_CORS_ORIGINS`) governs REST reads from browsers. |
| Uploads | read at most `max_upload_mb + 1` bytes per file; decoded with `errors="replace"`; content validated, extension never trusted. |
| Outbound traffic | only `eutils.ncbi.nlm.nih.gov` and `data.rcsb.org` / `www.rcsb.org`, only on explicit user ingest requests; User-Agent carries `HS_NCBI_EMAIL` (NCBI etiquette). |
| Logging | never log sequence content; log accessions, hashes (first 8 chars) and error codes. |
| Single process | one uvicorn worker (DuckDB single writer, in-process `EventHub`, session state). Do not use `--workers > 1`. |

---

## 10. INTERCONNECTION MATRIX (SERVICES)

| Caller | Callee | Payload | Purpose |
|---|---|---|---|
| `routes_ingest` | `Ingestor.ingest_*` | request models | lane dispatch |
| `Ingestor` | `canonicalize` | `str → list[CanonicalRecord]` | sanitize, hash |
| `Ingestor` | `NcbiClient` / `PdbClient` | httpx GET with retry + rate limit | external fetch |
| `Ingestor` | `repo.ingest_one` / `queries.*` (via `DuckStore.write_tx/read`) | SQL | dedup, provenance, history |
| `Ingestor` / routes / session | `EventHub.publish` | `history_changed`, `ingest_complete` | live UI sync |
| watchdog thread | `loop.call_soon_threadsafe` → `FolderWatcher._on_path` | path string | thread-safe enqueue |
| `FolderWatcher` | `Ingestor.ingest_file`, `queries.watch_put` | bytes, SQL | folder lane |
| `ws_scan` | `ScanSession.run` | WS frames | stream |
| `ScanSession` | `native.compute_core_channels_async`, `predict_sequence`, `anomaly_scores`, `region_kind` | numpy buffers | analysis |
| `ScanSession` | `repo.put_analysis` / `get_chunk` / `get_overview` | planes ↔ chunks | cache write-through / replay |
| `ScanSession` / `routes_analysis` | `apply_mutation` | `(scan_id, position, alt)` | mutation service |
| `apply_mutation` | `native.local_thermo`, `score_mutation`, `repo.add_mutation` | codes, deltas | ΔTm/ΔΔG/pathogenicity |
| `main.lifespan` | all of the above | DI container `Services` | wiring/teardown |

---

## 11. PATCHES TO APPLY TO EARLIER DOCS

```text
P1  doc 00 §5 tree: schemas/ = {__init__,models}.py (one module); drop fasta.py (merged into sanitizer.py); add
    backend/src/helixsight/{events.py,services.py,db/queries.py,ingestion/http_util.py,ml/anomaly_kind.py,api/deps.py}.
P2  doc 00 §3: add C-11 "Local servers must reject cross-site WebSocket handshakes (Origin allow-list) and bind to 127.0.0.1".
P3  doc 01 §3.3 (PDB flow): sequences come from polymer_entity JSON; FASTA endpoint is a fallback only (S1); add "{ID}:*" alias (S2).
P4  doc 01 §3.1/§3.2: add revalidation + offline-serve behaviour (S3) and the versioned-key alias.
P5  doc 01 §7.2/§7.4: idle timeout 45 s (S6); close codes 4400/4403/4408/4409.
P6  doc 01 §8: add GET /api/analysis/{sha}/meta, GET /api/history/{scan_id}/mutations, DELETE /api/mutations/{id}; analysis tensor headers (S9).
P7  doc 01 §10/§11 + doc 02 §2.3: INVALID_IUPAC detail = {offset, raw_offset, char}; UI highlights `raw_offset`. Add AnalysisMeta, AnomalyRegion,
    Health, ModelScope, ProgressRequest and WsScanReady.model_scope to the TS contracts (§3.3 of this doc is the source of truth).
P8  doc 01 §13: error table per S4 (UPSTREAM_TIMEOUT for 5xx/transport; INVALID_ACCESSION also for malformed pdb_id).
P9  doc 01 §7.3 / §4.2: overview frame is seq 0 and bin count = ceil(L / ceil(L/4096)) (S5).
P10 doc 03 §5.1: import torch lazily inside TorchRunner.__init__ (see §5.1 here).
P11 doc 03 §9: guard the thermo term with np.isfinite(d_dg) (NaN thermo previously made `pathogenicity` NaN) (see §5.4 here).
P12 doc 03 §7: add anomaly_kind.region_kind (see §5.3 here); score field of WsAnomalyAlert = min(1, peak_z / 7).
P13 doc 05 §3.3: config.py gains watch_enabled and max_upload_mb (§3.1 here); .env.example gains HS_WATCH_ENABLED, HS_MAX_UPLOAD_MB.
P14 doc 05 §7 build order: B4 = sanitizer + paste + history + health (tests here), B5 = NCBI/PDB/file/watcher, B6/B8 = streaming/ML wiring;
    each step's acceptance test is the matching file in §8 (run against real NCBI/RCSB once manually in B5 to confirm response field names).
```

### 11.1 Tracker snapshot (extends doc 05 §11)
```text
[x] spec files 00-06 generated
[ ] B4  sanitizer/paste/history/health  → tests/test_sanitizer.py, test_api.py::test_paste_*, test_health_*
[ ] B5  NCBI/PDB/file/watcher           → test_api.py::test_ncbi_*, test_pdb_lane, test_file_upload_*, test_watcher.py (+ one live call each)
[ ] B6  streaming (no ML)               → test_ws.py::test_degraded_scan_without_model, test_framing_overview_and_ack_window
[ ] B8  ML in streaming + mutations     → test_ws.py::test_scan_miss_then_cache_hit_*, test_mutation_checkpoint_*  (swap StubRunner for the real ONNX model)
```