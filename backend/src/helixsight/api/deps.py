from __future__ import annotations
from fastapi import Request, WebSocket
from ..services import Services

def get_services(request: Request) -> Services:
    return request.app.state.services

def origin_allowed(ws: WebSocket, svc: Services) -> bool:
    origin = ws.headers.get("origin")
    if not origin: return True
    host = ws.headers.get("host")
    return origin in svc.settings.cors_list or (host is not None and origin.split("://", 1)[-1] == host)
