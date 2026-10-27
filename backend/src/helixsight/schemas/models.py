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

class Req(BaseModel):
    model_config = ConfigDict(extra="forbid")

class Res(BaseModel):
    model_config = ConfigDict(extra="ignore")

def _utc(v: Any) -> Any:
    return v.replace(tzinfo=timezone.utc) if isinstance(v, datetime) and v.tzinfo is None else v

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
    pathogenicity: Optional[float] = Field(default=None, ge=0, le=1)
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

ClientMsg = Annotated[Union[WsHello, WsStartScan, WsAck, WsCheckpoint, WsMutate, WsStop, WsPing], Field(discriminator="type")]

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
