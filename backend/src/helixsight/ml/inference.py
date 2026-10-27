from __future__ import annotations
from typing import Protocol
import numpy as np

class Runner(Protocol):
    model_version: str
    win: int
    def predict(self, onehot: np.ndarray) -> tuple[np.ndarray, np.ndarray]: ...

class TorchRunner:
    def __init__(self, net, model_version: str, threads: int = 4):
        import torch
        torch.set_num_threads(threads)
        self._torch, self.net, self.model_version, self.win = torch, net.eval(), model_version, 1024
    def predict(self, onehot):
        with self._torch.inference_mode():
            p, a = self.net(self._torch.from_numpy(onehot))
        return p.numpy(), a.numpy()

class OrtRunner:
    def __init__(self, path: str, model_version: str, threads: int = 1):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = threads, 1
        self.sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        self.model_version, self.win = model_version, 1024
    def predict(self, onehot):
        p, a = self.sess.run(["probs", "attn"], {"onehot": onehot})
        return p, a

def onehot_from_codes(codes: np.ndarray) -> np.ndarray:
    L = len(codes)
    oh = np.zeros((4, L), np.float32)
    idx = np.flatnonzero(codes < 4)
    oh[codes[idx], idx] = 1.0
    return oh

def window_starts(L: int, win: int, stride: int) -> list[int]:
    if L <= win: return [0]
    s = list(range(0, L - win + 1, stride))
    if s[-1] != L - win: s.append(L - win)
    return s

def predict_sequence(codes: np.ndarray, runner: Runner, stride: int = 512, batch: int = 16):
    L, W = len(codes), runner.win
    oh = onehot_from_codes(codes)
    if L < W: oh = np.pad(oh, ((0, 0), (0, W - L)))
    Lp = oh.shape[1]
    starts = window_starts(Lp, W, stride)
    wgt = np.hanning(W + 2)[1:-1].astype(np.float32)
    acc = np.zeros((4, Lp), np.float32)
    acca = np.zeros(Lp, np.float32)
    wsum = np.zeros(Lp, np.float32)
    for b0 in range(0, len(starts), batch):
        ss = starts[b0:b0 + batch]
        x = np.stack([oh[:, s:s + W] for s in ss]).astype(np.float32)
        p, a = runner.predict(x)
        a = a / (a.max(axis=1, keepdims=True) + 1e-9)
        for j, s in enumerate(ss):
            acc[:, s:s + W] += p[j] * wgt
            acca[s:s + W] += a[j] * wgt
            wsum[s:s + W] += wgt
    return (acc / wsum)[:, :L], (acca / wsum)[:L]
