from __future__ import annotations
from typing import Any, Optional
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from .schemas.models import ErrorBody, ErrorCode

HTTP_STATUS: dict[str, int] = {
    "INVALID_ACCESSION": 422, "NCBI_NOT_FOUND": 404, "NCBI_RATE_LIMITED": 503, "UPSTREAM_TIMEOUT": 504,
    "PDB_NOT_FOUND": 404, "PDB_NO_NUCLEIC_ACID": 422, "INVALID_IUPAC": 422, "EMPTY_SEQUENCE": 422,
    "SEQUENCE_TOO_LONG": 413, "UNKNOWN_SEQUENCE": 404, "CORE_UNAVAILABLE": 503, "MODEL_UNAVAILABLE": 503,
    "PROTOCOL_ERROR": 400, "INTERNAL": 500,
}

class HSError(Exception):
    def __init__(self, code: ErrorCode, message: str, detail: Optional[dict[str, Any]] = None,
                 retry_after: Optional[float] = None) -> None:
        super().__init__(message)
        self.code, self.message, self.detail, self.retry_after = code, message, detail, retry_after

    @property
    def status(self) -> int:
        return HTTP_STATUS[self.code]

    def body(self) -> ErrorBody:
        return ErrorBody(code=self.code, message=self.message, detail=self.detail)

def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(HSError)
    async def _hs(_: Request, exc: HSError) -> JSONResponse:
        headers = {"Retry-After": str(int(exc.retry_after) + 1)} if exc.retry_after else None
        return JSONResponse(exc.body().model_dump(mode="json"), status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _val(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = {str(p) for e in exc.errors() for p in e.get("loc", ())}
        code: ErrorCode = "INVALID_ACCESSION" if fields & {"accession", "pdb_id"} else "PROTOCOL_ERROR"
        body = ErrorBody(code=code, message="Request validation failed",
                         detail={"errors": [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]})
        return JSONResponse(body.model_dump(mode="json"), status_code=422)
