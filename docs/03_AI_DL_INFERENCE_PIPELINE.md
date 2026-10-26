# 03_AI_DL_INFERENCE_PIPELINE.md

> **HelixSight AI** · Document `03` of `05` · Depends on: `00`, `01` (channel registry §7.3, cache key §6, mutation flow §4.4), `02` (how outputs are rendered)
> Scope: model inventory, exact PyTorch architectures, data/labels, training, inference + stitching, anomaly detection, mutation scoring, ONNX export/quantization, browser inference, attention mapping, determinism.
> Scripts are **reference implementations**; each must be run, tested and its metrics recorded in a MODEL_CARD during Phase P4.

---

## 0. PURPOSE & INTERCONNECTIONS

```text
 codes uint8[L]  (same buffer the C++ core reads; doc 01 §5)
        │
        ▼  ml/inference.py::predict_sequence(codes, runner)
   one-hot windows (4×1024, stride 512) ──► Runner (TorchRunner | OrtRunner)  ──► probs (B,4,1024) + attn (B,1024)
        │                                                                      ▲
        │  Hann-weighted overlap stitching                                     │ registry.py loads weights / ONNX + model.json
        ▼
   probs (4,L)  attn (L)  ──► channels 8–11 and 7 (doc 01 §7.3)
 kmer_matrix (C++)  ──► ml/anomaly.py ──► anomaly_score (L) + regions ──► channel 12 + anomaly_alert events
        │
        ▼
 ScanSession assembles planar float32 [13×L] ──► DuckDB analysis_cache ──► WS frames ──► Engine (doc 02)
 Mutation: ml/pathogenicity.py (ref vs alt windows + C++ thermo Δ) ──► Mutation (doc 01 §10)
 Browser offline path: onnx.worker.ts runs the SAME windowing/stitching on the exported ONNX ──► channels 7–11 only
```

---

## 1. MODEL INVENTORY & SCOPE

| Model ID | Task | Framework | Input | Output | Used for |
|---|---|---|---|---|---|
| `hs-cnnbilstm-v1` | per-position promoter / CpG-island / splice-donor / splice-acceptor + attention | PyTorch → ONNX | one-hot `(B,4,1024)` | `probs (B,4,1024)`, `attn (B,1024)` | channels 7–11, mutation deltas |
| *(per-scan)* IsolationForest | composition drift | scikit-learn | k=4 frequency vectors per 1024-nt window | anomaly score per window | channel 12, alerts, `anomaly_count` |
| `hs-kmer-ae-v1` *(optional)* | reference-based drift | PyTorch MLP autoencoder | 256-d k=4 frequencies | reconstruction error | optional replacement for IsolationForest |
| Mutation scorer | heuristic impact | NumPy (no learned weights) | ref/alt windows + thermo deltas | `pathogenicity ∈ [0,1)` | `Mutation.pathogenicity` |

**Pretrained-checkpoint policy (C-1):** the default stack is the **custom lightweight model above, trained locally**, because several public genomic foundation-model checkpoints carry non-commercial or share-alike terms. `transformers`/`optimum` remain approved tools; an adapter slot (`Runner` interface, §6) allows a permissively licensed pretrained model **only after** its weight license is recorded in `MODEL_CARDS/`.

**Scope warning (must surface in the UI):** `hs-cnnbilstm-v1` is trained on **human (GRCh38) genomic windows**. Viral, bacterial, mitochondrial or non-human sequences (e.g. `NC_045512.2`, `NC_012920.1`) are **out-of-distribution**: outputs may be uninformative or misleading. `scan_ready` carries a `model_scope` object (patch in the reconciliation list) and the HUD shows a persistent chip "Model trained on human genomic DNA — interpret with caution".

---

## 2. DATA, LABELS, SPLITS

All sources are **free public downloads fetched by the user's scripts; nothing is redistributed or committed.** Record each dataset's terms in the MODEL_CARD before training.

| Item | Source | How labels are derived |
|---|---|---|
| Genome | GRCh38 chromosome FASTA (NCBI / Ensembl / UCSC) | one-hot codes `A0 C1 G2 T3 N→4` |
| Gene models | GENCODE GTF (protein-coding transcripts) | **Promoter**: TSS −250…+50 (transcript direction). **Splice donor**: first intron base (5' end of intron). **Splice acceptor**: last intron base (3' end of intron). |
| CpG islands | computed **locally** from sequence (no external annotation) | simplified Gardiner-Garden & Frommer rule over 200-bp windows: GC > 50% and obs/exp CpG > 0.6; union of qualifying windows |

**Weak-supervision honesty:** the CpG head learns a deterministic rule (its value is a smooth probability and a unified architecture); promoter labels from TSS windows are coarse; splice labels are single positions (very imbalanced). Metrics must be reported per head with these caveats.

**Strand handling.** Two label masks per chromosome (`mask_plus`, `mask_minus`) in **genomic coordinates**, bit layout: `bit0 promoter · bit1 cpg · bit2 donor · bit3 acceptor`. To train on the minus strand, the sampler uses the **reverse complement** of the sequence window and the **reversed** `mask_minus` window, so every training example reads 5'→3' on the labelled strand (CpG bit is written to both masks).

**Splits (chromosome-held-out, prevents leakage):** train `chr1–chr8` (default; extend if RAM allows) · validation `chr20` · test `chr21, chr22`. Memory: sequence + two masks = 3 bytes/bp → `chr1–chr8` ≈ 1.1 Gbp ≈ 3.3 GB (fits 16 GB; use `mmap`).

### 2.1 `ml_models/training/labels.py`

