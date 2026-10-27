import json
import sys
from pathlib import Path
import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from helixsight.config import Settings
from helixsight.ingestion.http_util import RateLimiter
from helixsight.main import create_app
from helixsight.ml.registry import ModelBundle

def make_seq(n: int, gc: float, seed: int) -> str:
    rng = np.random.default_rng(seed)
    p = [(1 - gc) / 2, gc / 2, gc / 2, (1 - gc) / 2]
    return "".join(rng.choice(list("ACGT"), size=n, p=p))

NCBI_SEQ = make_seq(3000, 0.45, 1)
NCBI_SEQ2 = make_seq(2000, 0.5, 2)
WRAP = lambda s: "\n".join(s[i:i + 70] for i in range(0, len(s), 70))

def fake_network(calls: list, state: dict):
    known = {"NM_000001": ("NM_000001.2", NCBI_SEQ), "NM_000001.2": ("NM_000001.2", NCBI_SEQ),
             "NM_000002": ("NM_000002.1", NCBI_SEQ2), "NM_000003": ("NM_000003.1", NCBI_SEQ2)}
    pdb_entities = {
        "1BNA": {"1": ("polydeoxyribonucleotide", "CGCGAATTCGCG", "DNA (5'-D(*CP*GP*CP*G)-3')")},
        "2MIX": {"1": ("polypeptide(L)", "MKVL", "A protein"), "2": ("polydeoxyribonucleotide", "ACGTACGTAC", "A DNA")},
        "3PRO": {"1": ("polypeptide(L)", "MKVL", "Only protein")},
    }

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        path, params = req.url.path, dict(req.url.params)
        if "eutils" in str(req.url):
            acc = params.get("id", "")
            if acc == "NM_000003": return httpx.Response(429, headers={"Retry-After": "0"})
            if acc == "NM_000002" and state.setdefault("flaky", 0) < 2:
                state["flaky"] += 1
                return httpx.Response(429, headers={"Retry-After": "0"})
            if path.endswith("esummary.fcgi"):
                if acc not in known: return httpx.Response(200, json={"result": {"uids": []}})
                ver, s = known[acc]
                return httpx.Response(200, json={"result": {"uids": ["77"], "77": {
                    "uid": "77", "accessionversion": ver, "title": "Test gene", "organism": "Homo sapiens", "slen": len(s)}}})
            if acc not in known: return httpx.Response(200, text="Error: no such id")
            ver, s = known[acc]
            return httpx.Response(200, text=f">{ver} Homo sapiens test gene\n{WRAP(s)}\n")
        if "/core/entry/" in path:
            pid = path.rsplit("/", 1)[-1]
            if pid not in pdb_entities: return httpx.Response(404)
            return httpx.Response(200, json={"struct": {"title": "Test entry"}, "exptl": [{"method": "X-RAY DIFFRACTION"}],
                                             "rcsb_entry_container_identifiers": {"polymer_entity_ids": list(pdb_entities[pid])}})
        if "/core/polymer_entity/" in path:
            _, pid, eid = path.rsplit("/", 2)
            typ, seq, desc = pdb_entities[pid][eid]
            return httpx.Response(200, json={"entity_poly": {"type": typ, "pdbx_seq_one_letter_code_can": seq},
                                             "rcsb_polymer_entity": {"pdbx_description": desc},
                                             "rcsb_entity_source_organism": [{"ncbi_scientific_name": "synthetic construct"}],
                                             "rcsb_polymer_entity_container_identifiers": {"auth_asym_ids": ["A", "B"]}})
        return httpx.Response(404)
    return handler

class StubRunner:
    model_version, win = "stub+0001", 1024
    def predict(self, x):
        probs = np.full((x.shape[0], 4, 1024), 0.1, np.float32)
        probs[:, 0] = 0.1 + 0.6 * x[:, 2]
        probs[:, 1] = 0.1 + 0.5 * x[:, 1]
        return probs, np.full((x.shape[0], 1024), 1.0 / 1024, np.float32)

STUB = ModelBundle(StubRunner(), "stub+0001", "stub", {"trained_on": "stub", "warning": "test model"})

def build_client(tmp_path, *, bundle=STUB, watch=False, calls=None, state=None):
    calls = calls if calls is not None else []
    s = Settings(_env_file=None, db_path=Path(":memory:"), watch_enabled=watch, watch_dir=tmp_path / "watch",
                 model_dir=tmp_path / "no-model", cors_origins="http://localhost:5173")
    app = create_app(s, http_transport=httpx.MockTransport(fake_network(calls, state if state is not None else {})), bundle=bundle)
    return TestClient(app, base_url="http://localhost:8000")

@pytest.fixture
def calls(): return []

@pytest.fixture
def client(tmp_path, calls):
    with build_client(tmp_path, calls=calls) as c:
        svc = c.app.state.services
        svc.ncbi.limiter, svc.ncbi.backoff = RateLimiter(10_000), 0.0
        svc.pdb.limiter, svc.pdb.backoff = RateLimiter(10_000), 0.0
        yield c

def ws_recv(ws):
    m = ws.receive()
    if m["type"] == "websocket.close": return "close", m.get("code")
    return ("b", m["bytes"]) if m.get("bytes") is not None else ("t", json.loads(m["text"]))
