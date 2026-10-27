import json
import numpy as np
import pytest
from conftest import NCBI_SEQ, make_seq

def paste(client, text, label=None):
    return client.post("/api/ingest/paste", json={"text": text, "label": label})

def test_paste_dedup_history_and_errors(client):
    seq = make_seq(500, 0.5, 5)
    r1 = paste(client, f">demo\n{seq}\n").json()
    r2 = paste(client, seq.lower()).json()
    assert [r1["items"][0]["cache_status"], r2["items"][0]["cache_status"]] == ["MISS_STORED", "HIT_SHA"]
    assert r1["items"][0]["sha256"] == r2["items"][0]["sha256"] and r1["items"][0]["record"]["created_at"].endswith("Z")
    assert r1["items"][0]["record"]["source"] == "PASTE" and r1["items"][0]["record"]["length"] == 500

    sync = client.get("/api/history/sync", params={"since_rev": 0}).json()
    assert len(sync["upserts"]) == 2 and sync["latest_rev"] == max(u["rev"] for u in sync["upserts"])
    assert client.get("/api/history/sync", params={"since_rev": sync["latest_rev"]}).json()["upserts"] == []

    bad = paste(client, "ACGT ACZT")
    assert bad.status_code == 422 and bad.json()["code"] == "INVALID_IUPAC" and bad.json()["detail"]["char"] == "Z"
    assert paste(client, ">only a header").json()["code"] == "EMPTY_SEQUENCE"
    v = client.post("/api/ingest/ncbi", json={"accession": "!!"})
    assert v.status_code == 422 and v.json()["code"] == "INVALID_ACCESSION"
    assert client.post("/api/ingest/paste", json={"text": "ACGT", "bogus": 1}).json()["code"] == "PROTOCOL_ERROR"

def test_ncbi_cache_flow_and_errors(client, calls):
    r = client.post("/api/ingest/ncbi", json={"accession": "nm_000001"})
    item = r.json()["items"][0]
    assert r.status_code == 200 and item["cache_status"] == "MISS_STORED"
    assert item["record"]["accession"] == "NM_000001.2" and item["record"]["organism"] == "Homo sapiens"
    assert item["record"]["display_name"] == "NM_000001.2" and len(calls) == 2
    again = client.post("/api/ingest/ncbi", json={"accession": "NM_000001"}).json()["items"][0]
    assert again["cache_status"] == "HIT_ACCESSION" and len(calls) == 2
    alias = client.post("/api/ingest/ncbi", json={"accession": "NM_000001.2"}).json()["items"][0]
    assert alias["cache_status"] == "HIT_ACCESSION" and len(calls) == 2
    assert paste(client, NCBI_SEQ).json()["items"][0]["cache_status"] == "HIT_SHA"
    forced = client.post("/api/ingest/ncbi", json={"accession": "NM_000001", "force_refresh": True}).json()["items"][0]
    assert forced["cache_status"] == "HIT_SHA" and len(calls) == 4

    nf = client.post("/api/ingest/ncbi", json={"accession": "NM_999999"})
    assert nf.status_code == 404 and nf.json()["code"] == "NCBI_NOT_FOUND"
    flaky = client.post("/api/ingest/ncbi", json={"accession": "NM_000002"})
    assert flaky.status_code == 200
    rl = client.post("/api/ingest/ncbi", json={"accession": "NM_000003"})
    assert rl.status_code == 503 and rl.json()["code"] == "NCBI_RATE_LIMITED" and "retry-after" in rl.headers

def test_ncbi_offline_serves_expired_cache(client, calls):
    from helixsight.db import repo
    svc = client.app.state.services
    client.post("/api/ingest/ncbi", json={"accession": "NM_000001"})
    past = repo.utcnow().replace(year=2000)
    svc.store._con.cursor().execute("UPDATE accession_index SET ttl_expires_at = ? WHERE accession_key = 'NM_000001'", [past])
    svc.ncbi.retries = 1
    
    async def _raise_timeout(request):
        import httpx
        raise httpx.ConnectTimeout("down")
    async def _noop():
        return None
    
    svc.http._transport = type("Down", (), {"handle_async_request": staticmethod(_raise_timeout),
                                            "aclose": staticmethod(_noop)})()
    r = client.post("/api/ingest/ncbi", json={"accession": "NM_000001"}).json()
    assert r["items"][0]["cache_status"] == "HIT_ACCESSION" and "locally cached" in r["warnings"][0]