```python
import numpy as np

BIT_PROM, BIT_CPG, BIT_DON, BIT_ACC = 1, 2, 4, 8

def cpg_island_mask(codes: np.ndarray, W: int = 200, gc_min: float = 0.5, oe_min: float = 0.6) -> np.ndarray:
    n = len(codes)
    if n < W:
        return np.zeros(n, bool)
    C = (codes == 1).astype(np.int64); G = (codes == 2).astype(np.int64)
    CG = np.zeros(n, np.int64); CG[:-1] = (codes[:-1] == 1) & (codes[1:] == 2)
    pre = lambda a: np.concatenate(([0], np.cumsum(a)))
    pc, pg, pcg = pre(C), pre(G), pre(CG)
    s = np.arange(0, n - W + 1)
    c, g = pc[s + W] - pc[s], pg[s + W] - pg[s]
    cg = pcg[s + W - 1] - pcg[s]                       # CG pairs fully inside [s, s+W)
    gc = (c + g) / W
    oe = np.divide(cg * W, c * g, out=np.zeros(len(s)), where=(c * g) > 0)
    ok = (gc > gc_min) & (oe > oe_min)
    diff = np.bincount(s[ok], minlength=n + 1) - np.bincount(s[ok] + W, minlength=n + 1)
    return np.cumsum(diff[:-1]) > 0

def reverse_complement(codes: np.ndarray) -> np.ndarray:
    rc = np.where(codes < 4, 3 - codes, 4).astype(np.uint8)
    return rc[::-1]
```

### 2.2 `ml_models/training/build_dataset.py` (outline, run once per chromosome)

```python
"""Usage: uv run python build_dataset.py --fasta GRCh38.fa --gtf gencode.gtf.gz --out processed/ --chroms chr1 ... chr22
Writes processed/{chrom}.seq.npy (uint8), {chrom}.plus.npy, {chrom}.minus.npy (uint8 bitmasks)."""
import argparse, gzip, re
from collections import defaultdict
from pathlib import Path
import numpy as np
from Bio import SeqIO
from labels import *

LUT = np.full(256, 4, np.uint8)
for i, ch in enumerate(b"ACGT"): LUT[ch] = i; LUT[ch + 32] = i       # lowercase (soft-masked) too

def read_chrom(fasta: str, name: str) -> np.ndarray:
    for rec in SeqIO.parse(fasta, "fasta"):
        if rec.id == name:
            return LUT[np.frombuffer(str(rec.seq).encode(), np.uint8)]
    raise KeyError(name)

def parse_gtf(path: str, chrom: str):
    tx = defaultdict(lambda: {"strand": "+", "exons": []})
    with gzip.open(path, "rt") as fh:
        for line in fh:
            if line[0] == "#": continue
            f = line.rstrip("\n").split("\t")
            if f[0] != chrom or f[2] != "exon" or 'gene_type "protein_coding"' not in f[8]: continue
            tid = re.search(r'transcript_id "([^"]+)"', f[8]).group(1)
            tx[tid]["strand"] = f[6]
            tx[tid]["exons"].append((int(f[3]) - 1, int(f[4]) - 1))     # 1-based inclusive -> 0-based inclusive
    return tx

def rasterize(n: int, tx) -> tuple[np.ndarray, np.ndarray]:
    plus, minus = np.zeros(n, np.uint8), np.zeros(n, np.uint8)
    for t in tx.values():
        ex = sorted(t["exons"])
        if len(ex) == 0: continue
        if t["strand"] == "+":
            tss = ex[0][0]
            plus[max(0, tss - 250): min(n, tss + 51)] |= BIT_PROM
            for (s0, e0), (s1, e1) in zip(ex, ex[1:]):                   # intron = e0+1 .. s1-1
                if e0 + 1 < s1: plus[e0 + 1] |= BIT_DON; plus[s1 - 1] |= BIT_ACC
        else:
            tss = ex[-1][1]
            minus[max(0, tss - 50): min(n, tss + 251)] |= BIT_PROM       # upstream = higher coordinates
            for (s0, e0), (s1, e1) in zip(ex, ex[1:]):                   # transcript direction is descending
                if e0 + 1 < s1: minus[s1 - 1] |= BIT_ACC; minus[e0 + 1] |= BIT_DON
    return plus, minus
# main(): codes = read_chrom(...); cpg = cpg_island_mask(codes)*BIT_CPG; plus,minus = rasterize(...); plus|=cpg; minus|=cpg; np.save(...)
```
Verification required in P4.2: spot-check ≥10 genes (donor sites should be `GT` on the labelled strand; acceptors `AG`); log the observed `GT`/`AG` fraction as a label-sanity metric (expect > 95%).

---

## 3. EXACT PYTORCH ARCHITECTURE — `backend/src/helixsight/ml/models.py`

Design: dilated residual 1-D CNN (local motifs) → BiLSTM (long-range context) → additive attention pooling (window context + attention map) → per-position 4-way head.

