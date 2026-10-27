from __future__ import annotations
import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional
import httpx
from ..errors import HSError
from .http_util import RateLimiter, get_with_retry

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

@dataclass(frozen=True, slots=True)
class NcbiSummary:
    uid: str
    accessionversion: str
    title: str
    organism: Optional[str]
    slen: Optional[int]

class NcbiClient:
    def __init__(self, http: httpx.AsyncClient, *, tool: str = "helixsight", email: str = "", api_key: str = "",
                 retries: int = 3, backoff: float = 0.5, limiter: Optional[RateLimiter] = None,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        self.http, self.tool, self.email, self.api_key = http, tool, email, api_key
        self.retries, self.backoff, self.sleep = retries, backoff, sleep
        self.limiter = limiter or RateLimiter(10.0 if api_key else 3.0)

    def _params(self, **extra: str) -> dict[str, str]:
        p = {"tool": self.tool, **extra}
        if self.email:
            p["email"] = self.email
        if self.api_key:
            p["api_key"] = self.api_key
        return p

    async def _get(self, endpoint: str, **params: str) -> httpx.Response:
        return await get_with_retry(self.http, f"{BASE}/{endpoint}", params=self._params(**params), limiter=self.limiter,
                                    retries=self.retries, backoff=self.backoff, sleep=self.sleep, service="NCBI",
                                    rate_code="NCBI_RATE_LIMITED")

    async def esummary(self, accession: str) -> NcbiSummary:
        r = await self._get("esummary.fcgi", db="nuccore", id=accession, retmode="json")
        try:
            data = r.json()
            result = data["result"]
            uids = result.get("uids", [])
            rec = result[uids[0]] if uids else None
        except (ValueError, KeyError, TypeError):
            rec = None
        if not rec or "error" in rec or not rec.get("accessionversion"):
            raise HSError("NCBI_NOT_FOUND", f"NCBI has no nucleotide record for {accession!r}", {"accession": accession})
        return NcbiSummary(str(rec.get("uid", uids[0])), rec["accessionversion"], rec.get("title", ""),
                           rec.get("organism"), int(rec["slen"]) if rec.get("slen") is not None else None)

    async def efetch_fasta(self, accession: str) -> str:
        r = await self._get("efetch.fcgi", db="nuccore", id=accession, rettype="fasta", retmode="text")
        text = r.text if r.status_code == 200 else ""
        if not text.lstrip().startswith(">"):
            raise HSError("NCBI_NOT_FOUND", f"NCBI returned no FASTA for {accession!r}", {"accession": accession})
        return text