def test_pdb_lane(client, calls):
    r = client.post("/api/ingest/pdb", json={"pdb_id": "1bna"}).json()
    it = r["items"][0]
    assert it["cache_status"] == "MISS_STORED" and it["record"]["length"] == 12 and it["record"]["accession"] == "1BNA"
    n = len(calls)
    assert client.post("/api/ingest/pdb", json={"pdb_id": "1BNA"}).json()["items"][0]["cache_status"] == "HIT_ACCESSION"
    assert len(calls) == n
    mix = client.post("/api/ingest/pdb", json={"pdb_id": "2MIX"}).json()
    assert mix["items"][0]["record"]["length"] == 10 and "entity 1 skipped" in mix["warnings"][0]
    prot = client.post("/api/ingest/pdb", json={"pdb_id": "3PRO"})
    assert prot.status_code == 422 and prot.json()["code"] == "PDB_NO_NUCLEIC_ACID"
    assert prot.json()["detail"]["entities"][0]["type"] == "polypeptide(L)"
    assert client.post("/api/ingest/pdb", json={"pdb_id": "9ZZZ"}).json()["code"] == "PDB_NOT_FOUND"
    assert client.post("/api/ingest/pdb", json={"pdb_id": "2MIX", "entity_id": 1}).json()["code"] == "PDB_NO_NUCLEIC_ACID"

def test_file_upload_history_paging_delete_and_mutations(client):
    files = [("files", ("a.fasta", f">ga\n{make_seq(300, .5, 7)}\n", "text/plain")),
             ("files", ("plain.txt", make_seq(200, .4, 8), "text/plain"))]
    r = client.post("/api/ingest/file", files=files).json()
    assert [i["record"]["display_name"] for i in r["items"]] == ["ga", "plain"] and r["items"][0]["record"]["source"] == "FILE"
    page = client.get("/api/history", params={"limit": 1}).json()
    assert len(page["items"]) == 1 and page["next_cursor"]
    page2 = client.get("/api/history", params={"limit": 5, "cursor": page["next_cursor"]}).json()
    assert len(page2["items"]) == 1 and page2["next_cursor"] is None
    assert len(client.get("/api/history", params={"q": "plain"}).json()["items"]) == 1
    assert client.get("/api/history", params={"source": "PDB"}).json()["items"] == []

    rec = r["items"][0]["record"]
    sha = rec["sha256"]
    seqj = client.get(f"/api/sequences/{sha}").json()
    assert seqj["length"] == 300
    u8 = client.get(f"/api/sequences/{sha}", params={"format": "u8"})
    assert len(u8.content) == 300 and set(np.frombuffer(u8.content, np.uint8)) <= {0, 1, 2, 3}
    assert client.get("/api/sequences/" + "0" * 64).status_code == 404

    cp = client.post(f"/api/history/{rec['scan_id']}/progress", json={"last_scanned_pos": 123}).json()
    assert cp["last_scanned_pos"] == 123
    m = client.post(f"/api/sequences/{sha}/mutations", json={"request_id": "r1", "scan_id": rec["scan_id"], "position": 10, "alt": "G"})
    mj = m.json()
    assert m.status_code == 200 and mj["alt"] == "G" and mj["ref"] in "ACGT" and mj["delta_dg_kcal"] is not None
    assert 0 <= mj["pathogenicity"] < 1 and mj["delta_p_promoter"] is not None
    assert client.get(f"/api/history/{rec['scan_id']}").json()["mutation_count"] == 1
    assert len(client.get(f"/api/history/{rec['scan_id']}/mutations").json()) == 1
    bad = client.post(f"/api/sequences/{sha}/mutations", json={"request_id": "r", "scan_id": rec["scan_id"], "position": 9999, "alt": "A"})
    assert bad.status_code == 400 and bad.json()["code"] == "PROTOCOL_ERROR"
    assert client.delete(f"/api/mutations/{mj['mutation_id']}").status_code == 204
    assert client.delete(f"/api/mutations/{mj['mutation_id']}").status_code == 404

    since = client.get("/api/history/sync", params={"since_rev": 0}).json()["latest_rev"]
    assert client.delete(f"/api/history/{rec['scan_id']}").status_code == 204
    sync = client.get("/api/history/sync", params={"since_rev": since}).json()
    assert sync["deleted"] == [rec["scan_id"]] and client.get(f"/api/history/{rec['scan_id']}").status_code == 404
    assert client.get("/api/health", params={"deep": True}).json()["integrity"] == {k: 0 for k in client.get("/api/health", params={"deep": True}).json()["integrity"]}

def test_health_reports_degraded_without_model(tmp_path):
    from conftest import build_client
    from helixsight.ml.registry import ModelBundle
    with build_client(tmp_path, bundle=ModelBundle(None)) as c:
        h = c.get("/api/health").json()
        assert h["status"] == "degraded" and h["model_available"] is False and h["core_available"] is True