```python
import torch, torch.nn as nn

WIN = 1024
HEADS = ("promoter", "cpg_island", "splice_donor", "splice_acceptor")     # -> channel ids 8, 9, 10, 11

class ResBlock1d(nn.Module):
    def __init__(self, ch: int, k: int = 9, dilation: int = 1, p: float = 0.1):
        super().__init__()
        pad = dilation * (k - 1) // 2                                    # 'same' length for odd k
        self.c1 = nn.Conv1d(ch, ch, k, padding=pad, dilation=dilation, bias=False); self.b1 = nn.BatchNorm1d(ch)
        self.c2 = nn.Conv1d(ch, ch, k, padding=pad, dilation=dilation, bias=False); self.b2 = nn.BatchNorm1d(ch)
        self.act, self.drop = nn.GELU(), nn.Dropout(p)
    def forward(self, x):                                                 # (B,C,L)
        h = self.drop(self.act(self.b1(self.c1(x))))
        h = self.b2(self.c2(h))
        return self.act(x + h)

class AdditiveAttention(nn.Module):
    def __init__(self, d: int, d_att: int = 128):
        super().__init__()
        self.W, self.v = nn.Linear(d, d_att), nn.Linear(d_att, 1, bias=False)
    def forward(self, h):                                                 # h: (B,L,d)
        e = self.v(torch.tanh(self.W(h))).squeeze(-1)                     # (B,L)
        a = torch.softmax(e, dim=-1)                                      # sums to 1 over the window
        ctx = torch.bmm(a.unsqueeze(1), h)                                # (B,1,d)
        return a, ctx

class HelixSightNet(nn.Module):
    def __init__(self, ch: int = 64, lstm_h: int = 128, p: float = 0.1):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv1d(4, ch, 9, padding=4, bias=False), nn.BatchNorm1d(ch), nn.GELU())
        self.res = nn.Sequential(*[ResBlock1d(ch, 9, d, p) for d in (1, 2, 4)])
        self.expand = nn.Conv1d(ch, 2 * lstm_h, 1)
        self.lstm = nn.LSTM(2 * lstm_h, lstm_h, num_layers=2, batch_first=True, bidirectional=True, dropout=0.2)
        d = 2 * lstm_h
        self.attn = AdditiveAttention(d, 128)
        self.head = nn.Sequential(nn.Linear(2 * d, 128), nn.GELU(), nn.Dropout(p), nn.Linear(128, len(HEADS)))

    def forward(self, x):                                                 # x: (B,4,L) float32 one-hot
        h = self.res(self.stem(x))
        h = self.expand(h).transpose(1, 2)                                # (B,L,2*lstm_h)
        h, _ = self.lstm(h)                                               # (B,L,d)  d = 2*lstm_h = 256
        a, ctx = self.attn(h)                                             # a:(B,L)  ctx:(B,1,d)
        z = torch.cat([h, ctx.expand(-1, h.size(1), -1)], dim=-1)         # (B,L,2d)
        logits = self.head(z).transpose(1, 2)                             # (B,4,L)
        return logits, a

class ExportWrapper(nn.Module):                                           # what ONNX/inference see
    def __init__(self, net: HelixSightNet):
        super().__init__(); self.net = net
    def forward(self, x):
        logits, a = self.net(x)
        return torch.sigmoid(logits), a                                   # probs (B,4,L), attn (B,L) raw softmax
```
- **Parameters:** ≈ 1.0 M (≈ 4 MB FP32). `print(sum(p.numel() for p in net.parameters()))` is logged by the training script and written to the MODEL_CARD.
- **Receptive field:** the CNN stack sees ±~100 nt locally; the BiLSTM provides full-window (1024 nt) context.
- **Attention semantics:** `a` is a learned *pooling distribution* over the window — a useful saliency view of which positions the window-level context emphasises, **not** a causal explanation. §8 describes the normalization and an optional gradient×input map.
- **Fixed length:** training and export use `L=1024`; shorter sequences are padded (§5), longer ones are tiled.

---

## 4. TRAINING — `ml_models/training/train_cnn_bilstm.py`

