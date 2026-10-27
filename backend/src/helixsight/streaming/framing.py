from __future__ import annotations
import struct
import warnings
import numpy as np
from ..schemas.models import ChannelInfo

HEADER = struct.Struct("<2sBBIIIHHI")
HEADER_BYTES = HEADER.size
MAGIC, VERSION = b"HS", 1
T_TELEMETRY, T_OVERVIEW = 0x01, 0x02
F_FINAL, F_FROM_CACHE, F_HAS_NAN = 1, 2, 4

CHANNELS: list[ChannelInfo] = [
    ChannelInfo(id=0, name="gc_pct", unit="%", min=0, max=100),
    ChannelInfo(id=1, name="gc_skew", unit="(G-C)/(G+C)", min=-1, max=1),
    ChannelInfo(id=2, name="tm_c", unit="degC", min=0, max=120),
    ChannelInfo(id=3, name="dg_kcal", unit="kcal/mol", min=-60, max=0),
    ChannelInfo(id=4, name="z_propensity", unit="0-1", min=0, max=1),
    ChannelInfo(id=5, name="cgr_x", unit="0-1", min=0, max=1),
    ChannelInfo(id=6, name="cgr_y", unit="0-1", min=0, max=1),
    ChannelInfo(id=7, name="attention", unit="0-1", min=0, max=1),
    ChannelInfo(id=8, name="p_promoter", unit="0-1", min=0, max=1),
    ChannelInfo(id=9, name="p_cpg_island", unit="0-1", min=0, max=1),
    ChannelInfo(id=10, name="p_splice_donor", unit="0-1", min=0, max=1),
    ChannelInfo(id=11, name="p_splice_acceptor", unit="0-1", min=0, max=1),
    ChannelInfo(id=12, name="anomaly_score", unit="0-1", min=0, max=1),
]
CHANNEL_BY_ID = {c.id: c for c in CHANNELS}

def pack_frame(frame_type: int, stream_seq: int, start: int, planes: np.ndarray, flags: int = 0) -> bytes:
    c, n = planes.shape
    return HEADER.pack(MAGIC, VERSION, frame_type, stream_seq, start, n, c, flags, 0) + \
        np.ascontiguousarray(planes, dtype="<f4").tobytes(order="C")

def unpack_frame(buf: bytes) -> dict:
    magic, ver, ftype, seq, start, count, c, flags, _ = HEADER.unpack_from(buf, 0)
    planes = np.frombuffer(buf, dtype="<f4", count=c * count, offset=HEADER_BYTES).reshape(c, count)
    return {"type": ftype, "seq": seq, "start": start, "count": count, "channels": c, "flags": flags, "planes": planes}

def make_overview(planes: np.ndarray, max_bins: int = 4096) -> tuple[np.ndarray, int]:
    c, length = planes.shape
    nb = max(1, min(max_bins, length))
    size = -(-length // nb)
    nb = -(-length // size)
    out = np.empty((c, nb), np.float32)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for i in range(c):
            row = planes[i]
            if nb * size != length:
                row = np.concatenate([row, np.full(nb * size - length, np.nan, np.float32)])
            out[i] = np.nanmean(row.reshape(nb, size), axis=1)
    return out, size
