from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Depends, Query, Response
from ..db import queries as q
from ..db import repo
from ..errors import HSError
from ..events import EventHub
from ..schemas.models import (EvHistoryChanged, HistoryPage, HistoryRecord, HistorySyncResponse, Mutation, ProgressRequest, SourceKind)
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