```python
import json, random, time
from dataclasses import dataclass, asdict
from pathlib import Path
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F
from torch.utils.data import IterableDataset, DataLoader
from sklearn.metrics import average_precision_score
from helixsight.ml.models import HelixSightNet, HEADS, WIN
from labels import reverse_complement

@dataclass
class Cfg:
    data: str = "ml_models/datasets/processed"
    train: tuple = tuple(f"chr{i}" for i in range(1, 9)); val: tuple = ("chr20",)
    win: int = WIN; batch: int = 64; steps: int = 1500; epochs: int = 20
    lr: float = 2e-3; wd: float = 1e-2; seed: int = 42; pos_frac: float = 0.5
    pos_weight: tuple = (3.0, 3.0, 30.0, 30.0); clip: float = 1.0
    out: str = "ml_models/checkpoints/hs-cnnbilstm-v1.pt"

class Sampler(IterableDataset):
    def __init__(self, cfg: Cfg, chroms, seed, n=None):
        self.cfg, self.n, self.seed = cfg, n, seed
        self.data = {c: tuple(np.load(f"{cfg.data}/{c}.{k}.npy", mmap_mode="r") for k in ("seq", "plus", "minus")) for c in chroms}
        self.names = list(self.data); self.w = np.array([len(self.data[c][0]) for c in self.names], float); self.w /= self.w.sum()
        self.pos = {}                                                    # positive anchors per (chrom, strand)
        for c in self.names:
            for si, m in ((0, self.data[c][1]), (1, self.data[c][2])):
                self.pos[(c, si)] = np.flatnonzero(np.asarray(m) & 0b1100)   # splice sites as anchors
    def __iter__(self):
        rng = np.random.default_rng(self.seed + (torch.utils.data.get_worker_info().id if torch.utils.data.get_worker_info() else 0))
        i = 0
        while self.n is None or i < self.n:
            c = self.names[rng.choice(len(self.names), p=self.w)]; seq, plus, minus = self.data[c]; strand = int(rng.integers(2))
            L = len(seq); W = self.cfg.win
            anchors = self.pos[(c, strand)]
            if len(anchors) and rng.random() < self.cfg.pos_frac:
                s = int(np.clip(anchors[rng.integers(len(anchors))] - rng.integers(W), 0, L - W))
            else:
                s = int(rng.integers(0, L - W))
            x = np.asarray(seq[s:s + W]); m = np.asarray((plus if strand == 0 else minus)[s:s + W])
            if (x == 4).mean() > 0.1: continue                           # skip assembly gaps
            if strand == 1: x, m = reverse_complement(x), m[::-1]
            y = np.stack([(m >> h) & 1 for h in range(4)]).astype(np.float32)
            yield torch.from_numpy(x.astype(np.int64)), torch.from_numpy(y); i += 1

def to_onehot(codes, device):                                            # (B,L) int -> (B,4,L); code 4 -> all zeros
    return F.one_hot(codes.to(device), 5)[..., :4].permute(0, 2, 1).float()

def evaluate(net, loader, device):
    net.eval(); P, Y = [], []
    with torch.inference_mode():
        for x, y in loader:
            logits, _ = net(to_onehot(x, device)); P.append(torch.sigmoid(logits).cpu().numpy()); Y.append(y.numpy())
    P, Y = np.concatenate(P), np.concatenate(Y)
    return {h: float(average_precision_score(Y[:, i].ravel(), P[:, i].ravel())) for i, h in enumerate(HEADS)}

def main(cfg: Cfg = Cfg()):
    random.seed(cfg.seed); np.random.seed(cfg.seed); torch.manual_seed(cfg.seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    net = HelixSightNet().to(dev); n_params = sum(p.numel() for p in net.parameters()); print("params:", n_params)
    tr = DataLoader(Sampler(cfg, cfg.train, cfg.seed), batch_size=cfg.batch, num_workers=2)
    va = DataLoader(Sampler(cfg, cfg.val, 12345, n=4000), batch_size=64)           # fixed validation stream (seeded)
    opt = torch.optim.AdamW(net.parameters(), lr=cfg.lr, weight_decay=cfg.wd)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=cfg.lr, total_steps=cfg.epochs * cfg.steps)
    pw = torch.tensor(cfg.pos_weight, device=dev).view(1, 4, 1); best = -1.0; it = iter(tr)
    for ep in range(cfg.epochs):
        net.train(); t0 = time.time(); run = 0.0
        for _ in range(cfg.steps):
            x, y = next(it); x, y = to_onehot(x, dev), y.to(dev)
            logits, _ = net(x); loss = F.binary_cross_entropy_with_logits(logits, y, pos_weight=pw)
            opt.zero_grad(set_to_none=True); loss.backward(); nn.utils.clip_grad_norm_(net.parameters(), cfg.clip); opt.step(); sched.step(); run += loss.item()
        m = evaluate(net, va, dev); score = float(np.mean(list(m.values())))
        print(f"ep {ep} loss {run/cfg.steps:.4f} val AUPRC {m} ({time.time()-t0:.0f}s)")
        if score > best:
            best = score; Path(cfg.out).parent.mkdir(parents=True, exist_ok=True)
            torch.save({"state_dict": net.state_dict(), "cfg": asdict(cfg), "val_auprc": m, "n_params": n_params}, cfg.out)
    Path(cfg.out).with_suffix(".metrics.json").write_text(json.dumps({"best_mean_auprc": best, "n_params": n_params}))

if __name__ == "__main__":
    main()
```
- **Imbalance:** `pos_weight` for splice heads is 30 (single-nucleotide positives); `pos_frac=0.5` oversamples windows containing splice sites. Tune against validation AUPRC.
- **Reproducibility:** seeds fixed; the validation stream is seeded; dataloader workers derive seeds from `seed + worker_id`.
- **Evaluation (test set `chr21–22`):** per-head AUPRC, plus AUPRC stratified by GC bin; report in the MODEL_CARD together with the OOD warning (§1). Do **not** quote accuracy (meaningless under imbalance).
- **Compute:** CPU works for debugging (`steps=50`); a CUDA GPU under WSL2 is optional and not required to run the *application*, only to train quickly.

---

## 5. INFERENCE — `backend/src/helixsight/ml/inference.py`

### 5.1 Runner interface and implementations
```python
from typing import Protocol
import numpy as np, torch

class Runner(Protocol):
    model_version: str; win: int
    def predict(self, onehot: np.ndarray) -> tuple[np.ndarray, np.ndarray]: ...   # (B,4,win) -> probs (B,4,win), attn (B,win)

class TorchRunner:
    def __init__(self, net, model_version: str, threads: int = 4):
        torch.set_num_threads(threads); self.net = net.eval(); self.model_version = model_version; self.win = 1024
    @torch.inference_mode()
    def predict(self, onehot):
        p, a = self.net(torch.from_numpy(onehot)); return p.numpy(), a.numpy()   # net = ExportWrapper (sigmoid inside)

class OrtRunner:
    def __init__(self, path: str, model_version: str, threads: int = 1):
        import onnxruntime as ort
        so = ort.SessionOptions(); so.intra_op_num_threads = threads; so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"]); self.model_version = model_version; self.win = 1024
    def predict(self, onehot):
        p, a = self.sess.run(["probs", "attn"], {"onehot": onehot}); return p, a
```

### 5.2 One-hot, windowing, stitching
```python
def onehot_from_codes(codes: np.ndarray) -> np.ndarray:                  # uint8[L] (0..4) -> float32 (4,L); code 4 -> zeros
    L = len(codes); oh = np.zeros((4, L), np.float32); idx = np.flatnonzero(codes < 4)
    oh[codes[idx], idx] = 1.0; return oh

def window_starts(L: int, win: int, stride: int) -> list[int]:
    if L <= win: return [0]
    s = list(range(0, L - win + 1, stride))
    if s[-1] != L - win: s.append(L - win)                                # final window flush with the end
    return s

def predict_sequence(codes: np.ndarray, runner: Runner, stride: int = 512, batch: int = 16):
    """Returns probs (4,L) float32 and attn (L,) float32 in [0,1]."""
    L, W = len(codes), runner.win
    oh = onehot_from_codes(codes)
    if L < W: oh = np.pad(oh, ((0, 0), (0, W - L)))                       # zero-pad (ambiguity-like), cropped below
    Lp = oh.shape[1]; starts = window_starts(Lp, W, stride)
    wgt = np.hanning(W + 2)[1:-1].astype(np.float32)                      # strictly > 0, tapers edge effects
    acc = np.zeros((4, Lp), np.float32); acca = np.zeros(Lp, np.float32); wsum = np.zeros(Lp, np.float32)
    for b0 in range(0, len(starts), batch):
        ss = starts[b0:b0 + batch]
        x = np.stack([oh[:, s:s + W] for s in ss]).astype(np.float32)     # (B,4,W)
        p, a = runner.predict(x)
        a = a / (a.max(axis=1, keepdims=True) + 1e-9)                     # per-window normalisation to [0,1]
        for j, s in enumerate(ss):
            acc[:, s:s + W] += p[j] * wgt; acca[s:s + W] += a[j] * wgt; wsum[s:s + W] += wgt
    return (acc / wsum)[:, :L], (acca / wsum)[:L]
```
**Properties (unit-tested):** (i) a constant-output stub runner yields exactly that constant everywhere (weights normalise out); (ii) `L < 1024` is handled by padding and cropping; (iii) the last window is always flush with the end (no uncovered tail); (iv) the output is invariant to `batch`.

