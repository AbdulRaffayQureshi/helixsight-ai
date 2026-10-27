import asyncio
import hashlib
import duckdb
import numpy as np
import pytest
from helixsight.db import repo
from helixsight.db.duckdb_store import DuckStore
from helixsight.db.repo import CanonicalRecord, SourceMeta

def canon(res: str, name: str) -> CanonicalRecord:
    return CanonicalRecord(hashlib.sha256(("hs1:" + res).encode()).hexdigest(), res, "DNA", len(res),
                           100.0 * (res.count("G") + res.count("C")) / len(res),
                           res.count("A"), res.count("C"), res.count("G"), res.count("T"), 0, name, "test")

async def scenario() -> None:
    st = DuckStore(":memory:")
    st.open()
    rec = canon("ACGT" * 5000, "seqA")
    key = ("model+1", "0.1.0", "pppppppp")
    meta = SourceMeta("NCBI", "NM_004006.3", organism="Homo sapiens", accession_key="NM_004006",
                      resolved_acc="NM_004006.3", ttl_days=30, meta_json={"slen": 20000})
    r1 = await st.write_tx(lambda c: repo.ingest_one(c, rec, meta, key))
    r2 = await st.write_tx(lambda c: repo.ingest_one(c, rec, SourceMeta("PASTE"), key))
    assert (r1["sequence_existed"], r2["sequence_existed"]) == (False, True)
    assert r1["record"]["organism"] == "Homo sapiens"

    assert (await st.read(lambda c: repo.lookup_accession(c, "NCBI", "NM_004006")))["sha256"] == rec.sha256
    far = repo.utcnow().replace(year=2100)
    assert await st.read(lambda c: repo.lookup_accession(c, "NCBI", "NM_004006", far)) is None

    sync0 = await st.read(lambda c: repo.history_sync(c, 0))
    assert len(sync0["upserts"]) == 2 and sync0["latest_rev"] == 2

    planes = np.random.default_rng(1).random((13, 150_000)).astype(np.float32)
    planes[3, 10] = np.nan
    ov = planes[:, :100].copy()
    for codec in ("raw", "zstd"):
        k = (f"model+{codec}", "0.1.0", "h")
        put = lambda c: repo.put_analysis(c, sha256=rec.sha256, model_version=k[0], core_version=k[1], params_hash=k[2],
                                          params={"w": 20}, planes=planes, channel_ids=list(range(13)),
                                          anomaly_count=3, summary={"regions": []}, overview=ov, codec=codec)
        aid = await st.write_tx(put)
        assert aid == await st.write_tx(put)
        meta_row = await st.read(lambda c: repo.get_analysis_meta(c, rec.sha256, *k))
        assert meta_row["n_chunks"] == 3
        chunks = [(await st.read(lambda c: repo.get_chunk(c, aid, i, 13, codec)))[1] for i in range(3)]
        assert np.array_equal(np.concatenate(chunks, axis=1), planes, equal_nan=True)
        assert np.array_equal(await st.read(lambda c: repo.get_overview(c, aid, 13)), ov, equal_nan=True)

    after = await st.read(lambda c: repo.history_sync(c, sync0["latest_rev"]))
    assert len(after["upserts"]) == 2 and after["upserts"][0]["anomaly_count"] == 3

    sid = r1["record"]["scan_id"]
    m = await st.write_tx(lambda c: repo.add_mutation(c, scan_id=sid, sha256=rec.sha256, position=5, ref="A",
                                                      alt="G", deltas={"delta_tm_c": -1.2, "pathogenicity": 0.4}))
    page = await st.read(lambda c: repo.history_page(c))
    assert sorted(x["mutation_count"] for x in page) == [0, 1]
    assert (await st.write_tx(lambda c: repo.checkpoint(c, sid, 1234)))["last_scanned_pos"] == 1234
    with pytest.raises(duckdb.ConstraintException):
        await st.write_tx(lambda c: repo.add_mutation(c, scan_id=sid, sha256=rec.sha256, position=5, ref="A",
                                                      alt="G", deltas={"pathogenicity": 1.5}))
    assert len(await st.read(lambda c: repo.list_mutations(c, sid))) == 1
    assert await st.write_tx(lambda c: repo.delete_mutation(c, m["mutation_id"]))
    await st.write_tx(lambda c: repo.delete_history(c, sid))
    s2 = await st.read(lambda c: repo.history_sync(c, 0))
    assert len(s2["deleted"]) == 1 and len(s2["upserts"]) == 1
    assert all(v == 0 for v in (await st.read(repo.verify_integrity)).values())
    assert await st.write_tx(lambda c: repo.prune_stale_analyses(c, "model+raw", "0.1.0")) == 1
    assert all(v == 0 for v in (await st.read(repo.verify_integrity)).values())
    st.close()

def test_repository_end_to_end():
    asyncio.run(scenario())
