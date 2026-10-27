from __future__ import annotations

import asyncio
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, TypeVar

import duckdb

T = TypeVar("T")
MIGRATIONS_DIR = Path(__file__).parent / "migrations"

class DuckStore:
    def __init__(self, path: str = "data/helixsight.duckdb", memory_limit: str = "1GB",
                 threads: int = 4, read_workers: int = 4) -> None:
        self._path, self._memory_limit, self._threads = path, memory_limit, threads
        self._writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="duck-writer")
        self._readers = ThreadPoolExecutor(max_workers=read_workers, thread_name_prefix="duck-read")
        self._con: duckdb.DuckDBPyConnection | None = None
        self._wcur: duckdb.DuckDBPyConnection | None = None

    def open(self) -> None:
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._con = duckdb.connect(self._path)
        self._con.execute("SET TimeZone = 'UTC'")
        self._con.execute(f"SET memory_limit = '{self._memory_limit}'")
        self._con.execute(f"SET threads = {int(self._threads)}")
        self._migrate(self._con)
        self._wcur = self._con.cursor()

    def close(self) -> None:
        self._writer.shutdown(wait=True)
        self._readers.shutdown(wait=True)
        if self._con is not None:
            self._con.close()
            self._con = None

    @staticmethod
    def _migrate(con: duckdb.DuckDBPyConnection) -> None:
        con.execute("CREATE TABLE IF NOT EXISTS schema_meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)")
        row = con.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'").fetchone()
        current = int(row[0]) if row else 0
        files = sorted(p for p in MIGRATIONS_DIR.glob("*.sql") if re.match(r"^\d{3}_", p.name))
        for f in files:
            version = int(f.name[:3])
            if version <= current:
                continue
            con.execute("BEGIN TRANSACTION")
            try:
                con.execute(f.read_text(encoding="utf-8"))
                con.execute("INSERT OR REPLACE INTO schema_meta VALUES ('schema_version', ?)", [str(version)])
                con.execute("COMMIT")
            except BaseException:
                con.execute("ROLLBACK")
                raise
            current = version

    def _run_read(self, fn: Callable[[duckdb.DuckDBPyConnection], T]) -> T:
        cur = self._con.cursor()
        try:
            return fn(cur)
        finally:
            cur.close()

    def _run_tx(self, fn: Callable[[duckdb.DuckDBPyConnection], T]) -> T:
        cur = self._wcur
        assert cur is not None
        cur.execute("BEGIN TRANSACTION")
        try:
            out = fn(cur)
            cur.execute("COMMIT")
            return out
        except BaseException:
            cur.execute("ROLLBACK")
            raise

    async def read(self, fn: Callable[[duckdb.DuckDBPyConnection], T]) -> T:
        return await asyncio.get_running_loop().run_in_executor(self._readers, self._run_read, fn)

    async def write_tx(self, fn: Callable[[duckdb.DuckDBPyConnection], T]) -> T:
        return await asyncio.get_running_loop().run_in_executor(self._writer, self._run_tx, fn)