**Memory handoff:** `codes` is the same `uint8[L]` buffer prepared for C++ (`01` §5); `onehot_from_codes` creates the only extra allocation (4·L·4 bytes; 80 MB at 5 Mbp), windows are views/stacks of ≤16×4×1024 floats.

### 5.3 Channel assembly (called by `ScanSession`)
```text
 probs[0]→ch 8 p_promoter   probs[1]→ch 9 p_cpg_island   probs[2]→ch 10 p_splice_donor   probs[3]→ch 11 p_splice_acceptor
 attn   →ch 7 attention     anomaly (per-position, §7)→ch 12      C++ channels 0–6 come from helixsight_core (doc 01 §5)
```
Ambiguity positions (`code==4`) have all-zero one-hot input; their ML outputs are valid numbers but **masked to NaN** in the channel planes (flag `HAS_NAN`) so the UI shows "no data".

---

## 6. REGISTRY & VERSIONING — `ml/registry.py`

Sidecar `model.json` next to each artifact:
```json
{
  "model_id": "hs-cnnbilstm-v1",
  "weights_sha256": "<hex>",
  "window": 1024, "stride": 512,
  "heads": ["promoter", "cpg_island", "splice_donor", "splice_acceptor"],
  "input": "onehot", "outputs": ["probs", "attn"], "opset": 17,
  "artifacts": { "pt": "hs-cnnbilstm-v1.pt", "onnx_fp32": "hs-cnnbilstm-v1.fp32.onnx", "onnx_int8": "hs-cnnbilstm-v1.int8.onnx" },
  "scope": { "trained_on": "human GRCh38 genomic windows", "warning": "Out-of-distribution for non-human sequences" },
  "license_notes": "see MODEL_CARDS/hs-cnnbilstm-v1.md"
}
```
`model_version = f"{model_id}+{weights_sha256[:8]}"`. `get_runner()` selects `OrtRunner` (FP32 ONNX) by default for server speed/portability, `TorchRunner` as fallback, per `HELIXSIGHT_RUNNER` env. If no weights are present: `MODEL_UNAVAILABLE` (non-fatal): the scan streams C++ channels only and the HUD marks ML tracks "model not installed".

---

## 7. ANOMALY DETECTION — `ml/anomaly.py`

**Input:** `counts` `uint32[nWin, 256]` from `helixsight_core.kmer_matrix(k=4, window=1024, stride=256)` (doc 01 §5).

```python
import numpy as np
from sklearn.ensemble import IsolationForest

def anomaly_scores(counts: np.ndarray, seed: int = 42):
    n = counts.shape[0]
    if n < 8:                                                             # too few windows for a meaningful baseline
        return np.zeros(n, np.float32), "insufficient_windows"
    tot = counts.sum(axis=1, keepdims=True).clip(min=1)
    X = np.sqrt(counts / tot)                                             # Hellinger transform stabilises frequencies
    forest = IsolationForest(n_estimators=200, max_samples=min(256, n), random_state=seed, n_jobs=1).fit(X)
    raw = -forest.score_samples(X)                                        # higher = more anomalous
    med = np.median(raw); mad = np.median(np.abs(raw - med)) * 1.4826 + 1e-9
    z = (raw - med) / mad                                                 # robust z-score
    return z.astype(np.float32), "ok"

def to_position_scores(z_win: np.ndarray, L: int, window: int = 1024, stride: int = 256, z_alert: float = 3.5):
    """Average window z over covering windows; channel value = clip(z / (2*z_alert), 0, 1) so the alert threshold maps to 0.5."""
    diff_s = np.zeros(L + 1, np.float64); diff_c = np.zeros(L + 1, np.float64)
    for i, z in enumerate(z_win):
        s = i * stride; e = min(L, s + window)
        diff_s[s] += z; diff_s[e] -= z; diff_c[s] += 1; diff_c[e] -= 1
    cnt = np.cumsum(diff_c)[:L]; zs = np.cumsum(diff_s)[:L]
    zpos = np.divide(zs, cnt, out=np.zeros(L), where=cnt > 0)
    return np.clip(zpos / (2 * z_alert), 0, 1).astype(np.float32)

def regions(z_win, L, window=1024, stride=256, z_alert=3.5, min_run=3):
    """Merge runs of >= min_run consecutive windows with z >= z_alert -> [(start,end,peak_z)]."""
    out, run = [], []
    for i, z in enumerate(list(z_win) + [-1e9]):
        if z >= z_alert: run.append(i)
        else:
            if len(run) >= min_run: out.append((run[0] * stride, min(L, run[-1] * stride + window), float(max(z_win[j] for j in run))))
            run = []
    return out
```
- **Baseline is the sequence itself** (what is unusual *within this sequence*); the forest is fit per scan with a fixed seed (C-10). This supersedes the "top 3% by score" rule in `01` §6.
- **Alert rule:** robust `z ≥ 3.5` for ≥ 3 consecutive windows (windows overlap 4×, so min extent ≈ 1,024 + 2·256 nt). `anomaly_count = len(regions)`.
- **Region `kind` (coarse heuristics, C-9):** `low_complexity` if the mean k=4 entropy over the region < 3.0 bits (max 8; compute from counts); else `possible_hgt` if `|GC(region) − GC(global)| ≥ 5` percentage points **and** length ≥ 1,500 nt; else `composition_shift`. `possible_hgt` means "consistent with horizontal transfer", never a confirmed call.
- **Optional autoencoder** `hs-kmer-ae-v1`: `Linear(256→64)→GELU→Linear(64→16)→GELU→Linear(16→64)→GELU→Linear(64→256)`, input = Hellinger-transformed frequencies, loss = MSE, trained on windows from a free reference genome set; score = per-window reconstruction error, then the same robust-z pipeline. Stored under `ml_models/` with its own model card; selecting it changes `params_hash`.

