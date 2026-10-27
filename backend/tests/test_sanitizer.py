import pytest
from helixsight.errors import HSError
from helixsight.ingestion.hasher import sha256_canonical
from helixsight.ingestion.sanitizer import canonicalize

def one(text, **kw):
    recs, warns = canonicalize(text, **kw)
    assert len(recs) == 1
    return recs[0], warns

def test_raw_lowercase_numbers_and_whitespace():
    rec, _ = one("  1 atgcatgc 9 ttgacc\n 21 gg*\r\n")
    assert rec.residues == "ATGCATGCTTGACCGG" and rec.length == 16 and rec.molecule == "DNA"
    assert rec.display_name == f"pasted-{rec.sha256[:8]}" and rec.sha256 == sha256_canonical(rec.residues)

def test_fasta_header_label_and_rna():
    rec, _ = one(">NM_1.2 Homo sapiens gene\nAUGCAUGC\n")
    assert (rec.display_name, rec.description, rec.molecule, rec.residues) == ("NM_1.2", "Homo sapiens gene", "RNA", "ATGCATGC")
    rec2, _ = one(">x desc\nACGT\n", label="mine")
    assert rec2.display_name == "mine"

def test_multi_fasta_empty_record_warning_and_label_prefix():
    recs, warns = canonicalize(">a\nACGT\n>empty\n>b\nTTGG\n", label="L")
    assert [r.display_name for r in recs] == ["L:a", "L:b"] and len(warns) == 1 and "empty" in warns[0]

def test_iupac_counts_gc_and_same_sha_across_sources():
    rec, _ = one("GGCCNNAATT")
    assert (rec.g, rec.c, rec.ambiguous, round(rec.gc_pct, 6)) == (2, 2, 2, 50.0)
    assert one(">whatever\nggcc nnaatt")[0].sha256 == rec.sha256

def test_invalid_char_reports_cleaned_and_raw_offsets():
    text = ">h\nAC GT\n 5 AZGT\n"
    with pytest.raises(HSError) as e:
        canonicalize(text)
    assert e.value.code == "INVALID_IUPAC" and e.value.detail["offset"] == 5 and e.value.detail["char"] == "Z"
    assert text[e.value.detail["raw_offset"]] == "Z"

def test_mixed_u_and_t_is_invalid_and_limits():
    with pytest.raises(HSError) as e:
        canonicalize("ACGU ACGT")
    assert e.value.code == "INVALID_IUPAC" and e.value.detail["char"] == "U"
    with pytest.raises(HSError) as e:
        canonicalize("ACGT" * 10, max_bp=20)
    assert e.value.code == "SEQUENCE_TOO_LONG"
    for blank in ("", "   \n 12 34 \n", ">only header\n"):
        with pytest.raises(HSError) as e:
            canonicalize(blank)
        assert e.value.code == "EMPTY_SEQUENCE"
