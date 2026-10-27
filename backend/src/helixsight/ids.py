from __future__ import annotations
import os
import time
import uuid

def uuid7() -> str:
    ts_ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (
        ((ts_ms & ((1 << 48) - 1)) << 80)
        | (0x7 << 76)
        | (((rand >> 68) & 0xFFF) << 64)
        | (0b10 << 62)
        | (rand & ((1 << 62) - 1))
    )
    return str(uuid.UUID(int=value))
