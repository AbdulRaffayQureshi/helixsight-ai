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
