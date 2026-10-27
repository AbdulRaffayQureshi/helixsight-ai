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
from ..schemas.models import (EvHistoryChanged, HistoryRecord, IngestItem, NcbiIngestRequest, PasteIngestRequest, PdbIngestRequest)
from .ncbi_client import NcbiClient
from .pdb_client import PdbClient, select_entities
from .sanitizer import canonicalize

AnalysisKey = Callable[[], tuple[str, str, str]]
_UNVERSIONED_TTL_DAYS = 30

class Ingestor:
    def __init__(self, store: DuckStore, settings: Settings, ncbi: NcbiClient, pdb: PdbClient, hub: EventHub,
                 analysis_key: AnalysisKey) -> None:
        self.store, self.settings, self.ncbi, self.pdb, self.hub, self.analysis_key = store, settings, ncbi, pdb, hub, analysis_key

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

    async def ingest_paste(self, req: PasteIngestRequest) -> tuple[list[IngestItem], list[str]]:
        recs, warns = canonicalize(req.text, label=req.label, max_bp=self.settings.max_seq_bp)
        return await self._commit([(r, SourceMeta("PASTE")) for r in recs]), warns

    async def ingest_file(self, filename: str, data: bytes, announce: bool = True) -> tuple[list[IngestItem], list[str]]:
        if len(data) > self.settings.max_upload_mb * 1024 * 1024:
            raise HSError("SEQUENCE_TOO_LONG", f"{filename} exceeds {self.settings.max_upload_mb} MB",
                          {"size": len(data)})
        recs, warns = canonicalize(data.decode("utf-8", errors="replace"), name_hint=Path(filename).stem,
                                   max_bp=self.settings.max_seq_bp)
        return await self._commit([(r, SourceMeta("FILE", accession=filename)) for r in recs], announce=announce), warns

    async def ingest_ncbi(self, req: NcbiIngestRequest) -> tuple[list[IngestItem], list[str]]:
        key = req.accession.upper()
        warnings: list[str] = []
        row = await self.store.read(lambda c: q.accession_any(c, "NCBI", key))
        if row and not req.force_refresh:
            fresh = row["ttl_expires_at"] is None or row["ttl_expires_at"] > repo.utcnow()
            if not fresh:
                try:
                    summ = await self.ncbi.esummary(key)
                    fresh = summ.accessionversion == row["resolved_acc"]
                    if fresh:
                        ttl = repo.utcnow() + timedelta(days=_UNVERSIONED_TTL_DAYS)
                        await self.store.write_tx(lambda c: q.touch_accession(c, "NCBI", key, ttl, repo.utcnow()))
                except HSError as e:
                    if e.code not in ("UPSTREAM_TIMEOUT", "NCBI_RATE_LIMITED"): raise
                    fresh = True
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
        if summ.accessionversion.upper() != key:
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
        pairs = []
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
        if req.entity_id is None and not req.all_nucleic_acid:
            await self.store.write_tx(lambda c: q.put_accession(c, "PDB", f"{pid}:*", pairs[0][0].sha256, None, None, repo.utcnow()))
        return items, warnings