---

## 8. ATTENTION MAPPING (MODEL → PIXELS)

| Stage | Operation | Where |
|---|---|---|
| 1 | Additive attention yields `a(t)` per window (softmax over 1024 positions) | `models.py` |
| 2 | Per-window normalisation `a / max(a)` → `[0,1]` | `predict_sequence` |
| 3 | Overlap stitching with Hann weights (smooth seams) | `predict_sequence` |
| 4 | Channel 7 `attention` streamed as `float32` | doc 01 §7.3 |
| 5 | UI glow alpha `= attention^1.5`, colour `--attn`; also modulates sonification gain | doc 02 §5.8, §7 |

**Interpretation caveats shown in the UI tooltip:** attention is window-relative (per-window max = 1), reflects the model's pooling emphasis, and is not a causal attribution. For causal-style sensitivity, an **optional on-demand** endpoint (not streamed) computes gradient×input saliency with `TorchRunner`: `x.requires_grad_(); logits[head, pos_range].sum().backward(); saliency = (x.grad * x).sum(1).abs()` normalised per window; it is available only for the torch path.

---

## 9. MUTATION SCORING — `ml/pathogenicity.py`

Inputs from `ScanSession` for a request `(pos, alt)`: `codes`, the `Runner`, and a `local_thermo(codes_slice, center) -> (tm_c, dg_kcal)` callable backed by `helixsight_core.thermo_nn` on a ±64-nt slice (doc 01 §4.4).

```python
import numpy as np
from .inference import onehot_from_codes

def _window(codes, s, W):
    w = codes[s:s + W]
    return np.pad(w, (0, W - len(w)), constant_values=4) if len(w) < W else w

def score_mutation(runner, codes, pos, alt_code, local_thermo, radius=16):
    W, L = runner.win, len(codes)
    s = int(np.clip(pos - W // 2, 0, max(0, L - W))); c = pos - s              # centre index inside the window
    ref = _window(codes, s, W).copy(); alt = ref.copy(); alt[c] = alt_code
    x = np.stack([onehot_from_codes(ref), onehot_from_codes(alt)])             # (2,4,W) – one batched call
    p, _ = runner.predict(x)
    d = p[1] - p[0]                                                            # (4,W) signed deltas
    lo, hi = max(0, c - radius), min(W, c + radius + 1)
    def site_delta(h):
        seg = d[h, lo:hi]; return float(seg[np.argmax(np.abs(seg))])           # signed delta at max |Δ| within ±radius
    d_prom, d_cpg = site_delta(0), site_delta(1)
    d_don, d_acc = site_delta(2), site_delta(3)
    d_splice = d_don if abs(d_don) >= abs(d_acc) else d_acc
    tm_r, dg_r = local_thermo(codes, pos)
    codes_alt = codes.copy(); codes_alt[pos] = alt_code
    tm_a, dg_a = local_thermo(codes_alt, pos)
    d_tm, d_dg = tm_a - tm_r, dg_a - dg_r                                      # ΔΔG > 0 = destabilising (less negative ΔG)
    impact = 1.0 * abs(d_splice) + 0.8 * abs(d_prom) + 0.4 * abs(d_cpg) + 0.25 * min(abs(d_dg), 4.0) / 4.0
    score = float(1.0 - np.exp(-2.0 * impact))                                 # in [0,1)
    return dict(delta_tm_c=d_tm, delta_dg_kcal=d_dg, delta_p_promoter=d_prom, delta_p_cpg=d_cpg, delta_p_splice=d_splice, pathogenicity=score)
```
- **Not clinical (C-9):** weights `(1.0, 0.8, 0.4, 0.25)` and the `2.0` scale are **uncalibrated defaults**; the score has not been validated against variant-interpretation datasets, and the model sees only a 1-kb window of DNA (no conservation, protein effect, or population frequency). The UI label is "Research heuristic — not a clinical or diagnostic result".
- **Optional future calibration:** fit a monotone mapping against a public variant-classification resource (e.g. NCBI ClinVar) with proper held-out evaluation; out of scope for v1 and must carry its own model-card caveats.
- `NaN` thermo (ambiguity in window) ⇒ `delta_tm_c/dg = None` and the thermo term is dropped from `impact`.

---

## 10. ONNX CONVERSION & QUANTIZATION — `ml/onnx_export.py`

