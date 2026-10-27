from __future__ import annotations
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
import duckdb
import numpy as np
from ..ids import uuid7

try:
    import zstandard as _zstd
except ImportError:
    _zstd = None

Cur = duckdb.DuckDBPyConnection
CHUNK_POSITIONS = 65_536

def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)

@dataclass(frozen=True, slots=True)
class CanonicalRecord:
    sha256: str
    residues: str
    molecule: str
    length: int
    gc_pct: float
    a: int
    c: int
    g: int
    t: int
    ambiguous: int
    display_name: str
    description: Optional[str] = None

@dataclass(frozen=True, slots=True)
class SourceMeta:
    source: str
    accession: Optional[str] = None
    entity_id: Optional[int] = None
    organism: Optional[str] = None
    meta_json: Optional[dict[str, Any]] = None
    accession_key: Optional[str] = None
    resolved_acc: Optional[str] = None
    ttl_days: Optional[int] = None

def _rows(cur: Cur) -> list[dict[str, Any]]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]

def _one(cur: Cur) -> Optional[dict[str, Any]]:
    rows = _rows(cur)
    return rows[0] if rows else None

def lookup_accession(cur: Cur, source: str, key: str, now: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    now = now or utcnow()
    return _one(cur.execute(
        "SELECT * FROM accession_index WHERE source = ? AND accession_key = ? "
        "AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)", [source, key, now]))

def find_analysis(cur: Cur, sha256: str, model_version: str, core_version: str, params_hash: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute(
        "SELECT analysis_id, anomaly_count FROM analysis_cache WHERE sha256 = ? AND model_version = ? "
        "AND core_version = ? AND params_hash = ?", [sha256, model_version, core_version, params_hash]))

def ingest_one(cur: Cur, rec: CanonicalRecord, meta: SourceMeta,
               analysis_key: Optional[tuple[str, str, str]] = None,
               now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or utcnow()
    existed = cur.execute("SELECT 1 FROM sequences WHERE sha256 = ?", [rec.sha256]).fetchone() is not None
    if not existed:
        cur.execute(
            "INSERT INTO sequences (sha256, residues, molecule, length, gc_pct, a_count, c_count, g_count, "
            "t_count, ambiguous_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [rec.sha256, rec.residues, rec.molecule, rec.length, rec.gc_pct, rec.a, rec.c, rec.g, rec.t,
             rec.ambiguous, now])
    record_id = uuid7()
    cur.execute(
        "INSERT INTO source_records (record_id, sha256, source, accession, entity_id, display_name, description, "
        "organism, meta_json, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [record_id, rec.sha256, meta.source, meta.accession, meta.entity_id, rec.display_name, rec.description,
         meta.organism, json.dumps(meta.meta_json) if meta.meta_json is not None else None, now])
    if meta.accession_key is not None:
        ttl = now + timedelta(days=meta.ttl_days) if meta.ttl_days else None
        cur.execute(
            "INSERT INTO accession_index (source, accession_key, sha256, resolved_acc, fetched_at, ttl_expires_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT (source, accession_key) DO UPDATE SET "
            "sha256 = excluded.sha256, resolved_acc = excluded.resolved_acc, "
            "fetched_at = excluded.fetched_at, ttl_expires_at = excluded.ttl_expires_at",
            [meta.source, meta.accession_key, rec.sha256, meta.resolved_acc, now, ttl])
    cached = find_analysis(cur, rec.sha256, *analysis_key) if analysis_key else None
    scan_id = uuid7()
    cur.execute(
        "INSERT INTO analysis_history (scan_id, sha256, record_id, analysis_id, source, display_name, accession, "
        "length, gc_pct, anomaly_count, last_scanned_pos, mutation_count, created_at, updated_at, deleted, rev) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,FALSE,nextval('rev_seq'))",
        [scan_id, rec.sha256, record_id, cached["analysis_id"] if cached else None, meta.source, rec.display_name,
         meta.accession or rec.display_name, rec.length, rec.gc_pct, cached["anomaly_count"] if cached else 0,
         now, now])
    row = _one(cur.execute("SELECT * FROM v_history_record WHERE scan_id = ?", [scan_id]))
    return {"sequence_existed": existed, "has_analysis_cache": cached is not None, "record": row}

def history_page(cur: Cur, limit: int = 50, before_rev: Optional[int] = None, source: Optional[str] = None,
                 q: Optional[str] = None) -> list[dict[str, Any]]:
    sql, args = "SELECT * FROM v_history_record WHERE NOT deleted", []
    if before_rev is not None:
        sql += " AND rev < ?"; args.append(before_rev)
    if source:
        sql += " AND source = ?"; args.append(source)
    if q:
        sql += " AND (display_name ILIKE ? OR accession ILIKE ?)"; args += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY rev DESC LIMIT ?"; args.append(limit)
    return _rows(cur.execute(sql, args))

