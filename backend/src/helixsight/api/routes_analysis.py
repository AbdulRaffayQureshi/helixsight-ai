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
    if format == "u8":
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
