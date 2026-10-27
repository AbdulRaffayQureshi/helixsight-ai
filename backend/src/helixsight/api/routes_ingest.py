from __future__ import annotations
from fastapi import APIRouter, Depends, File, UploadFile
from ..errors import HSError
from ..schemas.models import IngestResponse, NcbiIngestRequest, PasteIngestRequest, PdbIngestRequest
from ..services import Services
from .deps import get_services

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

@router.post("/ncbi", response_model=IngestResponse)
async def ingest_ncbi(req: NcbiIngestRequest, svc: Services = Depends(get_services)) -> IngestResponse:
    items, warnings = await svc.ingestor.ingest_ncbi(req)
    return IngestResponse(items=items, warnings=warnings)

@router.post("/pdb", response_model=IngestResponse)
async def ingest_pdb(req: PdbIngestRequest, svc: Services = Depends(get_services)) -> IngestResponse:
    items, warnings = await svc.ingestor.ingest_pdb(req)
    return IngestResponse(items=items, warnings=warnings)

@router.post("/paste", response_model=IngestResponse)
async def ingest_paste(req: PasteIngestRequest, svc: Services = Depends(get_services)) -> IngestResponse:
    items, warnings = await svc.ingestor.ingest_paste(req)
    return IngestResponse(items=items, warnings=warnings)

@router.post("/file", response_model=IngestResponse)
async def ingest_file(files: list[UploadFile] = File(...), svc: Services = Depends(get_services)) -> IngestResponse:
    limit = svc.settings.max_upload_mb * 1024 * 1024
    items, warnings = [], []
    for f in files:
        data = await f.read(limit + 1)
        if len(data) > limit:
            raise HSError("SEQUENCE_TOO_LONG", f"{f.filename} exceeds {svc.settings.max_upload_mb} MB")
        got, w = await svc.ingestor.ingest_file(f.filename or "upload.fasta", data)
        items += got
        warnings += [f"{f.filename}: {x}" for x in w]
    return IngestResponse(items=items, warnings=warnings)
