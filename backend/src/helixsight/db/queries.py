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
