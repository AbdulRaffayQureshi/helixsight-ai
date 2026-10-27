import time
import numpy as np
import helixsight_core as hc

L = 1_000_000
seq = np.random.default_rng(0).integers(0, 4, L, dtype=np.uint8)

def timed(name, fn):
    t0 = time.perf_counter()
    fn()
    print(f"{name:22s}{(time.perf_counter() - t0) * 1000:8.1f} ms")

gc, sk, tm, dg, z, x, y = (np.empty(L, np.float32) for _ in range(7))
nw = hc.kmer_n_windows(L, 1024, 256)
km = np.empty((nw, 256), np.uint32)
timed("gc_per_position", lambda: hc.gc_per_position(seq, 100, gc, sk))
timed("thermo_per_position", lambda: hc.thermo_per_position(seq, 20, 50.0, 250.0, 37.0, tm, dg))
timed("zdna_per_position", lambda: hc.zdna_per_position(seq, 12, z))
timed("cgr_points", lambda: hc.cgr_points(seq, x, y))
timed("kmer_matrix k=4", lambda: hc.kmer_matrix(seq, 4, 1024, 256, km))
