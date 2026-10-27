from __future__ import annotations
from fastapi import APIRouter, WebSocket
from ..streaming.session import ScanSession
from .deps import origin_allowed

router = APIRouter()

@router.websocket("/ws/scan")
async def ws_scan(ws: WebSocket) -> None:
    svc = ws.app.state.services
    if not origin_allowed(ws, svc):
        await ws.close(code=4403)
        return
    await ws.accept()
    await ScanSession(ws, svc).run()
