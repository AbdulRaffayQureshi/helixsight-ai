from __future__ import annotations
import numpy as np

def window_entropy_bits(counts_row: np.ndarray) -> float:
    tot = float(counts_row.sum())
    if tot <= 0: return 0.0
    p = counts_row[counts_row > 0] / tot
    return float(-(p * np.log2(p)).sum())

def region_kind(codes: np.ndarray, counts: np.ndarray, start: int, end: int, *, stride: int, global_gc: float) -> str:
    i0, i1 = start // stride, min(counts.shape[0] - 1, max(start, end - 1) // stride)
    entropy = float(np.mean([window_entropy_bits(counts[i]) for i in range(i0, i1 + 1)]))
    if entropy < 3.0: return "low_complexity"
    seg = codes[start:end]
    acgt = int((seg < 4).sum())
    gc = 100.0 * int(((seg == 1) | (seg == 2)).sum()) / acgt if acgt else global_gc
    if abs(gc - global_gc) >= 5.0 and (end - start) >= 1500: return "possible_hgt"
    return "composition_shift"
