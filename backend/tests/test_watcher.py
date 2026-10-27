import time
import pytest
from conftest import build_client, make_seq, ws_recv
from helixsight.config import Settings

def wait_for(fn, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v: return v
        time.sleep(0.1)
    raise AssertionError("timed out")

@pytest.mark.parametrize("polling", [False, True])
def test_watched_folder_ingest_events_dedup_and_failures(tmp_path, monkeypatch, polling):
    if polling:
        monkeypatch.setattr(Settings, "watch_uses_polling", property(lambda s: True))
    watch = tmp_path / "watch"
    watch.mkdir()
    (watch / "preexisting.fa").write_text(f">pre\n{make_seq(400, .5, 31)}\n")
    with build_client(tmp_path, watch=True) as c:
        with c.websocket_connect("/ws/events") as ev:
            kind, status = ws_recv(ev)
            assert status["type"] == "watcher_status" and status["watching"] and status["mode"] == ("polling" if polling else "inotify")
            wait_for(lambda: len(c.get("/api/history").json()["items"]) == 1)
            assert ws_recv(ev)[1]["type"] in ("watcher_status", "history_changed", "ingest_complete")

            body = f">dropped one\n{make_seq(600, .4, 32)}\n"
            (watch / "dropped.fasta").write_text(body)
            (watch / "bad.fna").write_text(">x\nACGT ACZT\n")
            (watch / "ignored.pdf").write_text("nope")
            (watch / ".hidden.fa").write_text("ACGT")
            seen = []
            for _ in range(40):
                k, m = ws_recv(ev)
                seen.append(m["type"])
                if m["type"] == "ingest_complete" and m["item"]["record"]["display_name"] == "dropped":
                    break
            names = {i["display_name"] for i in c.get("/api/history").json()["items"]}
            assert names == {"pre", "dropped"} and "ingest_complete" in seen

            def _notice():
                for _ in range(20):
                    k, m = ws_recv(ev)
                    seen.append(m["type"])
                    if m["type"] == "server_notice": return True
                return False
            assert wait_for(lambda: "server_notice" in seen or _notice())

            n = len(c.get("/api/history").json()["items"])
            svc = c.app.state.services
            c.portal.call(svc.watcher._process, watch / "dropped.fasta")
            assert len(c.get("/api/history").json()["items"]) == n
            (watch / "dropped.fasta").write_text(body + "\n")
            wait_for(lambda: len(c.get("/api/history").json()["items"]) == n + 1)
            newest = c.get("/api/history").json()["items"][0]
            assert newest["display_name"] == "dropped" and newest["source"] == "FILE"
