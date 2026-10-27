from __future__ import annotations
import asyncio
import time
from typing import Any, Awaitable, Callable, Optional
import httpx
from ..errors import HSError
from ..schemas.models import ErrorCode

class RateLimiter:
    def __init__(self, per_second: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep) -> None:
        self._interval, self._clock, self._sleep = 1.0 / per_second, clock, sleep
        self._next = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self._lock:
            now = self._clock()
            delay = max(0.0, self._next - now)
            self._next = max(now, self._next) + self._interval
        if delay:
            await self._sleep(delay)

async def get_with_retry(http: httpx.AsyncClient, url: str, *, params: Optional[dict[str, Any]] = None,
                         limiter: Optional[RateLimiter] = None, retries: int = 3, backoff: float = 0.5,
                         sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep, service: str = "upstream",
                         rate_code: ErrorCode = "UPSTREAM_TIMEOUT") -> httpx.Response:
    kind, info, retry_after = "timeout", "", 0.0
    for attempt in range(retries):
        retry_after = 0.0
        if limiter:
            await limiter.wait()
        try:
            r = await http.get(url, params=params)
        except httpx.TimeoutException as e:
            kind, info = "timeout", f"timeout {e.__class__.__name__}"
        except httpx.TransportError as e:
            kind, info = "transport", e.__class__.__name__
        else:
            if r.status_code == 429:
                kind, info = "rate", "HTTP 429"
                try:
                    retry_after = float(r.headers.get("Retry-After", "0"))
                except ValueError:
                    retry_after = 0.0
            elif r.status_code >= 500:
                kind, info = "http", f"HTTP {r.status_code}"
            else:
                return r
        if attempt < retries - 1:
            await sleep(max(retry_after, backoff * (2 ** attempt)))
    if kind == "rate":
        raise HSError(rate_code, f"{service} is rate limiting requests; try again shortly or add an API key",
                      {"retry_after": retry_after}, retry_after=retry_after or 1.0)
    raise HSError("UPSTREAM_TIMEOUT", f"{service} did not respond ({info}); showing cached items only",
                  {"service": service})
