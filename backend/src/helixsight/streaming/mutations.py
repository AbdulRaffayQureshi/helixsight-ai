from __future__ import annotations
import asyncio
from typing import Any, Optional
import numpy as np
from ..core_bridge import native
from ..db import queries as q
from ..db import repo
from ..errors import HSError
from ..ml.pathogenicity import score_mutation
from ..schemas.models import Mutation
from ..services import Services

_NAN = float("nan")

async def load_codes(svc: Services, sha256: str) -> np.ndarray:
    codes = svc.codes_cache.get(sha256)
    if codes is None:
        seq = await svc.store.read(lambda c: q.get_sequence(c, sha256))
        if seq is None:
            raise HSError("UNKNOWN_SEQUENCE", f"Unknown sequence {sha256[:8]}", {"sha256": sha256})
        codes = await asyncio.to_thread(native.encode, seq["residues"])
        svc.codes_cache.put(sha256, codes)
    return codes

def mutation_from_row(row: dict[str, Any]) -> Mutation:
    return Mutation.model_validate({**row, "ref": row["ref_base"], "alt": row["alt_base"]})

def _clean(d: dict[str, Any]) -> dict[str, Optional[float]]:
    return {k: (None if v is None or not np.isfinite(v) else float(v)) for k, v in d.items()}

def _score(svc: Services, codes: np.ndarray, pos: int, alt_code: int) -> dict[str, Optional[float]]:
    p = svc.core_params

    def thermo(c: np.ndarray, i: int) -> tuple[float, float]:
        try:
            r = native.local_thermo(c, i, p)
        except native.CoreUnavailableError:
            r = None
        return r if r is not None else (_NAN, _NAN)

    runner = svc.bundle.runner
    if runner is not None:
        return _clean(score_mutation(runner, codes, pos, alt_code, thermo))
    alt = codes.copy()
    alt[pos] = alt_code
    (tm_r, dg_r), (tm_a, dg_a) = thermo(codes, pos), thermo(alt, pos)
    return _clean({"delta_tm_c": tm_a - tm_r, "delta_dg_kcal": dg_a - dg_r, "pathogenicity": None})

async def apply_mutation(svc: Services, *, scan_id: str, position: int, alt: str,
                         sha256: Optional[str] = None) -> Mutation:
    hist = await svc.store.read(lambda c: q.get_history(c, scan_id))
    if hist is None or (sha256 is not None and hist["sha256"] != sha256):
        raise HSError("UNKNOWN_SEQUENCE", f"Unknown scan {scan_id!r} for this sequence", {"scan_id": scan_id})
    codes = await load_codes(svc, hist["sha256"])
    if position >= len(codes):
        raise HSError("PROTOCOL_ERROR", f"position {position} is outside the sequence ({len(codes)} bp)")
    ref = "ACGTN"[int(codes[position])]
    deltas = await asyncio.to_thread(_score, svc, codes, position, "ACGT".index(alt))
    row = await svc.store.write_tx(lambda c: repo.add_mutation(c, scan_id=scan_id, sha256=hist["sha256"], position=position,
                                                              ref=ref, alt=alt, deltas=deltas))
    return mutation_from_row(row)
