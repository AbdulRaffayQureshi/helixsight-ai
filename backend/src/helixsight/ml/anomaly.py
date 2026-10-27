from __future__ import annotations
import numpy as np
from sklearn.ensemble import IsolationForest

def anomaly_scores(counts: np.ndarray, seed: int = 42):
    n = counts.shape[0]
    if n < 8:
        return np.zeros(n, np.float32), "insufficient_windows"
    tot = counts.sum(axis=1, keepdims=True).clip(min=1)
    X = np.sqrt(counts / tot)
    forest = IsolationForest(n_estimators=200, max_samples=min(256, n), random_state=seed, n_jobs=1).fit(X)
    raw = -forest.score_samples(X)
    med = np.median(raw)
    mad = np.median(np.abs(raw - med)) * 1.4826 + 1e-9
    z = (raw - med) / mad
    return z.astype(np.float32), "ok"

def to_position_scores(z_win: np.ndarray, L: int, window: int = 1024, stride: int = 256, z_alert: float = 3.5):
    diff_s = np.zeros(L + 1, np.float64)
    diff_c = np.zeros(L + 1, np.float64)
    for i, z in enumerate(z_win):
        s = i * stride
        e = min(L, s + window)
        diff_s[s] += z; diff_s[e] -= z; diff_c[s] += 1; diff_c[e] -= 1
    cnt = np.cumsum(diff_c)[:L]
    zs = np.cumsum(diff_s)[:L]
    zpos = np.divide(zs, cnt, out=np.zeros(L), where=cnt > 0)
    return np.clip(zpos / (2 * z_alert), 0, 1).astype(np.float32)

def regions(z_win, L, window=1024, stride=256, z_alert=3.5, min_run=3):
    out, run = [], []
    for i, z in enumerate(list(z_win) + [-1e9]):
        if z >= z_alert:
            run.append(i)
        else:
            if len(run) >= min_run:
                out.append((run[0] * stride, min(L, run[-1] * stride + window), float(max(z_win[j] for j in run))))
            run = []
    return out