def history_sync(cur: Cur, since_rev: int) -> dict[str, Any]:
    upserts = _rows(cur.execute("SELECT * FROM v_history_record WHERE rev > ? AND NOT deleted ORDER BY rev", [since_rev]))
    deleted = [r[0] for r in cur.execute("SELECT scan_id FROM analysis_history WHERE rev > ? AND deleted", [since_rev]).fetchall()]
    latest = cur.execute("SELECT coalesce(max(rev), 0) FROM analysis_history").fetchone()[0]
    return {"since_rev": since_rev, "latest_rev": int(latest), "upserts": upserts, "deleted": deleted}

def checkpoint(cur: Cur, scan_id: str, pos: int, now: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    cur.execute("UPDATE analysis_history SET last_scanned_pos = ?, updated_at = ?, rev = nextval('rev_seq') "
                "WHERE scan_id = ? AND NOT deleted", [pos, now or utcnow(), scan_id])
    return _one(cur.execute("SELECT * FROM v_history_record WHERE scan_id = ?", [scan_id]))

def delete_history(cur: Cur, scan_id: str, now: Optional[datetime] = None) -> None:
    cur.execute("UPDATE analysis_history SET deleted = TRUE, updated_at = ?, rev = nextval('rev_seq') WHERE scan_id = ?",
                [now or utcnow(), scan_id])
    cur.execute("DELETE FROM mutations WHERE scan_id = ?", [scan_id])

def _encode(buf: bytes, codec: str) -> bytes:
    if codec == "raw": return buf
    if _zstd is None: raise RuntimeError("codec 'zstd' requested but not installed")
    return _zstd.ZstdCompressor(level=3).compress(buf)

def _decode(buf: bytes, codec: str) -> bytes:
    if codec == "raw": return buf
    if _zstd is None: raise RuntimeError("cache entry is zstd-compressed but not installed")
    return _zstd.ZstdDecompressor().decompress(buf)

def put_analysis(cur: Cur, *, sha256: str, model_version: str, core_version: str, params_hash: str,
                 params: dict[str, Any], planes: np.ndarray, channel_ids: list[int], anomaly_count: int,
                 summary: dict[str, Any], overview: Optional[np.ndarray] = None, codec: str = "raw",
                 chunk_positions: int = CHUNK_POSITIONS, now: Optional[datetime] = None) -> str:
    now = now or utcnow()
    existing = find_analysis(cur, sha256, model_version, core_version, params_hash)
    if existing: return existing["analysis_id"]
    n_ch, length = planes.shape
    n_chunks = (length + chunk_positions - 1) // chunk_positions
    analysis_id = uuid7()
    for ci in range(n_chunks):
        s, e = ci * chunk_positions, min(length, (ci + 1) * chunk_positions)
        payload = _encode(np.ascontiguousarray(planes[:, s:e]).astype("<f4", copy=False).tobytes(order="C"), codec)
        cur.execute("INSERT INTO analysis_chunks (analysis_id, chunk_idx, start_pos, count, payload) VALUES (?,?,?,?,?)",
                    [analysis_id, ci, s, e - s, payload])
    ov = overview.astype("<f4", copy=False).tobytes(order="C") if overview is not None else None
    cur.execute(
        "INSERT INTO analysis_cache (analysis_id, sha256, model_version, core_version, params_hash, params_json, "
        "length, channel_ids, n_channels, chunk_positions, n_chunks, codec, anomaly_count, summary_json, "
        "overview_bins, overview, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [analysis_id, sha256, model_version, core_version, params_hash, json.dumps(params, sort_keys=True),
         length, json.dumps(channel_ids), n_ch, chunk_positions, n_chunks, codec, anomaly_count,
         json.dumps(summary), overview.shape[1] if overview is not None else 0, ov, now])
    cur.execute("UPDATE analysis_history SET analysis_id = ?, anomaly_count = ?, updated_at = ?, rev = nextval('rev_seq') "
                "WHERE sha256 = ? AND NOT deleted", [analysis_id, anomaly_count, now, sha256])
    return analysis_id

def get_analysis_meta(cur: Cur, sha256: str, model_version: str, core_version: str, params_hash: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute(
        "SELECT analysis_id, sha256, length, channel_ids, n_channels, chunk_positions, n_chunks, codec, "
        "anomaly_count, summary_json, overview_bins FROM analysis_cache WHERE sha256 = ? AND model_version = ? "
        "AND core_version = ? AND params_hash = ?", [sha256, model_version, core_version, params_hash]))

