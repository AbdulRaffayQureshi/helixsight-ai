from __future__ import annotations
import logging
from contextlib import asynccontextmanager
from typing import Optional
import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .api import routes_history, routes_ingest, routes_analysis, ws_scan, ws_events
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

log = logging.getLogger("helixsight")

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
        hub = EventHub()
        ncbi = NcbiClient(http, tool=settings.ncbi_tool, email=settings.ncbi_email, api_key=settings.ncbi_api_key)
        pdb = PdbClient(http)
        ingestor = Ingestor(store, settings, ncbi, pdb, hub, lambda: (mb.model_version, native.CORE_VERSION, "stub"))
        svc = Services(settings, store, http, ncbi, pdb, hub, ingestor, mb, core, "stub")
        if settings.watch_enabled:
            svc.watcher = FolderWatcher(settings.watch_dir, ingestor, store, hub, polling=settings.watch_uses_polling)
            await svc.watcher.start()
        app.state.services = svc
        try:
            yield
        finally:
            if svc.watcher: await svc.watcher.stop()
            await http.aclose()
            store.close()

    app = FastAPI(title="HelixSight AI", version="0.1.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_list, allow_methods=["*"], allow_headers=["*"])
    install_error_handlers(app)
    app.include_router(routes_ingest.router)
    app.include_router(routes_history.router)
    app.include_router(routes_analysis.router)
    app.include_router(ws_scan.router)
    app.include_router(ws_events.router)
    return app
