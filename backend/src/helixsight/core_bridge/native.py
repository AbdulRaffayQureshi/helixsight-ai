from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from typing import Optional

import numpy as np

try:
    import helixsight_core as _core
except ImportError:
    _core = None

EXPECTED_ABI = 1
CORE_AVAILABLE: bool = _core is not None
CORE_VERSION: str = _core.__version__ if _core is not None else "unavailable"
if _core is not None and _core.abi_version != EXPECTED_ABI:
    raise RuntimeError(
        f"helixsight_core ABI {_core.abi_version} != expected {EXPECTED_ABI}; "
        "rebuild with `uv sync --reinstall-package helixsight-core`"
    )

CH_GC, CH_SKEW, CH_TM, CH_DG, CH_Z, CH_CGR_X, CH_CGR_Y = 0, 1, 2, 3, 4, 5, 6
N_CHANNELS = 13

_executor = ThreadPoolExecutor(
    max_workers=int(os.environ.get("HS_CORE_EXECUTOR_THREADS", "2")),
    thread_name_prefix="hs-core",
)


class CoreUnavailableError(RuntimeError):
    code = "CORE_UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class CoreParams:
    gc_window: int = 100
    thermo_window: int = 20
    z_window: int = 12
    na_mM: float = 50.0
    strand_nM: float = 250.0
    temp_c: float = 37.0
    k: int = 4
    kmer_window: int = 1024
    kmer_stride: int = 256

    def as_dict(self) -> dict:
        return asdict(self)


def alloc_planes(length: int) -> np.ndarray:
    return np.full((N_CHANNELS, length), np.nan, dtype=np.float32)


def _need_core() -> None:
    if _core is None:
        raise CoreUnavailableError("helixsight_core is not installed")


def encode(seq: str) -> np.ndarray:
    out = np.empty(len(seq), dtype=np.uint8)
    if _core is not None:
        bad = _core.encode_into(seq, out)
        if bad >= 0:
            raise ValueError(f"invalid nucleotide {seq[bad]!r} at offset {bad}")
        return out
    lut = np.full(256, 255, dtype=np.uint8)
    for ch, v in zip("ACGTUacgtu", (0, 1, 2, 3, 3, 0, 1, 2, 3, 3)):
        lut[ord(ch)] = v
    for ch in "RYSWKMBDHVNrywskmbdhvn":
        lut[ord(ch)] = 4
    raw = lut[np.frombuffer(seq.encode("ascii", "replace"), dtype=np.uint8)]
    if (raw == 255).any():
        bad = int(np.flatnonzero(raw == 255)[0])
        raise ValueError(f"invalid nucleotide {seq[bad]!r} at offset {bad}")
    return raw


def gc_per_position(codes: np.ndarray, window: int, out_gc: np.ndarray, out_skew: np.ndarray) -> None:
    if _core is not None:
        _core.gc_per_position(codes, window, out_gc, out_skew)
        return
    n = len(codes)
    w = min(window, n)
    pre = lambda m: np.concatenate(([0], np.cumsum(m, dtype=np.int64)))  # noqa: E731
    pg, pc, pu = pre(codes == 2), pre(codes == 1), pre(codes < 4)
    s = np.clip(np.arange(n) - w // 2, 0, n - w)
    g, c, u = pg[s + w] - pg[s], pc[s + w] - pc[s], pu[s + w] - pu[s]
    with np.errstate(divide="ignore", invalid="ignore"):
        out_gc[:] = np.where(u > 0, 100.0 * (g + c) / u, np.nan)
        out_skew[:] = np.where((g + c) > 0, (g - c) / (g + c), np.nan)


def local_thermo(codes: np.ndarray, pos: int, p: CoreParams = CoreParams()) -> Optional[tuple[float, float]]:
    _need_core()
    tm, dg, _, _, _ = _core.thermo_at(codes, pos, p.thermo_window, p.na_mM, p.strand_nM, p.temp_c)
    return None if (tm != tm or dg != dg) else (tm, dg)


def compute_core_channels(codes: np.ndarray, planes: np.ndarray, p: CoreParams = CoreParams()) -> np.ndarray:
    _need_core()
    L = len(codes)
    assert planes.shape == (N_CHANNELS, L) and planes.dtype == np.float32 and planes.flags.c_contiguous
    assert codes.dtype == np.uint8 and codes.flags.c_contiguous
    _core.gc_per_position(codes, p.gc_window, planes[CH_GC], planes[CH_SKEW])
    _core.thermo_per_position(codes, p.thermo_window, p.na_mM, p.strand_nM, p.temp_c, planes[CH_TM], planes[CH_DG])
    _core.zdna_per_position(codes, p.z_window, planes[CH_Z])
    _core.cgr_points(codes, planes[CH_CGR_X], planes[CH_CGR_Y])
    counts = np.empty((_core.kmer_n_windows(L, p.kmer_window, p.kmer_stride), 4 ** p.k), dtype=np.uint32)
    _core.kmer_matrix(codes, p.k, p.kmer_window, p.kmer_stride, counts)
    return counts


async def compute_core_channels_async(codes: np.ndarray, planes: np.ndarray, p: CoreParams = CoreParams()) -> np.ndarray:
    _need_core()
    loop = asyncio.get_running_loop()
    L = len(codes)
    counts = np.empty((_core.kmer_n_windows(L, p.kmer_window, p.kmer_stride), 4 ** p.k), dtype=np.uint32)
    jobs = [
        lambda: _core.gc_per_position(codes, p.gc_window, planes[CH_GC], planes[CH_SKEW]),
        lambda: _core.thermo_per_position(codes, p.thermo_window, p.na_mM, p.strand_nM, p.temp_c, planes[CH_TM], planes[CH_DG]),
        lambda: _core.zdna_per_position(codes, p.z_window, planes[CH_Z]),
        lambda: _core.cgr_points(codes, planes[CH_CGR_X], planes[CH_CGR_Y]),
        lambda: _core.kmer_matrix(codes, p.k, p.kmer_window, p.kmer_stride, counts),
    ]
    await asyncio.gather(*(loop.run_in_executor(_executor, j) for j in jobs))
    return counts