def get_chunk(cur: Cur, analysis_id: str, chunk_idx: int, n_channels: int, codec: str) -> Optional[tuple[int, np.ndarray]]:
    row = cur.execute("SELECT start_pos, count, payload FROM analysis_chunks WHERE analysis_id = ? AND chunk_idx = ?",
                      [analysis_id, chunk_idx]).fetchone()
    if row is None: return None
    start, count, payload = row
    arr = np.frombuffer(_decode(bytes(payload), codec), dtype="<f4").reshape(n_channels, count)
    return int(start), arr

def get_overview(cur: Cur, analysis_id: str, n_channels: int) -> Optional[np.ndarray]:
    row = cur.execute("SELECT overview, overview_bins FROM analysis_cache WHERE analysis_id = ?", [analysis_id]).fetchone()
    if row is None or row[0] is None: return None
    return np.frombuffer(bytes(row[0]), dtype="<f4").reshape(n_channels, int(row[1]))

def prune_stale_analyses(cur: Cur, keep_model_version: str, keep_core_version: str) -> int:
    ids = [r[0] for r in cur.execute("SELECT analysis_id FROM analysis_cache WHERE model_version <> ? OR core_version <> ?",
                                     [keep_model_version, keep_core_version]).fetchall()]
    for aid in ids:
        cur.execute("DELETE FROM analysis_chunks WHERE analysis_id = ?", [aid])
        cur.execute("DELETE FROM analysis_cache WHERE analysis_id = ?", [aid])
        cur.execute("UPDATE analysis_history SET analysis_id = NULL WHERE analysis_id = ?", [aid])
    return len(ids)

def add_mutation(cur: Cur, *, scan_id: str, sha256: str, position: int, ref: str, alt: str,
                 deltas: dict[str, Optional[float]], now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or utcnow()
    mid = uuid7()
    cur.execute(
        "INSERT INTO mutations (mutation_id, scan_id, sha256, position, ref_base, alt_base, delta_tm_c, delta_dg_kcal, "
        "delta_p_promoter, delta_p_cpg, delta_p_splice, pathogenicity, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [mid, scan_id, sha256, position, ref, alt, deltas.get("delta_tm_c"), deltas.get("delta_dg_kcal"),
         deltas.get("delta_p_promoter"), deltas.get("delta_p_cpg"), deltas.get("delta_p_splice"),
         deltas.get("pathogenicity"), now])
    _bump_mutation_count(cur, scan_id, now)
    return _one(cur.execute("SELECT * FROM mutations WHERE mutation_id = ?", [mid])) 

def delete_mutation(cur: Cur, mutation_id: str, now: Optional[datetime] = None) -> bool:
    row = cur.execute("SELECT scan_id FROM mutations WHERE mutation_id = ?", [mutation_id]).fetchone()
    if row is None: return False
    cur.execute("DELETE FROM mutations WHERE mutation_id = ?", [mutation_id])
    _bump_mutation_count(cur, row[0], now or utcnow())
    return True

def list_mutations(cur: Cur, scan_id: str) -> list[dict[str, Any]]:
    return _rows(cur.execute("SELECT * FROM mutations WHERE scan_id = ? ORDER BY created_at", [scan_id]))

def _bump_mutation_count(cur: Cur, scan_id: str, now: datetime) -> None:
    cur.execute("UPDATE analysis_history SET mutation_count = (SELECT count(*) FROM mutations WHERE scan_id = ?), "
                "updated_at = ?, rev = nextval('rev_seq') WHERE scan_id = ?", [scan_id, now, scan_id])

def verify_integrity(cur: Cur) -> dict[str, int]:
    checks = {
        "history_without_sequence": "SELECT count(*) FROM analysis_history h ANTI JOIN sequences s ON s.sha256 = h.sha256",
        "source_records_without_sequence": "SELECT count(*) FROM source_records r ANTI JOIN sequences s ON s.sha256 = r.sha256",
        "accession_index_without_sequence": "SELECT count(*) FROM accession_index a ANTI JOIN sequences s ON s.sha256 = a.sha256",
        "mutations_without_history": "SELECT count(*) FROM mutations m ANTI JOIN analysis_history h ON h.scan_id = m.scan_id",
        "chunks_without_analysis": "SELECT count(*) FROM analysis_chunks c ANTI JOIN analysis_cache a ON a.analysis_id = c.analysis_id",
        "history_with_dangling_analysis": "SELECT count(*) FROM analysis_history h WHERE h.analysis_id IS NOT NULL AND NOT EXISTS "
                                          "(SELECT 1 FROM analysis_cache a WHERE a.analysis_id = h.analysis_id)",
        "analysis_missing_chunks": "SELECT count(*) FROM analysis_cache a WHERE a.n_chunks <> "
                                   "(SELECT count(*) FROM analysis_chunks c WHERE c.analysis_id = a.analysis_id)",
    }
    return {name: int(cur.execute(sql).fetchone()[0]) for name, sql in checks.items()}
