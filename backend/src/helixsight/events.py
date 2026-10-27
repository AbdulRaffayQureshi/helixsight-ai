from __future__ import annotations
import asyncio
from typing import Any, Union
from pydantic import BaseModel

class EventHub:
    def __init__(self, queue_size: int = 100) -> None:
        self._subs: set[asyncio.Queue] = set()
        self._size = queue_size

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(self._size)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    async def publish(self, event: Union[BaseModel, dict[str, Any]]) -> None:
        data = event.model_dump(mode="json") if isinstance(event, BaseModel) else event
        for q in list(self._subs):
            if q.full():
                q.get_nowait()
            q.put_nowait(data)
