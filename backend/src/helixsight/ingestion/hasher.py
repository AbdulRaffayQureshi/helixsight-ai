from __future__ import annotations
import hashlib

def sha256_canonical(residues: str) -> str:
    return hashlib.sha256(("hs1:" + residues).encode("utf-8")).hexdigest()
