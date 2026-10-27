from __future__ import annotations
import asyncio
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional
import httpx
from ..errors import HSError
from .http_util import RateLimiter, get_with_retry

DATA = "https://data.rcsb.org/rest/v1/core"
FASTA = "https://www.rcsb.org/fasta/entry"

@dataclass(frozen=True, slots=True)
class PdbEntity:
    entity_id: int
    kind: Literal["nucleic", "protein", "other"]
    poly_type: str
    description: str
    organism: Optional[str]
    chains: list[str]
    sequence: str

def _kind(poly_type: str) -> str:
    t = poly_type.lower()
    if "ribonucleotide" in t: return "nucleic"
    return "protein" if t.startswith("polypeptide") else "other"

class PdbClient:
    def __init__(self, http: httpx.AsyncClient, *, retries: int = 3, backoff: float = 0.5,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        self.http, self.retries, self.backoff, self.sleep = http, retries, backoff, sleep
        self.limiter = RateLimiter(5.0)

    async def _get(self, url: str) -> httpx.Response:
        return await get_with_retry(self.http, url, limiter=self.limiter, retries=self.retries, backoff=self.backoff,
                                    sleep=self.sleep, service="RCSB PDB")

    async def entry(self, pdb_id: str) -> dict[str, Any]:
        r = await self._get(f"{DATA}/entry/{pdb_id}")
        if r.status_code != 200:
            raise HSError("PDB_NOT_FOUND", f"No PDB entry {pdb_id!r}", {"pdb_id": pdb_id})
        return r.json()

    async def _fasta_sequence(self, pdb_id: str, entity_id: int) -> str:
        r = await self._get(f"{FASTA}/{pdb_id}")
        if r.status_code != 200: return ""
        for block in r.text.split(">")[1:]:
            head, _, body = block.partition("\n")
            if re.match(rf"^{re.escape(pdb_id)}_{entity_id}\|", head, re.I):
                return "".join(body.split())
        return ""

    async def entity(self, pdb_id: str, entity_id: int) -> PdbEntity:
        r = await self._get(f"{DATA}/polymer_entity/{pdb_id}/{entity_id}")
        if r.status_code == 404:
            raise HSError("PDB_NOT_FOUND", f"PDB entry {pdb_id!r} has no polymer entity {entity_id}",
                          {"pdb_id": pdb_id, "entity_id": entity_id})
        j = r.json()
        poly = j.get("entity_poly", {})
        ptype = poly.get("type", "")
        seq = "".join((poly.get("pdbx_seq_one_letter_code_can") or "").split())
        if not seq:
            seq = await self._fasta_sequence(pdb_id, entity_id)
        src = (j.get("rcsb_entity_source_organism") or [{}])[0]
        chains = (j.get("rcsb_polymer_entity_container_identifiers") or {}).get("auth_asym_ids", [])
        return PdbEntity(entity_id, _kind(ptype), ptype, (j.get("rcsb_polymer_entity") or {}).get("pdbx_description", ""),
                         src.get("ncbi_scientific_name"), list(chains), seq)

    async def entities(self, pdb_id: str) -> tuple[dict[str, Any], list[PdbEntity]]:
        entry = await self.entry(pdb_id)
        ids = (entry.get("rcsb_entry_container_identifiers") or {}).get("polymer_entity_ids")
        if not ids:
            n = (entry.get("rcsb_entry_info") or {}).get("polymer_entity_count", 0)
            ids = [str(i) for i in range(1, int(n) + 1)]
        ents = await asyncio.gather(*(self.entity(pdb_id, int(i)) for i in ids))
        return entry, list(ents)

def select_entities(entities: list[PdbEntity], entity_id: Optional[int], all_nucleic: bool,
                    pdb_id: str) -> tuple[list[PdbEntity], list[str]]:
    listing = [{"entity_id": e.entity_id, "type": e.poly_type, "description": e.description} for e in entities]
    if entity_id is not None:
        match = next((e for e in entities if e.entity_id == entity_id), None)
        if match is None:
            raise HSError("PDB_NOT_FOUND", f"PDB entry {pdb_id!r} has no polymer entity {entity_id}", {"entities": listing})
        if match.kind != "nucleic":
            raise HSError("PDB_NO_NUCLEIC_ACID", f"Entity {entity_id} of {pdb_id} is {match.poly_type or 'not a nucleic acid'}",
                          {"entities": listing})
        chosen = [match]
    else:
        nucleic = [e for e in entities if e.kind == "nucleic"]
        if not nucleic:
            raise HSError("PDB_NO_NUCLEIC_ACID", f"PDB entry {pdb_id} contains no DNA/RNA entity",
                          {"entities": listing})
        chosen = nucleic if all_nucleic else nucleic[:1]
    warnings = [f"entity {e.entity_id} skipped: {e.poly_type or 'unknown type'}" for e in entities if e not in chosen]
    return chosen, warnings
