from __future__ import annotations
import asyncio
from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect
from .deps import origin_allowed

router = APIRouter()

@router.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    svc = ws.app.state.services
    if not origin_allowed(ws, svc):
        await ws.close(code=4403)
        return
    await ws.accept()
    q = svc.hub.subscribe()
    try:
        if svc.watcher:
            await ws.send_text(svc.watcher.status().model_dump_json())
        async def drain_client() -> None:
            while True:
                await ws.receive_text()
        reader = asyncio.create_task(drain_client())
        try:
            while not reader.done():
                try:
                    await ws.send_json(await asyncio.wait_for(q.get(), 1.0))
                except asyncio.TimeoutError:
                    continue
        finally:
            reader.cancel()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        svc.hub.unsubscribe(q)
