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
            self.loop.call_soon_threadsafe(self.on_path, path)
    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory: self._push(os.fsdecode(event.src_path))
    on_modified = on_created
    def on_moved(self, event: FileSystemEvent) -> None:
        if not event.is_directory: self._push(os.fsdecode(event.dest_path))

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

    def _on_path(self, path: str) -> None:
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
        for p in sorted(self.dir.iterdir()):
            if p.is_file() and _ok(str(p)):
                self._on_path(str(p))
        await self.hub.publish(self.status())

    async def stop(self) -> None:
        if self._task: self._task.cancel()
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
            except Exception:
                log.exception("watcher failed on %s", path)
            finally:
                self._pending.discard(path)

    async def _stable_stat(self, path: Path) -> Optional[os.stat_result]:
        last = None
        for _ in range(60):
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
        if st is None or st.st_size == 0: return
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
