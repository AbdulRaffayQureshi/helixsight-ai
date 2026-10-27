from __future__ import annotations
import re
from typing import Optional
from ..db.repo import CanonicalRecord
from ..errors import HSError
from .hasher import sha256_canonical

_STRIP = re.compile(r"[\s\d*\-\ufeff]+")
_BAD = re.compile(r"[^ACGTRYSWKMBDHVN]")

def _split(text: str) -> list[tuple[Optional[str], list[tuple[int, int]]]]:
    recs: list[tuple[Optional[str], list[tuple[int, int]]]] = []
    header: Optional[str] = None
    spans: list[tuple[int, int]] = []
    pos = 0
    for line in text.split("\n"):
        start, pos = pos, pos + len(line) + 1
        if line.startswith(">"):
            recs.append((header, spans))
            header, spans = line[1:].strip(), []
        else:
            spans.append((start, start + len(line)))
    recs.append((header, spans))
    return recs

def _raw_offset(text: str, spans: list[tuple[int, int]], idx: int) -> Optional[int]:
    n = 0
    for s, e in spans:
        for j in range(s, e):
            if _STRIP.fullmatch(text[j]):
                continue
            if n == idx:
                return j
            n += 1
    return None

def canonicalize(text: str, *, label: Optional[str] = None, name_hint: Optional[str] = None,
                 max_bp: int = 5_000_000) -> tuple[list[CanonicalRecord], list[str]]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[CanonicalRecord] = []
    warnings: list[str] = []
    parsed = []
    for header, spans in _split(text):
        cleaned = _STRIP.sub("", "".join(text[s:e] for s, e in spans)).upper()
        if not cleaned:
            if header is not None:
                warnings.append(f"record {header.split(None, 1)[0] if header else 'unnamed'!r} is empty and was skipped")
            continue
        parsed.append((header, spans, cleaned))
    if not parsed:
        raise HSError("EMPTY_SEQUENCE", "No nucleotide residues found in the input")

    for header, spans, cleaned in parsed:
        molecule = "DNA"
        if "U" in cleaned and "T" not in cleaned:
            cleaned, molecule = cleaned.replace("U", "T"), "RNA"
        if len(cleaned) > max_bp:
            raise HSError("SEQUENCE_TOO_LONG", f"Sequence has {len(cleaned):,} bases; the limit is {max_bp:,}",
                          {"length": len(cleaned), "max": max_bp})
        bad = _BAD.search(cleaned)
        if bad:
            raise HSError("INVALID_IUPAC", f"Invalid nucleotide {bad.group()!r} at residue offset {bad.start()}",
                          {"offset": bad.start(), "raw_offset": _raw_offset(text, spans, bad.start()), "char": bad.group()})
        sha = sha256_canonical(cleaned)
        a, c, g, t = (cleaned.count(x) for x in "ACGT")
        acgt = a + c + g + t
        hdr_name, _, hdr_desc = (header or "").partition(" ")
        if header:
            name = hdr_name
            if label:
                name = label if len(parsed) == 1 else f"{label}:{hdr_name}"
        else:
            name = label or name_hint or f"pasted-{sha[:8]}"
        out.append(CanonicalRecord(sha, cleaned, molecule, len(cleaned), 100.0 * (g + c) / acgt if acgt else 0.0,
                                   a, c, g, t, len(cleaned) - acgt, name, hdr_desc.strip() or None))
    return out, warnings