```python
import hashlib, json, numpy as np, torch, onnx, onnxruntime as ort
from pathlib import Path
from helixsight.ml.models import HelixSightNet, ExportWrapper, WIN

def export(ckpt="ml_models/checkpoints/hs-cnnbilstm-v1.pt", out_dir="ml_models/onnx"):
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    ck = torch.load(ckpt, map_location="cpu"); net = HelixSightNet(); net.load_state_dict(ck["state_dict"])
    model = ExportWrapper(net).eval(); dummy = torch.zeros(1, 4, WIN)
    fp32 = out / "hs-cnnbilstm-v1.fp32.onnx"
    torch.onnx.export(model, dummy, fp32, opset_version=17, do_constant_folding=True,
                      input_names=["onehot"], output_names=["probs", "attn"],
                      dynamic_axes={"onehot": {0: "batch"}, "probs": {0: "batch"}, "attn": {0: "batch"}},
                      dynamo=False)            # torch>=2.5: use the legacy exporter for reliable LSTM export; omit the kwarg on older torch
    onnx.checker.check_model(onnx.load(fp32))
    # parity: torch vs ORT FP32 on random + real windows
    x = (np.random.default_rng(0).random((8, 4, WIN)) > 0.75).astype(np.float32)
    with torch.inference_mode(): pt_p, pt_a = [t.numpy() for t in model(torch.from_numpy(x))]
    sess = ort.InferenceSession(str(fp32), providers=["CPUExecutionProvider"]); o_p, o_a = sess.run(["probs", "attn"], {"onehot": x})
    assert np.abs(pt_p - o_p).max() < 1e-4 and np.abs(pt_a - o_a).max() < 1e-4, "FP32 parity failed"
    # server-side INT8 (dynamic): verify accuracy before adopting
    from onnxruntime.quantization import quantize_dynamic, QuantType
    int8 = out / "hs-cnnbilstm-v1.int8.onnx"; quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)
    q_p, _ = ort.InferenceSession(str(int8), providers=["CPUExecutionProvider"]).run(["probs", "attn"], {"onehot": x})
    print("INT8 max |Δprob| vs torch:", float(np.abs(pt_p - q_p).max()))        # accept only if <= 0.02 AND val AUPRC drop <= 0.01 (P4.4)
    sha = hashlib.sha256(Path(ckpt).read_bytes()).hexdigest()
    (out / "model.json").write_text(json.dumps({"model_id": "hs-cnnbilstm-v1", "weights_sha256": sha, "window": WIN, "stride": 512,
        "heads": ["promoter", "cpg_island", "splice_donor", "splice_acceptor"], "input": "onehot", "outputs": ["probs", "attn"], "opset": 17,
        "artifacts": {"pt": "hs-cnnbilstm-v1.pt", "onnx_fp32": fp32.name, "onnx_int8": int8.name},
        "scope": {"trained_on": "human GRCh38 genomic windows", "warning": "Out-of-distribution for non-human sequences"}}, indent=2))
```
- `optimum-cli export onnx` targets HuggingFace `transformers` models; for this custom `nn.Module` use `torch.onnx.export` as above (`optimum` stays available for the optional adapter slot).
- **Artifacts:** `*.fp32.onnx` (≈ 4 MB) is the **portable default** (server and browser). `*.int8.onnx` is a **server-side** optimisation adopted only if its accuracy gate passes.
- **Browser caveat (decision gate in P8.1):** ONNX Runtime Web supports a narrower operator set than the native CPU build; dynamically quantised LSTM uses contrib operators that the WASM backend may not provide. Therefore the PWA ships the **FP32** model by default; an INT8 browser build is attempted only if a spike confirms operator support and parity. (This revises the "INT8 in browser" statement in `00`/`01`.)
- `make export-onnx` copies `hs-cnnbilstm-v1.fp32.onnx` and `model.json` to `frontend/public/models/` and the ORT-Web WASM binaries to `frontend/public/ort/`.

---

## 11. BROWSER INFERENCE (OFFLINE PATH) — `frontend/src/workers/onnx.worker.ts`

- **Local-only assets (C-2):** `ort.env.wasm.wasmPaths = "/ort/"` (copied at build; no CDN). The service worker precaches `/models/*` and `/ort/*`.
- **Threads:** multi-threaded WASM needs cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`); configure these headers in the Vite dev/preview server and document them for static hosting. If `crossOriginIsolated` is false: `ort.env.wasm.numThreads = 1` (functional, slower).
- **Same algorithm as Python:** one-hot from `codes`, windows 1024 / stride 512, batch ≤ 8, Hann stitching, per-window attention normalisation, ambiguity masking → NaN.

```ts
// onnx.worker.ts (shape)
import * as ort from "onnxruntime-web";
ort.env.wasm.wasmPaths = "/ort/";
let sess: ort.InferenceSession;
self.onmessage = async (e: MessageEvent<{ id: number; codes: Uint8Array }>) => {
  sess ??= await ort.InferenceSession.create("/models/hs-cnnbilstm-v1.fp32.onnx", { executionProviders: ["wasm"] });
  const { codes, id } = e.data, L = codes.length, W = 1024;
  const starts = windowStarts(Math.max(L, W), W, 512);                  // pad logic mirrors Python
  const acc = new Float32Array(4 * Math.max(L, W)), accA = new Float32Array(Math.max(L, W)), wsum = new Float32Array(Math.max(L, W));
  for (const s of starts) {                                              // batch=1 in v1 for simplicity
    const x = new Float32Array(4 * W);                                   // layout (1,4,W): channel-major
    for (let j = 0; j < W; j++) { const b = codes[s + j] ?? 4; if (b < 4) x[b * W + j] = 1; }
    const out = await sess.run({ onehot: new ort.Tensor("float32", x, [1, 4, W]) });
    const p = out.probs.data as Float32Array, a = out.attn.data as Float32Array;
    let amax = 1e-9; for (let j = 0; j < W; j++) if (a[j] > amax) amax = a[j];
    for (let j = 0; j < W; j++) {
      const w = hann(j, W); wsum[s + j] += w; accA[s + j] += (a[j] / amax) * w;
      for (let h = 0; h < 4; h++) acc[h * Math.max(L, W) + s + j] += p[h * W + j] * w;
    }
  }
  // normalise by wsum, crop to L, mask code==4 to NaN, post {id, planes} with transferable buffers
};
```
**Parity test (P8.1):** the TS stitcher output must match the Python `predict_sequence` on a 5 kb fixture within `1e-4` (FP32).
**Offline scope:** thermo/k-mer/anomaly channels still require the backend (doc 01 §6); when the backend is unreachable and no tensors are cached, the UI streams ML channels 7–11 only and says so.

---

## 12. DETERMINISM & CACHE KEY (refines `01` §6, C-10)

```text
params_hash = sha256(canonical_json({
  window_bp, stride, na_mM, k, win_ml:1024, stride_ml:512,
  runner: "ort-fp32" | "ort-int8" | "torch",
  anomaly: {kind, n_estimators:200, seed:42, window:1024, stride:256, z_alert:3.5, min_run:3},
  mask_ambiguity:true, channel_registry_version:1 }))
