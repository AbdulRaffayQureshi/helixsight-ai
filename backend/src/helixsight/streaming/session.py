from __future__ import annotations
import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Optional
import numpy as np
from pydantic import BaseModel, TypeAdapter, ValidationError
from starlette.websockets import WebSocket
from ..core_bridge import native
from ..db import queries as q
from ..db import repo
from ..errors import HSError
from ..ids import uuid7
from ..ml.anomaly import anomaly_scores, regions, to_position_scores
from ..ml.anomaly_kind import region_kind
from ..ml.inference import predict_sequence
from ..schemas.models import (CONTRACT_VERSION, ClientMsg, ErrorBody, EvHistoryChanged, ModelScope, WsAck,
                              WsAnomalyAlert, WsCheckpoint, WsError, WsHello, WsHelloAck, WsMutate, WsMutationResult,
                              WsPing, WsPong, WsProgress, WsScanComplete, WsScanReady, WsStartScan, WsStop)
from ..services import Services
from . import framing as fr
from .mutations import apply_mutation
from .params import build_params
from .scheduler import AckWindow, SlowClient

log = logging.getLogger("helixsight.session")
_ADAPTER = TypeAdapter(ClientMsg)
IDLE_TIMEOUT_S = 45.0

class ScanSession:
    CHUNK = 256
    def __init__(self, ws: WebSocket, svc: Services) -> None:
        self.ws, self.svc, self.id = ws, svc, uuid7()
        self.window = AckWindow()
        self._lock = asyncio.Lock()
        self._scan_task: Optional[asyncio.Task] = None
        self._tasks: set[asyncio.Task] = set()
        self._hello = False

    async def _json(self, msg: BaseModel) -> None:
        async with self._lock: await self.ws.send_text(msg.model_dump_json())

    async def _bytes(self, data: bytes) -> None:
        async with self._lock: await self.ws.send_bytes(data)

    async def _error(self, code: str, message: str, fatal: bool = False, detail: Optional[dict] = None) -> None:
        await self._json(WsError(error=ErrorBody(code=code, message=message, detail=detail), fatal=fatal)) # type: ignore

    async def run(self) -> None:
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(self.ws.receive(), IDLE_TIMEOUT_S)
                except asyncio.TimeoutError:
                    await self.ws.close(code=4408)
                    return
                if msg["type"] == "websocket.disconnect": return
                text = msg.get("text")
                try:
                    if text is None: raise ValueError("binary frames are not accepted")
                    m = _ADAPTER.validate_json(text)
                except (ValidationError, ValueError) as e:
                    await self._error("PROTOCOL_ERROR", f"Invalid message: {str(e)[:200]}", fatal=True)
                    await self.ws.close(code=4400)
                    return
                if not await self._dispatch(m): return
        finally:
            for t in [self._scan_task, *self._tasks]:
                if t and not t.done(): t.cancel()

    async def _dispatch(self, m: Any) -> bool:
        if isinstance(m, WsHello):
            if m.contract != CONTRACT_VERSION:
                await self._error("PROTOCOL_ERROR", f"contract {m.contract} != {CONTRACT_VERSION}", fatal=True)
                await self.ws.close(code=4400)
                return False
            self._hello = True
            await self._json(WsHelloAck(session_id=self.id, contract=CONTRACT_VERSION, core_version=native.CORE_VERSION,
                                        model_version=self.svc.bundle.model_version))
            return True
        if not self._hello:
            await self._error("PROTOCOL_ERROR", "send `hello` first", fatal=True)
            await self.ws.close(code=4400)
            return False
        if isinstance(m, WsPing): await self._json(WsPong(t=m.t))
        elif isinstance(m, WsAck): await self.window.ack(m.stream_seq)
        elif isinstance(m, WsStartScan):
            if self._scan_task and not self._scan_task.done(): self._scan_task.cancel()
            self._scan_task = asyncio.create_task(self._scan_guard(m))
        elif isinstance(m, WsStop):
            if self._scan_task and not self._scan_task.done(): self._scan_task.cancel()
        elif isinstance(m, WsCheckpoint): self._spawn(self._checkpoint(m))
        elif isinstance(m, WsMutate): self._spawn(self._mutate(m))
        return True

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def _checkpoint(self, m: WsCheckpoint) -> None:
        row = await self.svc.store.write_tx(lambda c: repo.checkpoint(c, m.scan_id, m.last_scanned_pos))
        if row is None: await self._error("UNKNOWN_SEQUENCE", f"Unknown scan {m.scan_id!r}")
        else: await self.svc.hub.publish(EvHistoryChanged(latest_rev=int(row["rev"])))

    async def _mutate(self, m: WsMutate) -> None:
        try:
            mut = await apply_mutation(self.svc, scan_id=m.scan_id, position=m.position, alt=m.alt)
            await self._json(WsMutationResult(request_id=m.request_id, mutation=mut))
            await self.svc.hub.publish(EvHistoryChanged(latest_rev=await self.svc.store.read(_latest_rev)))
        except HSError as e:
            await self._error(e.code, e.message, detail={**(e.detail or {}), "request_id": m.request_id})
        except Exception:
            await self._error("INTERNAL", "Mutation failed", detail={"request_id": m.request_id})

    async def _scan_guard(self, m: WsStartScan) -> None:
        try:
            await self._scan(m)
        except asyncio.CancelledError: raise
        except HSError as e: await self._error(e.code, e.message, detail=e.detail)
        except SlowClient: await self.ws.close(code=4409)
        except Exception: await self._error("INTERNAL", "Scan failed")

    async def _compute(self, seq: dict, L: int):
        svc, cp = self.svc, self.svc.core_params
        codes = await asyncio.to_thread(native.encode, seq["residues"])
        svc.codes_cache.put(seq["sha256"], codes)
        planes = native.alloc_planes(L)
        counts = None
        try:
            counts = await native.compute_core_channels_async(codes, planes, cp)
        except native.CoreUnavailableError as e:
            await self._error("CORE_UNAVAILABLE", f"{e}")
        runner = svc.bundle.runner
        if runner is None:
            await self._error("MODEL_UNAVAILABLE", "No model is installed")
        else:
            probs, attn = await asyncio.to_thread(predict_sequence, codes, runner)
            planes[7], planes[8:12] = attn, probs
            planes[7:12, codes == 4] = np.nan
        regs: list[dict] = []
        if counts is not None:
            z_win, _ = await asyncio.to_thread(anomaly_scores, counts)
            planes[12] = to_position_scores(z_win, L, cp.kmer_window, cp.kmer_stride)
            for s, e, z in regions(z_win, L, cp.kmer_window, cp.kmer_stride):
                kind = region_kind(codes, counts, s, e, stride=cp.kmer_stride, global_gc=float(seq["gc_pct"]))
                regs.append({"start": s, "end": e, "score": min(1.0, z / 7.0), "kind": kind})
        overview, _ = fr.make_overview(planes)
        return planes, regs, overview

    async def _scan(self, m: WsStartScan) -> None:
        t0, svc = time.monotonic(), self.svc
        seq = await svc.store.read(lambda c: q.get_sequence(c, m.sha256))
        if seq is None:
            raise HSError("UNKNOWN_SEQUENCE", f"Unknown sequence {m.sha256[:8]}; ingest it first", {"sha256": m.sha256})
        L = int(seq["length"])
        params, phash = build_params(svc.core_params, svc.bundle)
        key = (svc.bundle.model_version, native.CORE_VERSION, phash)
        meta = None if m.force_recompute else await svc.store.read(lambda c: repo.get_analysis_meta(c, m.sha256, *key))
        self.window = AckWindow()
        cached = meta is not None

        if cached:
            ids = json.loads(meta["channel_ids"])
            regs = json.loads(meta["summary_json"] or "{}").get("regions", [])
            n_ch, aid = int(meta["n_channels"]), meta["analysis_id"]
            overview = await svc.store.read(lambda c: repo.get_overview(c, aid, n_ch))
            blocks = self._db_blocks(aid, int(meta["n_chunks"]), n_ch, meta["codec"])
        else:
            planes, regs, overview = await self._compute(seq, L)
            ids = list(range(native.N_CHANNELS))
            await svc.store.write_tx(lambda c: repo.put_analysis(
                c, sha256=m.sha256, model_version=key[0], core_version=key[1], params_hash=phash, params=params,
                planes=planes, channel_ids=ids, anomaly_count=len(regs), summary={"regions": regs},
                overview=overview, codec=svc.settings.cache_codec))
            await svc.hub.publish(EvHistoryChanged(latest_rev=await svc.store.read(_latest_rev)))
            blocks = self._mem_blocks(planes)

        want = sorted({c for c in m.want if c in ids}) or ids
        rows = [ids.index(c) for c in want]
        scope = ModelScope(**svc.bundle.scope) if svc.bundle.scope else None
        await self._json(WsScanReady(sha256=m.sha256, length=L, channels=[fr.CHANNEL_BY_ID[c] for c in want],
                                     chunk_positions=self.CHUNK, cache="HIT" if cached else "MISS", params_hash=phash,
                                     overview_bins=int(overview.shape[1]) if overview is not None else 0, model_scope=scope))
        flags_base = fr.F_FROM_CACHE if cached else 0
        if overview is not None:
            size = -(-L // overview.shape[1])
            await self._bytes(fr.pack_frame(fr.T_OVERVIEW, await self.window.acquire(), size, overview[rows], flags_base))
        await self._stream(blocks, rows, L, regs, flags_base)
        await self._json(WsScanComplete(anomaly_count=len(regs), duration_ms=int((time.monotonic() - t0) * 1000)))

    async def _mem_blocks(self, planes: np.ndarray) -> AsyncIterator[tuple[int, np.ndarray]]:
        for s in range(0, planes.shape[1], repo.CHUNK_POSITIONS):
            yield s, planes[:, s:s + repo.CHUNK_POSITIONS]

    async def _db_blocks(self, aid: str, n_chunks: int, n_ch: int, codec: str) -> AsyncIterator[tuple[int, np.ndarray]]:
        for ci in range(n_chunks):
            got = await self.svc.store.read(lambda c, ci=ci: repo.get_chunk(c, aid, ci, n_ch, codec))
            if got is None: raise HSError("INTERNAL", "analysis cache is incomplete; re-scan")
            yield got

    async def _stream(self, blocks, rows: list[int], L: int, regs: list[dict], flags_base: int) -> None:
        alerts, ai, last_progress = sorted(regs, key=lambda r: r["start"]), 0, 0.0
        async for start, block in blocks:
            sel = block[rows]
            for off in range(0, sel.shape[1], self.CHUNK):
                part = sel[:, off:off + self.CHUNK]
                s = start + off
                e = s + part.shape[1]
                flags = flags_base | (fr.F_FINAL if e >= L else 0) | (fr.F_HAS_NAN if np.isnan(part).any() else 0)
                await self._bytes(fr.pack_frame(fr.T_TELEMETRY, await self.window.acquire(), s, part, flags))
                while ai < len(alerts) and alerts[ai]["start"] < e:
                    a = alerts[ai]
                    await self._json(WsAnomalyAlert(start=a["start"], end=a["end"], score=a["score"], kind=a["kind"]))
                    ai += 1
                now = time.monotonic()
                if now - last_progress >= 0.1 or e >= L:
                    last_progress = now
                    await self._json(WsProgress(pos=e, fraction=e / L))

def _latest_rev(cur) -> int:
    return int(cur.execute("SELECT coalesce(max(rev), 0) FROM analysis_history").fetchone()[0])
