"""Pins backend canonicalization to docs/golden_vectors.json (the TypeScript twin is tested against the same file)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from helixsight.errors import HSError
from helixsight.ingestion.hasher import sha256_canonical
from helixsight.ingestion.sanitizer import canonicalize

GOLDEN_PATH = next(
    p / "docs" / "golden_vectors.json"
    for p in Path(__file__).resolve().parents
    if (p / "docs" / "golden_vectors.json").exists()
)
GOLDEN = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
CASES = GOLDEN["cases"]
FIELDS = (
    "display_name",
    "description",
    "molecule",
    "residues",
    "length",
    "gc_pct",
    "a",
    "c",
    "g",
    "t",
    "ambiguous",
    "sha256",
)


def test_vector_file_shape_and_coverage():
    assert GOLDEN["version"] == 1 and GOLDEN["hash_prefix"] == "hs1:"
    assert len(CASES) >= 20 and len({c["id"] for c in CASES}) == len(CASES)
    ok_cases = [c for c in CASES if c["expect"]["ok"]]
    codes = {c["expect"]["code"] for c in CASES if not c["expect"]["ok"]}
    assert codes == {"INVALID_IUPAC", "EMPTY_SEQUENCE", "SEQUENCE_TOO_LONG"}
    assert any(r["molecule"] == "RNA" for c in ok_cases for r in c["expect"]["records"])
    assert any(len(c["expect"]["records"]) > 1 for c in ok_cases)
    assert any(c["expect"]["warnings"] for c in ok_cases)
    assert any(r["ambiguous"] > 0 for c in ok_cases for r in c["expect"]["records"])
    assert any(
        c["expect"].get("detail", {})
        and c["expect"]["detail"].get("raw_offset") not in (None, c["expect"]["detail"].get("offset"))
        for c in CASES
        if not c["expect"]["ok"]
    )


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_python_canonicalizer_matches_golden(case):
    o = case["options"]
    kwargs = {"label": o["label"], "name_hint": o["name_hint"], "max_bp": o["max_bp"]}
    exp = case["expect"]
    if exp["ok"]:
        recs, warnings = canonicalize(case["input"], **kwargs)
        assert warnings == exp["warnings"]
        assert len(recs) == len(exp["records"])
        for got, want in zip(recs, exp["records"]):
            for f in FIELDS:
                assert getattr(got, f) == want[f], f"{case['id']}: field {f}"
            assert (
                got.sha256
                == hashlib.sha256(("hs1:" + got.residues).encode("utf-8")).hexdigest()
                == sha256_canonical(got.residues)
            )
    else:
        with pytest.raises(HSError) as e:
            canonicalize(case["input"], **kwargs)
        assert e.value.code == exp["code"] and e.value.detail == exp["detail"]