analysis_key = (sha256, model_version, core_version, params_hash)
```
- Fixed seeds (`IsolationForest.random_state=42`, `n_jobs=1`); inference in `eval`/`inference_mode`; ORT `intra_op_num_threads` pinned from config (default **1** for cache-writing runs).
- **Scope of C-10 (clarified):** outputs are byte-identical for the same machine, library versions and thread settings. Across different CPUs or library builds, floating-point results can differ in the last bits; the cache key therefore includes `runner` and `core_version`, and cross-machine regression tests use a tolerance of `1e-5` rather than byte equality.

---

## 13. TEST PLAN (ML)

| Test | Pass criterion |
|---|---|
| Shape/contract: `HelixSightNet(B,4,1024)` | logits `(B,4,1024)`, attn `(B,1024)`, `attn.sum(-1)≈1` |
| Stitching identity (constant stub runner) | output equals constant to `1e-6` |
| Tail coverage | for `L ∈ {1, 1023, 1024, 1025, 5000}` every position receives weight `>0`; output shape `(4,L)` |
| Batch invariance | `batch=1` vs `batch=16` outputs equal within `1e-6` |
| Torch vs ORT FP32 parity | `max|Δ| < 1e-4` on probs and attn |
| INT8 gate (server) | `max|Δprob| ≤ 0.02` and per-head val AUPRC drop `≤ 0.01` |
| TS vs Python stitcher parity | `< 1e-4` on 5 kb fixture |
| Anomaly: synthetic 20-kb sequence with an inserted 3-kb region of different GC | one region detected overlapping the insert (±1 window); no alerts in a homogeneous random control at fixed seed |
| Anomaly: `n<8` windows | zeros + `insufficient_windows` |
| Mutation: `alt==ref` | all deltas 0, `pathogenicity=0` |
| Determinism | two runs, same config ⇒ identical `channels_blob` bytes |
| Label sanity (build_dataset) | donor `GT` / acceptor `AG` fraction `> 95%` on the labelled strand |
| Latency (budgets `01` §14) | 14-kb scan ≤ 1.5 s CPU (torch) / ≤ 0.8 s (ORT) on the dev machine; record actuals |

---

## 14. MODEL CARD REQUIREMENTS (`ml_models/MODEL_CARDS/hs-cnnbilstm-v1.md`)

Must contain: intended use and **non-use** (not diagnostic; human DNA only); data sources, versions and **recorded license/terms**; label derivation (this document §2) and its weaknesses; split definition; hyper-parameters and seed; parameter count; per-head AUPRC on val/test (and GC-stratified); calibration notes (if measured); OOD behaviour observed on at least one viral and one bacterial sequence; quantization results; known failure modes (repeats, low-complexity, assembly gaps); `weights_sha256`.

---

## 15. INTERCONNECTION MATRIX (ML LAYER)

| Caller | Callee | Payload | Purpose |
|---|---|---|---|
| `ScanSession` | `ml/registry.get_runner()` | env/config → `Runner` | select ORT/torch |
| `ScanSession` | `inference.predict_sequence(codes, runner)` | `uint8[L]` → `probs(4,L)`, `attn(L)` | channels 7–11 |
| `ScanSession` | `core_bridge.kmer_matrix` → `anomaly.anomaly_scores` | `uint32[nWin,256]` → `z_win` | anomaly detection |
| `anomaly.to_position_scores` / `regions` | `ScanSession` | `float32[L]`, regions | channel 12, `anomaly_alert`, `anomaly_count` |
| `ScanSession` | `framing.pack_chunk` | planar `float32[13×N]` | WS binary frames (doc 01 §7.3) |
| `ScanSession` | `duckdb_store` | `channels_blob`, `summary_json` | `analysis_cache` write-through |
| `ws_scan` `mutate` | `pathogenicity.score_mutation` | `(pos, alt)` + `local_thermo` | `mutation_result` |
| `onnx_export.py` | `ml_models/onnx/*`, `model.json` | ONNX + sidecar | registry + browser assets |
| `make export-onnx` | `frontend/public/models`, `public/ort` | file copy | offline PWA inference |
| `onnx.worker.ts` | `Engine` (doc 02) | transferable planes (ch 7–11) | offline telemetry |

---

## 16. PHASE-TRACKER REFINEMENTS (apply to `00` §8)

```text
P4.1 → [ ] P4.1a models.py (HelixSightNet + ExportWrapper) + shape/contract tests
P4.2 → [ ] P4.2a labels.py + build_dataset.py + label-sanity check  [ ] P4.2b train_cnn_bilstm.py + metrics + MODEL_CARD
P4.3 → [ ] P4.3a anomaly.py (robust-z, regions, kinds) + synthetic-insert test
P4.4 → [ ] P4.4a onnx_export.py FP32 parity  [ ] P4.4b INT8 gate (server)  [ ] P4.4c registry + model.json
P4.5 → [ ] P4.5a pathogenicity.py + alt==ref test + UI heuristic label
P8.1 → [ ] P8.1a ORT-Web operator/parity spike (FP32 default; INT8 only if proven)  [ ] P8.1b COOP/COEP headers + local WASM assets
```