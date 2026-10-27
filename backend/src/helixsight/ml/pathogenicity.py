from __future__ import annotations
import numpy as np
from .inference import onehot_from_codes

def _window(codes, s, W):
    w = codes[s:s + W]
    return np.pad(w, (0, W - len(w)), constant_values=4) if len(w) < W else w

def score_mutation(runner, codes, pos, alt_code, local_thermo, radius=16):
    W, L = runner.win, len(codes)
    s = int(np.clip(pos - W // 2, 0, max(0, L - W)))
    c = pos - s
    ref = _window(codes, s, W).copy()
    alt = ref.copy()
    alt[c] = alt_code
    x = np.stack([onehot_from_codes(ref), onehot_from_codes(alt)])
    p, _ = runner.predict(x)
    d = p[1] - p[0]
    lo, hi = max(0, c - radius), min(W, c + radius + 1)

    def site_delta(h):
        seg = d[h, lo:hi]
        return float(seg[np.argmax(np.abs(seg))])

    d_prom, d_cpg, d_don, d_acc = site_delta(0), site_delta(1), site_delta(2), site_delta(3)
    d_splice = d_don if abs(d_don) >= abs(d_acc) else d_acc
    tm_r, dg_r = local_thermo(codes, pos)
    codes_alt = codes.copy()
    codes_alt[pos] = alt_code
    tm_a, dg_a = local_thermo(codes_alt, pos)
    d_tm, d_dg = tm_a - tm_r, dg_a - dg_r
    thermo_term = 0.25 * min(abs(d_dg), 4.0) / 4.0 if np.isfinite(d_dg) else 0.0
    impact = 1.0 * abs(d_splice) + 0.8 * abs(d_prom) + 0.4 * abs(d_cpg) + thermo_term
    score = float(1.0 - np.exp(-2.0 * impact))
    return dict(delta_tm_c=d_tm, delta_dg_kcal=d_dg, delta_p_promoter=d_prom, delta_p_cpg=d_cpg,
                delta_p_splice=d_splice, pathogenicity=score)
