from __future__ import annotations
import asyncio

class SlowClient(Exception): pass

class AckWindow:
    def __init__(self, size: int = 8, timeout: float = 10.0) -> None:
        self.size, self.timeout = size, timeout
        self._next = 0
        self._acked = 0
        self._cv = asyncio.Condition()

    async def acquire(self) -> int:
        async with self._cv:
            try:
                await asyncio.wait_for(self._cv.wait_for(lambda: self._next - self._acked < self.size), self.timeout)
            except asyncio.TimeoutError as e:
                raise SlowClient() from e
            seq = self._next
            self._next += 1
            return seq

    async def ack(self, stream_seq: int) -> None:
        async with self._cv:
            self._acked = max(self._acked, stream_seq + 1)
            self._cv.notify_all()
