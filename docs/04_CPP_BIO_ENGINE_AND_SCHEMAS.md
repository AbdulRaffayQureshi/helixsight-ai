# 04_CPP_BIO_ENGINE_AND_SCHEMAS.md

> **HelixSight AI** · Document `04` of `05` · Depends on: `00`, `01` (§5 memory handoff, §7.3 channel registry, §9 schema), `03` (§12 cache key)
> Scope: C++20 header/source architecture, pybind11 bindings, build files, tests, the Python bridge, and the **complete DuckDB schema** (sequences, AI cache, `analysis_history`) with its repository layer.
> **Verification status:** every C++/Python/SQL listing below was compiled and executed on Ubuntu 24.04 (gcc 13.3, Python 3.12, DuckDB, NumPy) — C++ suite under `-fsanitize=address,undefined`, wheel built with scikit-build-core and imported from a clean venv. MSVC (Windows-native) was not tried.

---

## 0. PURPOSE & INTERCONNECTIONS

```text
 Python (ScanSession, doc 01 §4)                                  C++ (cpp_core)                         DuckDB
 ───────────────────────────────                                  ──────────────                         ──────
 residues str ─► native.encode() ──► helixsight_core.encode_into ─► hs::encode_into  ──► codes uint8[L]
 codes uint8[L] (C-contiguous, read-only to C++)
 planes float32[13,L] = native.alloc_planes(L)        (rows are contiguous 1-D buffers, NaN-filled)
   ├─ planes[0],[1] ◄══ gc_per_position ═══════════════════════► hs::gc_per_position      (prefix sums)
   ├─ planes[2],[3] ◄══ thermo_per_position ═══════════════════► hs::thermo_per_position  (SantaLucia NN, prefix sums, rolling RC hash)
   ├─ planes[4]     ◄══ zdna_per_position ═════════════════════► hs::zdna_per_position
   ├─ planes[5],[6] ◄══ cgr_points ════════════════════════════► hs::cgr_points           (planar x / y)
   └─ counts uint32[nWin,4^k] ◄══ kmer_matrix ═════════════════► hs::kmer_matrix          (incremental add/remove sweep)
 counts ──► ml/anomaly.py (doc 03 §7) ──► planes[12]; ml/inference.py ──► planes[7..11]
 planes ──► repo.put_analysis ─────────────────────────────────────────────────────────────────────────► analysis_cache + analysis_chunks
 Mutation: native.local_thermo ► helixsight_core.thermo_at ► hs::thermo_window (direct O(window)) ─► ml/pathogenicity.py
 Ingestion ► repo.ingest_one ───────────────────────────────────────────────────────────────────────────► sequences, source_records,
                                                                                                           accession_index, analysis_history
 /api/history/sync ► repo.history_sync ◄─── v_history_record (view) ◄──────────────────────────────────── analysis_history ⨝ sequences ⟕ source_records
```

**Memory handoff contract (binding, restated from doc 01 §5):** Python allocates **every** array that crosses the boundary; C++ never allocates or retains them. Inputs are read-only C-contiguous `uint8`; outputs are writable C-contiguous `float32`/`uint32`. All array arguments are `noconvert` (a wrong dtype is a `TypeError`, never a silent copy). The GIL is released around every heavy loop. Functions are re-entrant (no globals), so the five kernels run concurrently on the `hs-core` thread pool.

---

## 1. DECISIONS RESOLVED IN THIS DOCUMENT (supersede earlier text)

| # | Topic | Decision |
|---|---|---|
| D1 | Per-position window rule (doc 01 §16 #6) | `w = min(window, L)`; window for position *i* starts at `clamp(i − ⌊w/2⌋, 0, L − w)` ("centered, shift-clamped"). Width is constant, so edge values are comparable; the first/last `⌊w/2⌋` positions share the first/last window. |
| D2 | Z-propensity (doc 01 §16 #5) | Heuristic (not Z-Hunt): step scores `CG,GC=1.0`, `CA,TG,AC,GT=0.6`, `TA,AT=0.3`, else 0; window mean rescaled against the random expectation 0.3125: `z = clip((mean−0.3125)/0.6875, 0, 1)`. Default window 12. |
| D3 | Thermo parameters | Added `strand_nM` (default 250 nM) and `temp_c` (37 °C) beside `na_mM` (50 mM). Tm formula uses `x=4` (non-self-complementary) or `x=1` (self-complementary) with the −1.4 cal/K·mol symmetry term. Windows < 8 nt give physically meaningless Tm; default window is 20. |
| D4 | CGR output | Planar `out_x[L]`, `out_y[L]` (no interleaved `[L,2]`) so each channel is a contiguous row of the tensor with no copy. |
| D5 | Encoding API | `encode_into(str, out)` (Python allocates `out`); `native.encode()` wraps it. Returns −1 or the first invalid offset. |
| D6 | GC API | `gc_per_position` (L outputs) replaces `gc_windowed` for the stream; no stride variant. |
| D7 | History table name | **`analysis_history`** (was `scan_history`). `HistoryRecord` contract is unchanged. |
| D8 | No foreign keys | DuckDB runs UPDATEs on indexed columns as delete+insert and FK checks interact badly with that. Integrity is enforced in `repo.py` and audited by `verify_integrity()`. Rule: **never UPDATE an indexed column.** `rev` is deliberately not indexed. |
| D9 | AI-cache storage | Immutable `analysis_cache` metadata row + `analysis_chunks` (65,536 positions per chunk, planar float32 per chunk). A 5 Mbp, 13-channel tensor (260 MB) is never one blob; the WS streamer reads chunk-by-chunk. Cache rows are written in **one transaction after the full compute**, so a partial analysis is never visible. |
| D10 | Compression (doc 01 §16 #3) | `codec` column (`raw` default, `zstd` level 3 via the optional `zstandard` package, BSD). IndexedDB tensors stay uncompressed (<5 ms path). |
| D11 | Degraded mode | Without the wheel: `encode` and `gc_per_position` fall back to NumPy; thermo, Z, CGR and k-mer raise `CoreUnavailableError` (`CORE_UNAVAILABLE`, non-fatal); those channels stream as NaN. |
| D12 | Mutation REST (doc 02 §5.9) | `GET /api/history/{scan_id}/mutations` → `Mutation[]`; `DELETE /api/mutations/{mutation_id}` → `204` (bumps the history row's `rev`). |

---

## 2. C++ ARCHITECTURE

### 2.1 Layout and dependency graph

```text
cpp_core/
├── CMakeLists.txt
├── pyproject.toml                     # scikit-build-core; version read from version.hpp
├── include/helixsight/
│   ├── version.hpp                    # HS_CORE_VERSION, HS_CORE_ABI  (single source of truth)
│   ├── types.hpp                      # base codes, kNaNf, kMaxK, is_acgt
│   ├── window.hpp                     # WindowPlan (rule D1) — header-only
│   ├── encode.hpp  gc.hpp  kmer.hpp  cgr.hpp  zdna.hpp  thermo.hpp
├── src/                               # encode.cpp gc.cpp kmer.cpp cgr.cpp zdna.cpp thermo.cpp
├── bindings/module.cpp                # the ONLY file that includes pybind11
├── tests/test_core.cpp                # doctest (single header vendored in third_party/doctest/)
└── third_party/doctest/doctest.h      # MIT, v2.4.11

 types.hpp ◄── window.hpp ◄── gc.cpp, zdna.cpp, thermo.cpp
 types.hpp ◄── encode.cpp, kmer.cpp, cgr.cpp
 hs_core (static lib, PIC) ◄── helixsight_core (pybind11 module)   and   hs_tests (standalone, no Python)
```
**Rules:** the core library has no Python, NumPy or pybind11 dependency (testable standalone); no exceptions cross `noexcept` kernels (`encode_into`, `cgr_points`); all other validation throws `std::invalid_argument` / `std::out_of_range`, which pybind11 maps to `ValueError` / `IndexError`; no global mutable state; no SIMD intrinsics (portable wheel; compiler auto-vectorizes the prefix-sum loops).

### 2.2 Complexity and measured speed

| Kernel | Time | Extra memory | Measured, 1 Mbp random (this sandbox) |
|---|---|---|---|
| `gc_per_position` | O(L) | 3·4·L B (prefix sums) | 14 ms (window 100) |
| `thermo_per_position` | O(L) (w ≤ 32 even: rolling hash; else O(L·w) only for the symmetry check) | 16·L + 8·L B + window arrays | 39 ms (window 20) |
| `zdna_per_position` | O(L) | 12·L B | 10 ms |
| `cgr_points` | O(L) | none | 2 ms |
| `kmer_matrix` k=4, win 1024/stride 256 | O(L + n_win·4^k) | 4·L B + 4^k·4 B | 3.3 ms (3,904 windows) |
| `thermo_window` (one mutation window) | O(window) | none | microseconds |

Native total ≈ 65 ms/Mbp, inside the doc 01 §14 budget (< 100 ms). Peak transient memory at 5 Mbp ≈ 200 MB (prefix arrays), freed when each call returns.

---

## 3. C++ SOURCE (COMPLETE)

### 3.1 `include/helixsight/version.hpp`
```cpp
#pragma once
#define HS_CORE_VERSION "0.1.0"
#define HS_CORE_ABI 1
```
Bump `HS_CORE_ABI` on any signature change; `native.py` refuses to load a mismatched ABI.

### 3.2 `include/helixsight/types.hpp`
```cpp
#pragma once
#include <cstddef>
#include <cstdint>
#include <limits>

namespace hs {

// Canonical base codes shared with Python/TypeScript (doc 00 section 6).
inline constexpr std::uint8_t kBaseA = 0, kBaseC = 1, kBaseG = 2, kBaseT = 3, kBaseN = 4;
inline constexpr float kNaNf = std::numeric_limits<float>::quiet_NaN();
inline constexpr unsigned kMaxK = 8;

[[nodiscard]] constexpr bool is_acgt(std::uint8_t b) noexcept { return b < 4; }

}  // namespace hs
```

### 3.3 `include/helixsight/window.hpp`
```cpp
#pragma once
#include <cstddef>
#include <stdexcept>

namespace hs {

// Centered, shift-clamped window rule used by every per-position channel.
//   effective width w = min(window, L)
//   window for position i starts at clamp(i - w/2, 0, L - w)
// The window width is therefore constant (edge values are comparable); positions near
// the ends share the first/last window instead of using truncated ones.
struct WindowPlan {
  std::size_t L = 0;
  std::size_t w = 0;
  std::size_t n_windows = 0;  // L - w + 1 distinct window starts

  [[nodiscard]] std::size_t start_for(std::size_t i) const noexcept {
    const std::size_t half = w / 2;
    const std::size_t s = i >= half ? i - half : 0;
    const std::size_t max_s = L - w;
    return s < max_s ? s : max_s;
  }
};

inline WindowPlan plan_windows(std::size_t L, std::size_t window) {
  if (window == 0) throw std::invalid_argument("window must be >= 1");
  WindowPlan p;
  p.L = L;
  p.w = window < L ? window : L;
  p.n_windows = (L == 0) ? 0 : (L - p.w + 1);
  return p;
}

}  // namespace hs
```

### 3.4 `include/helixsight/encode.hpp` and `src/encode.cpp`
```cpp
#pragma once
#include <cstdint>
#include <string_view>

namespace hs {

// Encodes an IUPAC nucleotide string into codes A0 C1 G2 T3, everything ambiguous -> 4.
// 'U'/'u' map to 3 (RNA is folded onto DNA upstream, this is a safety net).
// `out` must hold s.size() bytes. Returns -1 on success, otherwise the offset of the first
// character outside the IUPAC alphabet (that position is written as 4).
std::int64_t encode_into(std::string_view s, std::uint8_t* out) noexcept;

[[nodiscard]] inline char decode_base(std::uint8_t code) noexcept {
  return "ACGTN"[code > 4 ? 4 : code];
}

}  // namespace hs
```
```cpp
#include "helixsight/encode.hpp"

#include <array>
#include <cstddef>

#include "helixsight/types.hpp"

namespace hs {
namespace {

constexpr std::uint8_t kInvalid = 0xFF;

constexpr std::array<std::uint8_t, 256> make_lut() {
  std::array<std::uint8_t, 256> t{};
  for (auto& v : t) v = kInvalid;
  auto set = [&t](char upper, std::uint8_t v) {
    t[static_cast<unsigned char>(upper)] = v;
    t[static_cast<unsigned char>(upper) + 32] = v;  // lowercase (soft-masked FASTA)
  };
  set('A', kBaseA);
  set('C', kBaseC);
  set('G', kBaseG);
  set('T', kBaseT);
  set('U', kBaseT);
  for (char c : {'R', 'Y', 'S', 'W', 'K', 'M', 'B', 'D', 'H', 'V', 'N'}) set(c, kBaseN);
  return t;
}

constexpr auto kLut = make_lut();

}  // namespace

std::int64_t encode_into(std::string_view s, std::uint8_t* out) noexcept {
  std::int64_t first_bad = -1;
  for (std::size_t i = 0; i < s.size(); ++i) {
    std::uint8_t v = kLut[static_cast<unsigned char>(s[i])];
    if (v == kInvalid) {
      if (first_bad < 0) first_bad = static_cast<std::int64_t>(i);
      v = kBaseN;
    }
    out[i] = v;
  }
  return first_bad;
}

}  // namespace hs
```

### 3.5 `include/helixsight/gc.hpp` and `src/gc.cpp`
```cpp
#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {

// Per-position windowed GC% (0..100) and GC skew (G-C)/(G+C) in [-1,1].
// Ambiguity codes are excluded from the denominator. NaN when a window has no A/C/G/T
// (GC%) or no G/C (skew). Window rule: see window.hpp. out_gc/out_skew hold L floats.
void gc_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window, float* out_gc,
                     float* out_skew);

}  // namespace hs
```
```cpp
#include "helixsight/gc.hpp"

#include <vector>

#include "helixsight/types.hpp"
#include "helixsight/window.hpp"

namespace hs {

void gc_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window, float* out_gc,
                     float* out_skew) {
  if (L == 0) return;
  const WindowPlan wp = plan_windows(L, window);

  std::vector<std::uint32_t> pg(L + 1, 0), pc(L + 1, 0), pu(L + 1, 0);
  for (std::size_t i = 0; i < L; ++i) {
    const std::uint8_t b = seq[i];
    pg[i + 1] = pg[i] + (b == kBaseG ? 1u : 0u);
    pc[i + 1] = pc[i] + (b == kBaseC ? 1u : 0u);
    pu[i + 1] = pu[i] + (is_acgt(b) ? 1u : 0u);
  }
  for (std::size_t i = 0; i < L; ++i) {
    const std::size_t s = wp.start_for(i);
    const std::size_t e = s + wp.w;
    const double g = static_cast<double>(pg[e] - pg[s]);
    const double c = static_cast<double>(pc[e] - pc[s]);
    const double u = static_cast<double>(pu[e] - pu[s]);
    out_gc[i] = u > 0.0 ? static_cast<float>(100.0 * (g + c) / u) : kNaNf;
    out_skew[i] = (g + c) > 0.0 ? static_cast<float>((g - c) / (g + c)) : kNaNf;
  }
}

}  // namespace hs
```

### 3.6 `include/helixsight/kmer.hpp` and `src/kmer.cpp`
```cpp
#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {

// Number of windows kmer_matrix will emit. Windows start at i*stride; the last one may be
// shorter than `window` so every position is covered. Requires window >= 1, stride >= 1.
std::size_t kmer_n_windows(std::size_t L, std::size_t window, std::size_t stride);

// Counts k-mers (k in [1,8]) per window with an incremental add/remove sweep.
// out: row-major [n_windows x 4^k] uint32. k-mer index: earliest base is the most
// significant 2 bits (h = ((h << 2) | b) & mask). K-mers containing an ambiguity code are
// skipped. Constraints: window >= k, 1 <= stride <= window (else std::invalid_argument).
void kmer_matrix(const std::uint8_t* seq, std::size_t L, unsigned k, std::size_t window,
                 std::size_t stride, std::uint32_t* out);

}  // namespace hs
```
```cpp
#include "helixsight/kmer.hpp"

#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <vector>

#include "helixsight/types.hpp"

namespace hs {

std::size_t kmer_n_windows(std::size_t L, std::size_t window, std::size_t stride) {
  if (window == 0 || stride == 0) throw std::invalid_argument("window and stride must be >= 1");
  if (L == 0) return 0;
  if (L <= window) return 1;
  return (L - window + stride - 1) / stride + 1;
}

void kmer_matrix(const std::uint8_t* seq, std::size_t L, unsigned k, std::size_t window,
                 std::size_t stride, std::uint32_t* out) {
  if (k < 1 || k > kMaxK) throw std::invalid_argument("k must be in [1, 8]");
  if (window < k) throw std::invalid_argument("window must be >= k");
  if (stride == 0 || stride > window) throw std::invalid_argument("stride must be in [1, window]");
  const std::size_t n_win = kmer_n_windows(L, window, stride);
  if (n_win == 0) return;

  const std::size_t ncell = std::size_t{1} << (2 * k);
  const std::uint32_t mask = static_cast<std::uint32_t>(ncell - 1);
  constexpr std::uint32_t kInvalid = 0xFFFFFFFFu;

  // kidx[j] = index of the k-mer ENDING at j, or kInvalid (j < k-1 or ambiguity inside).
  std::vector<std::uint32_t> kidx(L, kInvalid);
  {
    std::uint32_t h = 0;
    std::size_t run = 0;
    for (std::size_t j = 0; j < L; ++j) {
      const std::uint8_t b = seq[j];
      if (b > 3) {
        run = 0;
        h = 0;
        continue;
      }
      h = ((h << 2) | b) & mask;
      if (++run >= k) kidx[j] = h;
    }
  }

  // Window i covers bases [s, e); it contains the k-mers ending at j in [s+k-1, e).
  std::vector<std::uint32_t> cur(ncell, 0);
  std::size_t lo = 0, hi = 0;  // current j-range [lo, hi)
  for (std::size_t i = 0; i < n_win; ++i) {
    const std::size_t s = i * stride;
    const std::size_t e = std::min(L, s + window);
    const std::size_t nlo = std::min(s + k - 1, L);
    const std::size_t nhi = std::max(e, nlo);
    for (std::size_t j = lo, end = std::min(hi, nlo); j < end; ++j)
      if (kidx[j] != kInvalid) --cur[kidx[j]];
    for (std::size_t j = std::max(hi, nlo); j < nhi; ++j)
      if (kidx[j] != kInvalid) ++cur[kidx[j]];
    lo = nlo;
    hi = nhi;
    std::memcpy(out + i * ncell, cur.data(), ncell * sizeof(std::uint32_t));
  }
}

}  // namespace hs
```
**Why the sweep is correct:** window *i* owns the k-mer end positions `j ∈ [lo_i, hi_i)` with `lo_i = s_i+k−1`, `hi_i = max(e_i, lo_i)`. Both bounds are non-decreasing, so moving to window *i+1* removes `[lo_i, min(hi_i, lo_{i+1}))` and adds `[max(hi_i, lo_{i+1}), hi_{i+1})` — this also handles disjoint windows (stride = window) because `min/max` then degrade to "remove everything, add everything". `stride ≤ window` guarantees the last window start is `< L`. Verified against brute force for k ∈ {1,3,4} with ambiguity codes and a short last window.

### 3.7 `include/helixsight/cgr.hpp` and `src/cgr.cpp`
```cpp
#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {

// Chaos Game Representation. Corners A(0,0) C(0,1) G(1,1) T(1,0); start (0.5,0.5);
// p_i = (p_{i-1} + corner(b_i)) / 2 computed in double, stored as float.
// An ambiguity code writes NaN and does NOT advance the state. Planar outputs of L floats.
void cgr_points(const std::uint8_t* seq, std::size_t L, float* out_x, float* out_y) noexcept;

}  // namespace hs
```
```cpp
#include "helixsight/cgr.hpp"

#include "helixsight/types.hpp"

namespace hs {

void cgr_points(const std::uint8_t* seq, std::size_t L, float* out_x, float* out_y) noexcept {
  double x = 0.5, y = 0.5;
  for (std::size_t i = 0; i < L; ++i) {
    const std::uint8_t b = seq[i];
    if (b > 3) {
      out_x[i] = kNaNf;
      out_y[i] = kNaNf;
      continue;
    }
    const double cx = static_cast<double>(b >> 1);               // A0 C0 G1 T1
    const double cy = static_cast<double>((b & 1u) ^ (b >> 1));  // A0 C1 G1 T0
    x = 0.5 * (x + cx);
    y = 0.5 * (y + cy);
    out_x[i] = static_cast<float>(x);
    out_y[i] = static_cast<float>(y);
  }
}

}  // namespace hs
```
The corner bit formulas (`x = b>>1`, `y = (b&1)^(b>>1)`) are the same ones the TypeScript FCGR worker uses (doc 02 §6.3), so the float trail and the integer density grid agree on orientation.

### 3.8 `include/helixsight/zdna.hpp` and `src/zdna.cpp`
```cpp
#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {

// Z-DNA propensity heuristic in [0,1] (NOT Z-Hunt; research heuristic, doc 00 C-9).
// Dinucleotide step scores reward alternating purine/pyrimidine runs: CG,GC=1.0;
// CA,TG,AC,GT=0.6; TA,AT=0.3; others 0. Window mean of step scores is rescaled against the
// random-sequence expectation: z = clip((mean - 0.3125) / (1 - 0.3125), 0, 1).
// NaN if the window contains an ambiguity code or has fewer than 2 bases.
void zdna_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window, float* out_z);

}  // namespace hs
```
```cpp
#include "helixsight/zdna.hpp"

#include <algorithm>
#include <array>
#include <vector>

#include "helixsight/types.hpp"
#include "helixsight/window.hpp"

namespace hs {
namespace {

constexpr double kRandomBaseline = 0.3125;  // 2/16*1.0 + 4/16*0.6 + 2/16*0.3

constexpr std::array<double, 16> make_steps() {
  std::array<double, 16> t{};  // zero-initialised
  constexpr int A = 0, C = 1, G = 2, T = 3;
  auto set = [&t](int a, int b, double v) { t[static_cast<std::size_t>(4 * a + b)] = v; };
  set(C, G, 1.0);
  set(G, C, 1.0);
  set(C, A, 0.6);
  set(T, G, 0.6);
  set(A, C, 0.6);
  set(G, T, 0.6);
  set(T, A, 0.3);
  set(A, T, 0.3);
  return t;
}
constexpr auto kStep = make_steps();

}  // namespace

void zdna_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window, float* out_z) {
  if (L == 0) return;
  const WindowPlan wp = plan_windows(L, window);
  if (wp.w < 2) {
    std::fill(out_z, out_z + L, kNaNf);
    return;
  }
  std::vector<double> ps(L, 0.0);  // ps[j] = sum of step scores over steps 0..j-1
  std::vector<std::uint32_t> pa(L + 1, 0);
  for (std::size_t j = 0; j < L; ++j) {
    pa[j + 1] = pa[j] + (is_acgt(seq[j]) ? 0u : 1u);
    if (j + 1 < L) {
      const std::uint8_t a = seq[j], b = seq[j + 1];
      ps[j + 1] = ps[j] + ((a < 4 && b < 4) ? kStep[static_cast<std::size_t>(4 * a + b)] : 0.0);
    }
  }
  for (std::size_t i = 0; i < L; ++i) {
    const std::size_t s = wp.start_for(i);
    const std::size_t e = s + wp.w;
    if (pa[e] - pa[s] != 0) {
      out_z[i] = kNaNf;
      continue;
    }
    const double mean = (ps[s + wp.w - 1] - ps[s]) / static_cast<double>(wp.w - 1);
    const double z = (mean - kRandomBaseline) / (1.0 - kRandomBaseline);
    out_z[i] = static_cast<float>(std::clamp(z, 0.0, 1.0));
  }
}

}  // namespace hs
```
`(CA)n` scores `(0.6−0.3125)/0.6875 = 0.418`, a `CG` repeat saturates at 1.0, poly-A is 0; the UI's "Z badge" threshold (doc 02 §5.8) is `> 0.5`, i.e. essentially CG-rich alternating tracts.

### 3.9 `include/helixsight/thermo.hpp`
```cpp
#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {

struct ThermoParams {
  double na_mM = 50.0;       // monovalent cation concentration (mM)
  double strand_nM = 250.0;  // total strand concentration C_T (nM)
  double temp_c = 37.0;      // temperature for dG (deg C)
};

struct ThermoResult {
  double tm_c;     // melting temperature, deg C
  double dg_kcal;  // dG at temp_c, kcal/mol (more negative = more stable)
  double dh_kcal;  // total dH, kcal/mol
  double ds_cal;   // total dS (salt corrected), cal/(K mol)
  bool self_complementary;
};

// SantaLucia (1998) unified nearest-neighbour model, DNA/DNA, with
//   - terminal initiation per end (G.C or A.T), symmetry correction dS = -1.4 if the window
//     equals its own reverse complement,
//   - salt correction dS(Na) = dS(1M) + 0.368 * (N-1) * ln[Na+]  (N = window length),
//   - Tm = dH*1000 / (dS + R ln(C_T / x)), x = 4 (non-self-comp) or 1 (self-comp).
// Direct O(len) evaluation of one window [start, start+len). NaN fields if the window has an
// ambiguity code or len < 2. Throws std::invalid_argument/out_of_range on bad inputs.
ThermoResult thermo_window(const std::uint8_t* seq, std::size_t L, std::size_t start,
                           std::size_t len, const ThermoParams& p);

// Per-position Tm/dG over centered shift-clamped windows (window.hpp), O(L) via prefix sums
// of dH/dS and a rolling forward/reverse-complement hash for the symmetry test (even windows
// <= 32; longer windows fall back to an O(window) check). Requires window >= 2.
void thermo_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window,
                         const ThermoParams& p, float* out_tm, float* out_dg);

}  // namespace hs
```

### 3.10 `src/thermo.cpp`
```cpp
#include "helixsight/thermo.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <vector>

#include "helixsight/types.hpp"
#include "helixsight/window.hpp"

namespace hs {
namespace {

struct NN {
  double dh;  // kcal/mol
  double ds;  // cal/(K mol)
};

// Index = 4*b0 + b1 for the TOP-strand dinucleotide 5'-b0 b1-3' (A0 C1 G2 T3).
// A dinucleotide and its reverse complement are the same stack (e.g. CA/GT == TG/AC).
constexpr std::array<NN, 16> make_nn() {
  std::array<NN, 16> t{};
  constexpr int A = 0, C = 1, G = 2, T = 3;
  auto set = [&t](int a, int b, NN v) { t[static_cast<std::size_t>(4 * a + b)] = v; };
  constexpr NN k_aa{-7.9, -22.2}, k_at{-7.2, -20.4}, k_ta{-7.2, -21.3}, k_ca{-8.5, -22.7},
      k_gt{-8.4, -22.4}, k_ct{-7.8, -21.0}, k_ga{-8.2, -22.2}, k_cg{-10.6, -27.2},
      k_gc{-9.8, -24.4}, k_gg{-8.0, -19.9};
  set(A, A, k_aa);  set(T, T, k_aa);
  set(A, T, k_at);
  set(T, A, k_ta);
  set(C, A, k_ca);  set(T, G, k_ca);
  set(G, T, k_gt);  set(A, C, k_gt);
  set(C, T, k_ct);  set(A, G, k_ct);
  set(G, A, k_ga);  set(T, C, k_ga);
  set(C, G, k_cg);
  set(G, C, k_gc);
  set(G, G, k_gg);  set(C, C, k_gg);
  return t;
}
constexpr auto kNN = make_nn();

constexpr double kInitGC_dH = 0.1, kInitGC_dS = -2.8;  // terminal G.C pair
constexpr double kInitAT_dH = 2.3, kInitAT_dS = 4.1;   // terminal A.T pair
constexpr double kSymmetry_dS = -1.4;
constexpr double kR = 1.987;  // cal/(K mol)

inline NN step(std::uint8_t a, std::uint8_t b) noexcept {
  return (a < 4 && b < 4) ? kNN[static_cast<std::size_t>(4 * a + b)] : NN{0.0, 0.0};
}

inline void add_terminal(std::uint8_t b, double& dh, double& ds) noexcept {
  if (b == kBaseG || b == kBaseC) {
    dh += kInitGC_dH;
    ds += kInitGC_dS;
  } else {
    dh += kInitAT_dH;
    ds += kInitAT_dS;
  }
}

bool direct_self_comp(const std::uint8_t* p, std::size_t w) noexcept {
  if (w % 2 != 0) return false;  // odd length: the middle base cannot pair with itself
  for (std::size_t i = 0; i < w / 2; ++i) {
    const std::uint8_t a = p[i], b = p[w - 1 - i];
    if (a > 3 || b > 3 || a + b != 3) return false;  // A+T = 0+3, C+G = 1+2
  }
  return true;
}

void validate(const ThermoParams& p) {
  if (!(p.na_mM > 0.0) || !(p.strand_nM > 0.0) || !std::isfinite(p.temp_c))
    throw std::invalid_argument("thermo params: na_mM and strand_nM must be > 0, temp_c finite");
}

ThermoResult nan_result() {
  const double n = std::numeric_limits<double>::quiet_NaN();
  return {n, n, n, n, false};
}

ThermoResult finalize(double dh, double ds, std::size_t len, bool self_comp,
                      const ThermoParams& p) {
  if (self_comp) ds += kSymmetry_dS;
  const double na = p.na_mM * 1e-3;
  const double ds_salt = ds + 0.368 * static_cast<double>(len - 1) * std::log(na);
  const double ct = p.strand_nM * 1e-9;
  const double x = self_comp ? 1.0 : 4.0;
  const double tm_k = (dh * 1000.0) / (ds_salt + kR * std::log(ct / x));
  const double t_k = p.temp_c + 273.15;
  ThermoResult r{tm_k - 273.15, dh - t_k * ds_salt / 1000.0, dh, ds_salt, self_comp};
  if (!std::isfinite(r.tm_c) || !std::isfinite(r.dg_kcal)) return nan_result();
  return r;
}

}  // namespace

ThermoResult thermo_window(const std::uint8_t* seq, std::size_t L, std::size_t start,
                           std::size_t len, const ThermoParams& p) {
  validate(p);
  if (start > L || len > L - start) throw std::out_of_range("thermo_window: window outside sequence");
  if (len < 2) return nan_result();
  double dh = 0.0, ds = 0.0;
  for (std::size_t j = start; j + 1 < start + len; ++j) {
    if (seq[j] > 3 || seq[j + 1] > 3) return nan_result();
    const NN n = step(seq[j], seq[j + 1]);
    dh += n.dh;
    ds += n.ds;
  }
  add_terminal(seq[start], dh, ds);
  add_terminal(seq[start + len - 1], dh, ds);
  return finalize(dh, ds, len, direct_self_comp(seq + start, len), p);
}

void thermo_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window,
                         const ThermoParams& p, float* out_tm, float* out_dg) {
  validate(p);
  if (window < 2) throw std::invalid_argument("thermo window must be >= 2");
  if (L == 0) return;
  const WindowPlan wp = plan_windows(L, window);
  const std::size_t w = wp.w;
  if (w < 2) {  // L == 1
    std::fill(out_tm, out_tm + L, kNaNf);
    std::fill(out_dg, out_dg + L, kNaNf);
    return;
  }

  // Prefix sums over steps: pH[j] = sum of dH over steps 0..j-1 (step j joins bases j, j+1).
  std::vector<double> pH(L, 0.0), pS(L, 0.0);
  std::vector<std::uint32_t> pa(L + 1, 0);
  for (std::size_t j = 0; j < L; ++j) {
    pa[j + 1] = pa[j] + (is_acgt(seq[j]) ? 0u : 1u);
    if (j + 1 < L) {
      const NN n = step(seq[j], seq[j + 1]);
      pH[j + 1] = pH[j] + n.dh;
      pS[j + 1] = pS[j] + n.ds;
    }
  }

  std::vector<float> tmw(wp.n_windows, kNaNf), dgw(wp.n_windows, kNaNf);
  const bool rolling = (w % 2 == 0) && (w <= 32);
  const std::uint64_t mask =
      !rolling ? 0 : (w == 32 ? ~std::uint64_t{0} : ((std::uint64_t{1} << (2 * w)) - 1));
  const unsigned top_shift = rolling ? static_cast<unsigned>(2 * (w - 1)) : 0u;
  std::uint64_t F = 0, R = 0;  // forward / reverse-complement hash of the last w bases

  for (std::size_t e = 0; e < L; ++e) {
    const std::uint8_t b = seq[e];
    if (b > 3) {
      F = 0;
      R = 0;
    } else if (rolling) {
      F = ((F << 2) | b) & mask;
      R = (R >> 2) | (static_cast<std::uint64_t>(3 - b) << top_shift);
    }
    if (e + 1 < w) continue;
    const std::size_t s = e + 1 - w;  // window [s, e]
    if (pa[e + 1] - pa[s] != 0) continue;
    double dh = pH[s + w - 1] - pH[s];
    double ds = pS[s + w - 1] - pS[s];
    add_terminal(seq[s], dh, ds);
    add_terminal(seq[e], dh, ds);
    const bool self = rolling ? (F == R) : direct_self_comp(seq + s, w);
    const ThermoResult r = finalize(dh, ds, w, self, p);
    tmw[s] = static_cast<float>(r.tm_c);
    dgw[s] = static_cast<float>(r.dg_kcal);
  }

  for (std::size_t i = 0; i < L; ++i) {
    const std::size_t s = wp.start_for(i);
    out_tm[i] = tmw[s];
    out_dg[i] = dgw[s];
  }
}

}  // namespace hs
```

**Thermodynamic model, exactly as implemented**

| Item | Value |
|---|---|
| Nearest-neighbour stacks (ΔH kcal/mol, ΔS cal/K·mol) | AA/TT −7.9, −22.2 · AT/TA −7.2, −20.4 · TA/AT −7.2, −21.3 · CA/GT −8.5, −22.7 · GT/CA −8.4, −22.4 · CT/GA −7.8, −21.0 · GA/CT −8.2, −22.2 · CG/GC −10.6, −27.2 · GC/CG −9.8, −24.4 · GG/CC −8.0, −19.9 |
| Initiation per terminal pair | G·C: +0.1, −2.8 · A·T: +2.3, +4.1 |
| Symmetry | ΔS −1.4 if window = its reverse complement |
| Salt | `ΔS += 0.368·(N−1)·ln[Na⁺]`, `N` = window length, `[Na⁺]` in M |
| Tm | `ΔH·1000 / (ΔS + R·ln(C_T/x)) − 273.15`, `R = 1.987`, `x = 4` or `1` (self-complementary) |
| ΔG | `ΔH − T·ΔS/1000` with the salt-corrected ΔS, `T = temp_c + 273.15` |

Hand-computed regression anchors (tests below): `CGCGCG` at 1 M Na⁺ → ΔH −51.2, ΔS −137.4, ΔG₃₇ −8.585, Tm ≈ 32.3 °C; `AAAAAA` → ΔH −34.9, ΔS −102.8, ΔG₃₇ −3.017.

The rolling reverse-complement hash keeps a forward value `F` (oldest base most significant) and `R = revcomp` (newest base's complement at the top slot, oldest falls off the bottom on `>> 2`). A window is its own reverse complement iff `F == R`; ambiguity resets both, and windows containing an ambiguity are skipped before the hash is read.

---

## 4. PYBIND11 BINDINGS — `bindings/module.cpp`

```cpp
// pybind11 bindings for helixsight_core.
// Rules (doc 01 section 5): inputs are read-only C-contiguous uint8 arrays; outputs are
// PREALLOCATED, writable, C-contiguous arrays owned by Python (never allocated here); every
// array argument is `noconvert` so a dtype mismatch raises TypeError instead of silently
// copying; the GIL is released around all heavy loops.
#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

#include "helixsight/cgr.hpp"
#include "helixsight/encode.hpp"
#include "helixsight/gc.hpp"
#include "helixsight/kmer.hpp"
#include "helixsight/thermo.hpp"
#include "helixsight/types.hpp"
#include "helixsight/version.hpp"
#include "helixsight/window.hpp"
#include "helixsight/zdna.hpp"

namespace py = pybind11;

namespace {

template <class T>
using Arr = py::array_t<T, py::array::c_style>;

const std::uint8_t* in_seq(const Arr<std::uint8_t>& a, std::size_t* n) {
  if (a.ndim() != 1) throw std::invalid_argument("seq: expected a 1-D uint8 array");
  *n = static_cast<std::size_t>(a.shape(0));
  return a.data();
}

template <class T>
T* out_1d(Arr<T>& a, std::size_t expected, const char* name) {
  if (a.ndim() != 1 || static_cast<std::size_t>(a.shape(0)) != expected)
    throw std::invalid_argument(std::string(name) + ": expected a 1-D array of length " +
                                std::to_string(expected));
  return a.mutable_data();  // throws if the array is read-only
}

hs::ThermoParams make_params(double na_mM, double strand_nM, double temp_c) {
  hs::ThermoParams p;
  p.na_mM = na_mM;
  p.strand_nM = strand_nM;
  p.temp_c = temp_c;
  return p;
}

std::string compiler_string() {
#if defined(__clang__)
  return std::string("clang ") + __clang_version__;
#elif defined(__GNUC__)
  return std::string("gcc ") + __VERSION__;
#elif defined(_MSC_VER)
  return "msvc " + std::to_string(_MSC_VER);
#else
  return "unknown";
#endif
}

}  // namespace

PYBIND11_MODULE(helixsight_core, m) {
  m.doc() = "HelixSight native bio engine: encoding, GC, thermodynamics, k-mers, CGR, Z-propensity";
  m.attr("__version__") = HS_CORE_VERSION;
  m.attr("abi_version") = HS_CORE_ABI;

  m.def(
      "build_info",
      [] {
        py::dict d;
        d["version"] = HS_CORE_VERSION;
        d["abi"] = HS_CORE_ABI;
        d["compiler"] = compiler_string();
        d["cplusplus"] = static_cast<long>(__cplusplus);
        d["pointer_bits"] = static_cast<int>(sizeof(void*) * 8);
        return d;
      },
      "Build metadata (version, ABI, compiler, C++ standard).");

  m.def(
      "encode_into",
      [](std::string_view seq, Arr<std::uint8_t> out) {
        std::uint8_t* o = out_1d(out, seq.size(), "out");
        std::int64_t bad;
        {
          py::gil_scoped_release nogil;
          bad = hs::encode_into(seq, o);
        }
        return bad;
      },
      py::arg("seq"), py::arg("out").noconvert(),
      "Encode an IUPAC string into uint8 codes (A0 C1 G2 T3 N4). Returns -1 or the offset of "
      "the first invalid character.");

  m.def(
      "gc_per_position",
      [](Arr<std::uint8_t> seq, std::size_t window, Arr<float> out_gc, Arr<float> out_skew) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        float* g = out_1d(out_gc, n, "out_gc");
        float* k = out_1d(out_skew, n, "out_skew");
        py::gil_scoped_release nogil;
        hs::gc_per_position(s, n, window, g, k);
      },
      py::arg("seq").noconvert(), py::arg("window"), py::arg("out_gc").noconvert(),
      py::arg("out_skew").noconvert(), "Windowed GC% and GC skew per position.");

  m.def(
      "thermo_per_position",
      [](Arr<std::uint8_t> seq, std::size_t window, double na_mM, double strand_nM,
         double temp_c, Arr<float> out_tm, Arr<float> out_dg) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        float* tm = out_1d(out_tm, n, "out_tm");
        float* dg = out_1d(out_dg, n, "out_dg");
        const hs::ThermoParams p = make_params(na_mM, strand_nM, temp_c);
        py::gil_scoped_release nogil;
        hs::thermo_per_position(s, n, window, p, tm, dg);
      },
      py::arg("seq").noconvert(), py::arg("window"), py::arg("na_mM") = 50.0,
      py::arg("strand_nM") = 250.0, py::arg("temp_c") = 37.0, py::arg("out_tm").noconvert(),
      py::arg("out_dg").noconvert(),
      "SantaLucia 1998 nearest-neighbour Tm (C) and dG (kcal/mol) per position.");

  m.def(
      "thermo_at",
      [](Arr<std::uint8_t> seq, std::size_t pos, std::size_t window, double na_mM,
         double strand_nM, double temp_c) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        if (pos >= n) throw std::out_of_range("pos out of range");
        const hs::ThermoParams p = make_params(na_mM, strand_nM, temp_c);
        const hs::WindowPlan wp = hs::plan_windows(n, window);
        hs::ThermoResult r;
        {
          py::gil_scoped_release nogil;
          r = hs::thermo_window(s, n, wp.start_for(pos), wp.w, p);
        }
        return py::make_tuple(r.tm_c, r.dg_kcal, r.dh_kcal, r.ds_cal, r.self_complementary);
      },
      py::arg("seq").noconvert(), py::arg("pos"), py::arg("window"), py::arg("na_mM") = 50.0,
      py::arg("strand_nM") = 250.0, py::arg("temp_c") = 37.0,
      "Thermodynamics of the single window centered on pos: (tm_c, dg_kcal, dh_kcal, ds_cal, "
      "self_complementary). Used for mutation deltas.");

  m.def(
      "zdna_per_position",
      [](Arr<std::uint8_t> seq, std::size_t window, Arr<float> out_z) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        float* z = out_1d(out_z, n, "out_z");
        py::gil_scoped_release nogil;
        hs::zdna_per_position(s, n, window, z);
      },
      py::arg("seq").noconvert(), py::arg("window"), py::arg("out_z").noconvert(),
      "Z-DNA propensity heuristic in [0,1] per position.");

  m.def(
      "cgr_points",
      [](Arr<std::uint8_t> seq, Arr<float> out_x, Arr<float> out_y) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        float* x = out_1d(out_x, n, "out_x");
        float* y = out_1d(out_y, n, "out_y");
        py::gil_scoped_release nogil;
        hs::cgr_points(s, n, x, y);
      },
      py::arg("seq").noconvert(), py::arg("out_x").noconvert(), py::arg("out_y").noconvert(),
      "Chaos Game Representation coordinates (planar x, y).");

  m.def("kmer_n_windows", &hs::kmer_n_windows, py::arg("length"), py::arg("window"),
        py::arg("stride"), "Number of rows kmer_matrix will write.");

  m.def(
      "kmer_matrix",
      [](Arr<std::uint8_t> seq, unsigned k, std::size_t window, std::size_t stride,
         Arr<std::uint32_t> out_counts) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        const std::size_t rows = hs::kmer_n_windows(n, window, stride);
        if (k < 1 || k > hs::kMaxK) throw std::invalid_argument("k must be in [1, 8]");
        const std::size_t cols = std::size_t{1} << (2 * k);
        if (out_counts.ndim() != 2 || static_cast<std::size_t>(out_counts.shape(0)) != rows ||
            static_cast<std::size_t>(out_counts.shape(1)) != cols)
          throw std::invalid_argument("out_counts: expected shape (" + std::to_string(rows) +
                                      ", " + std::to_string(cols) + ")");
        std::uint32_t* o = out_counts.mutable_data();
        py::gil_scoped_release nogil;
        hs::kmer_matrix(s, n, k, window, stride, o);
      },
      py::arg("seq").noconvert(), py::arg("k"), py::arg("window"), py::arg("stride"),
      py::arg("out_counts").noconvert(), "Sliding-window k-mer counts, shape (n_windows, 4**k).");
}
```

### 4.1 Python API (final names; supersedes doc 01 §5 listing)

| Python call | Writes into | Returns |
|---|---|---|
| `encode_into(seq: str, out: u8[L])` | `out` | `-1` or first invalid offset |
| `gc_per_position(seq: u8[L], window, out_gc: f32[L], out_skew: f32[L])` | both | `None` |
| `thermo_per_position(seq, window, na_mM, strand_nM, temp_c, out_tm: f32[L], out_dg: f32[L])` | both | `None` |
| `thermo_at(seq, pos, window, na_mM, strand_nM, temp_c)` | – | `(tm_c, dg_kcal, dh_kcal, ds_cal, self_complementary)` |
| `zdna_per_position(seq, window, out_z: f32[L])` | `out_z` | `None` |
| `cgr_points(seq, out_x: f32[L], out_y: f32[L])` | both | `None` |
| `kmer_n_windows(length, window, stride)` | – | `int` |
| `kmer_matrix(seq, k, window, stride, out_counts: u32[nWin, 4**k])` | `out_counts` | `None` |
| `__version__`, `abi_version`, `build_info()` | – | metadata |

**Error semantics (observed):** read-only output → `ValueError: array is not writeable`; wrong length/shape → `ValueError`; wrong dtype → `TypeError` (noconvert); `k` outside 1–8, `stride > window`, non-positive thermo params → `ValueError`; `pos` out of range → `IndexError`.

---

## 5. BUILD FILES

### 5.1 `cpp_core/CMakeLists.txt`
```cmake
cmake_minimum_required(VERSION 3.20)
project(helixsight_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

option(HS_BUILD_PYTHON "Build the pybind11 module" ON)
option(HS_BUILD_TESTS  "Build the doctest suite (standalone, no Python needed)" OFF)
option(HS_SANITIZE     "Enable ASan + UBSan (GCC/Clang)" OFF)

add_library(hs_core STATIC
  src/encode.cpp src/gc.cpp src/kmer.cpp src/cgr.cpp src/thermo.cpp src/zdna.cpp)
target_include_directories(hs_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
set_target_properties(hs_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_options(hs_core PRIVATE
  $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-Wall -Wextra -Wpedantic>
  $<$<CXX_COMPILER_ID:MSVC>:/W4 /permissive->)
if(HS_SANITIZE AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(hs_core PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(hs_core PUBLIC -fsanitize=address,undefined)
endif()

if(HS_BUILD_PYTHON)
  find_package(Python 3.11 COMPONENTS Interpreter Development.Module REQUIRED)
  find_package(pybind11 CONFIG REQUIRED)
  pybind11_add_module(helixsight_core MODULE bindings/module.cpp)
  target_link_libraries(helixsight_core PRIVATE hs_core)
  install(TARGETS helixsight_core LIBRARY DESTINATION .)   # lands at the wheel root -> `import helixsight_core`
endif()

if(HS_BUILD_TESTS)
  enable_testing()
  add_executable(hs_tests tests/test_core.cpp)
  target_include_directories(hs_tests PRIVATE third_party/doctest)
  target_link_libraries(hs_tests PRIVATE hs_core)
  add_test(NAME hs_tests COMMAND hs_tests)
endif()
```

### 5.2 `cpp_core/pyproject.toml`
```toml
[build-system]
requires = ["scikit-build-core>=0.10", "pybind11>=2.13"]
build-backend = "scikit_build_core.build"

[project]
name = "helixsight-core"
dynamic = ["version"]
description = "HelixSight native bio engine (C++20 + pybind11)"
requires-python = ">=3.11"
dependencies = ["numpy>=1.26"]
license = { text = "MIT" }

[tool.scikit-build]
minimum-version = "build-system.requires"
cmake.version = ">=3.20"
cmake.build-type = "Release"
build-dir = "build/{wheel_tag}"
wheel.packages = []
sdist.include = ["third_party/doctest/doctest.h"]

[tool.scikit-build.cmake.define]
HS_BUILD_TESTS = "OFF"
HS_BUILD_PYTHON = "ON"

# Single source of truth for the version: include/helixsight/version.hpp
[tool.scikit-build.metadata.version]
provider = "scikit_build_core.metadata.regex"
input = "include/helixsight/version.hpp"
regex = '#define HS_CORE_VERSION "(?P<value>[^"]+)"'
```
Build commands are in `05` §6. Vendoring `doctest.h` (instead of CMake `FetchContent`) avoids network access at configure time and CMake-policy breakage on new CMake releases.

---

## 6. C++ TESTS — `tests/test_core.cpp` (complete)

```cpp
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <algorithm>
#include <cmath>
#include <random>
#include <string>
#include <vector>

#include "doctest.h"
#include "helixsight/cgr.hpp"
#include "helixsight/encode.hpp"
#include "helixsight/gc.hpp"
#include "helixsight/kmer.hpp"
#include "helixsight/thermo.hpp"
#include "helixsight/window.hpp"
#include "helixsight/zdna.hpp"

using namespace hs;

namespace {

std::vector<std::uint8_t> enc(const std::string& s) {
  std::vector<std::uint8_t> v(s.size());
  REQUIRE(encode_into(s, v.data()) == -1);
  return v;
}

std::vector<std::uint8_t> random_seq(std::size_t n, unsigned seed, double p_n = 0.0) {
  std::mt19937 rng(seed);
  std::uniform_int_distribution<int> base(0, 3);
  std::uniform_real_distribution<double> u(0.0, 1.0);
  std::vector<std::uint8_t> v(n);
  for (auto& b : v) b = (u(rng) < p_n) ? 4 : static_cast<std::uint8_t>(base(rng));
  return v;
}

bool same_float(float a, float b, float tol = 1e-3f) {
  if (std::isnan(a) || std::isnan(b)) return std::isnan(a) && std::isnan(b);
  return std::fabs(a - b) <= tol * std::max(1.0f, std::fabs(a));
}

}  // namespace

TEST_CASE("encode: IUPAC, lowercase, U, invalid") {
  std::vector<std::uint8_t> out(10);
  CHECK(encode_into("ACGTacgtRN", out.data()) == -1);
  const std::vector<std::uint8_t> want{0, 1, 2, 3, 0, 1, 2, 3, 4, 4};
  CHECK(out == want);
  std::vector<std::uint8_t> o2(4);
  CHECK(encode_into("ACUG", o2.data()) == -1);
  CHECK(o2[2] == 3);
  CHECK(encode_into("AC!G", o2.data()) == 2);
  CHECK(o2[2] == 4);
  CHECK(decode_base(2) == 'G');
  CHECK(decode_base(9) == 'N');
}

TEST_CASE("window plan: centered, shift-clamped") {
  const WindowPlan p = plan_windows(10, 4);
  CHECK(p.w == 4);
  CHECK(p.n_windows == 7);
  CHECK(p.start_for(0) == 0);
  CHECK(p.start_for(2) == 0);
  CHECK(p.start_for(5) == 3);
  CHECK(p.start_for(9) == 6);
  const WindowPlan q = plan_windows(3, 100);  // window larger than sequence
  CHECK(q.w == 3);
  CHECK(q.start_for(2) == 0);
  CHECK_THROWS_AS(plan_windows(5, 0), std::invalid_argument);
}

TEST_CASE("gc: windowed values, edges, ambiguity") {
  const auto s = enc("GGCCAATT");
  std::vector<float> gc(8), sk(8);
  gc_per_position(s.data(), 8, 4, gc.data(), sk.data());
  CHECK(gc[0] == doctest::Approx(100.0f));
  CHECK(sk[0] == doctest::Approx(0.0f));
  CHECK(gc[7] == doctest::Approx(0.0f));
  CHECK(std::isnan(sk[7]));  // AATT has no G/C
  const auto n = enc("GNNN");
  std::vector<float> g2(4), k2(4);
  gc_per_position(n.data(), 4, 4, g2.data(), k2.data());
  CHECK(g2[0] == doctest::Approx(100.0f));  // ambiguity excluded from denominator
  const auto allN = enc("NNNN");
  gc_per_position(allN.data(), 4, 4, g2.data(), k2.data());
  CHECK(std::isnan(g2[0]));
}

TEST_CASE("thermo: analytic SantaLucia values (1 M Na+)") {
  ThermoParams p;
  p.na_mM = 1000.0;
  const auto cg = enc("CGCGCG");  // self-complementary
  const ThermoResult r = thermo_window(cg.data(), cg.size(), 0, 6, p);
  CHECK(r.self_complementary);
  CHECK(r.dh_kcal == doctest::Approx(-51.2).epsilon(1e-9));
  CHECK(r.ds_cal == doctest::Approx(-137.4).epsilon(1e-9));
  CHECK(r.dg_kcal == doctest::Approx(-8.5854).epsilon(1e-4));
  CHECK(std::fabs(r.tm_c - 32.33) < 0.05);

  const auto a6 = enc("AAAAAA");
  const ThermoResult q = thermo_window(a6.data(), 6, 0, 6, p);
  CHECK_FALSE(q.self_complementary);
  CHECK(q.dh_kcal == doctest::Approx(-34.9).epsilon(1e-9));
  CHECK(q.ds_cal == doctest::Approx(-102.8).epsilon(1e-9));
  CHECK(q.dg_kcal == doctest::Approx(-3.0166).epsilon(1e-3));
}

TEST_CASE("thermo: salt correction and ambiguity") {
  const auto a6 = enc("AAAAAA");
  ThermoParams p1, p2;
  p1.na_mM = 1000.0;
  p2.na_mM = 50.0;
  const double d = thermo_window(a6.data(), 6, 0, 6, p2).ds_cal - thermo_window(a6.data(), 6, 0, 6, p1).ds_cal;
  CHECK(d == doctest::Approx(0.368 * 5 * std::log(0.05)).epsilon(1e-9));
  const auto n = enc("AANAAA");
  CHECK(std::isnan(thermo_window(n.data(), 6, 0, 6, p2).tm_c));
  CHECK_THROWS_AS(thermo_window(a6.data(), 6, 4, 4, p2), std::out_of_range);
  ThermoParams bad;
  bad.na_mM = 0.0;
  CHECK_THROWS_AS(thermo_window(a6.data(), 6, 0, 6, bad), std::invalid_argument);
}

TEST_CASE("thermo: per-position (prefix sums + rolling hash) equals direct evaluation") {
  for (std::size_t window : {2u, 5u, 20u, 21u, 32u, 40u}) {
    const auto seq = random_seq(300, 7 + static_cast<unsigned>(window), 0.01);
    ThermoParams p;
    std::vector<float> tm(seq.size()), dg(seq.size());
    thermo_per_position(seq.data(), seq.size(), window, p, tm.data(), dg.data());
    const WindowPlan wp = plan_windows(seq.size(), window);
    for (std::size_t i = 0; i < seq.size(); ++i) {
      const ThermoResult r = thermo_window(seq.data(), seq.size(), wp.start_for(i), wp.w, p);
      CHECK(same_float(tm[i], static_cast<float>(r.tm_c)));
      CHECK(same_float(dg[i], static_cast<float>(r.dg_kcal)));
    }
  }
}

TEST_CASE("thermo: palindromic windows are detected by the rolling hash") {
  const auto seq = enc("ACGTACGTACGTACGTACGT");  // length 20, ACGT repeat; ACGT is its own revcomp
  ThermoParams p;
  std::vector<float> tm(20), dg(20);
  thermo_per_position(seq.data(), 20, 4, p, tm.data(), dg.data());
  const ThermoResult r = thermo_window(seq.data(), 20, 8, 4, p);  // "ACGT"
  CHECK(r.self_complementary);
  CHECK(same_float(tm[10], static_cast<float>(r.tm_c)));
}

TEST_CASE("kmer: incremental sweep equals brute force (with ambiguity, partial last window)") {
  const auto seq = random_seq(1000, 99, 0.01);
  for (unsigned k : {1u, 3u, 4u}) {
    const std::size_t window = 64, stride = 16;
    const std::size_t n_win = kmer_n_windows(seq.size(), window, stride);
    const std::size_t ncell = std::size_t{1} << (2 * k);
    std::vector<std::uint32_t> got(n_win * ncell, 7);  // poison
    kmer_matrix(seq.data(), seq.size(), k, window, stride, got.data());
    for (std::size_t i = 0; i < n_win; ++i) {
      const std::size_t s = i * stride, e = std::min(seq.size(), s + window);
      std::vector<std::uint32_t> want(ncell, 0);
      for (std::size_t j = s; j + k <= e; ++j) {
        std::uint32_t h = 0;
        bool ok = true;
        for (unsigned t = 0; t < k; ++t) {
          if (seq[j + t] > 3) { ok = false; break; }
          h = (h << 2) | seq[j + t];
        }
        if (ok) ++want[h];
      }
      for (std::size_t c = 0; c < ncell; ++c) REQUIRE(got[i * ncell + c] == want[c]);
    }
  }
}

TEST_CASE("kmer: window counts, k=8 shape and argument validation") {
  CHECK(kmer_n_windows(0, 10, 5) == 0);
  CHECK(kmer_n_windows(10, 10, 5) == 1);
  CHECK(kmer_n_windows(11, 10, 5) == 2);
  CHECK(kmer_n_windows(100, 10, 5) == 19);
  std::vector<std::uint32_t> out(4);
  const auto s = random_seq(50, 1);
  CHECK_THROWS_AS(kmer_matrix(s.data(), 50, 0, 10, 5, out.data()), std::invalid_argument);
  CHECK_THROWS_AS(kmer_matrix(s.data(), 50, 9, 20, 5, out.data()), std::invalid_argument);
  CHECK_THROWS_AS(kmer_matrix(s.data(), 50, 4, 3, 1, out.data()), std::invalid_argument);
  CHECK_THROWS_AS(kmer_matrix(s.data(), 50, 4, 10, 11, out.data()), std::invalid_argument);
}

TEST_CASE("cgr: corners, midpoint rule, ambiguity does not advance state") {
  const auto s = enc("AGNC");
  std::vector<float> x(4), y(4);
  cgr_points(s.data(), 4, x.data(), y.data());
  CHECK(x[0] == doctest::Approx(0.25f));
  CHECK(y[0] == doctest::Approx(0.25f));
  CHECK(x[1] == doctest::Approx(0.625f));  // G corner (1,1)
  CHECK(y[1] == doctest::Approx(0.625f));
  CHECK(std::isnan(x[2]));
  CHECK(x[3] == doctest::Approx(0.3125f));  // C corner (0,1) from (0.625,0.625)
  CHECK(y[3] == doctest::Approx(0.8125f));
}

TEST_CASE("zdna: CG repeat saturates, poly-A is zero, ambiguity is NaN") {
  const auto cg = enc("CGCGCGCGCGCG");
  std::vector<float> z(12);
  zdna_per_position(cg.data(), 12, 12, z.data());
  CHECK(z[5] == doctest::Approx(1.0f));
  const auto a = enc("AAAAAAAAAAAA");
  zdna_per_position(a.data(), 12, 12, z.data());
  CHECK(z[5] == doctest::Approx(0.0f));
  const auto n = enc("CGCGCNCGCGCG");
  zdna_per_position(n.data(), 12, 12, z.data());
  CHECK(std::isnan(z[5]));
  const auto ca = enc("CACACACACACA");  // (CA)n: mean 0.6 -> (0.6-0.3125)/0.6875
  zdna_per_position(ca.data(), 12, 12, z.data());
  CHECK(z[5] == doctest::Approx(0.41818f).epsilon(1e-3));
}
```
Result on the reference machine: **11 test cases, 23,110 assertions, 0 failures**, built with `-Wall -Wextra -Wpedantic` and `-fsanitize=address,undefined` (and again through CMake/Ninja/ctest with `HS_SANITIZE=ON`).

---

## 7. PYTHON BRIDGE — `backend/src/helixsight/core_bridge/native.py`

```python
"""The ONLY module allowed to import helixsight_core (doc 00 section 5.1).

Owns: ABI check, buffer allocation, argument marshalling, executor dispatch and the explicit
degraded mode. Degraded mode (wheel missing): encode() and gc_per_position() fall back to NumPy;
thermo / Z-propensity / CGR / k-mer raise CoreUnavailableError, which ScanSession maps to a
non-fatal WS `error CORE_UNAVAILABLE` and streams those channels as NaN ("no data" in the UI)."""
from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from typing import Optional

import numpy as np

try:
    import helixsight_core as _core
except ImportError:  # pragma: no cover - exercised only in degraded mode
    _core = None

EXPECTED_ABI = 1
CORE_AVAILABLE: bool = _core is not None
CORE_VERSION: str = _core.__version__ if _core is not None else "unavailable"
if _core is not None and _core.abi_version != EXPECTED_ABI:
    raise RuntimeError(f"helixsight_core ABI {_core.abi_version} != expected {EXPECTED_ABI}; rebuild with `uv sync --reinstall-package helixsight-core`")

# Channel registry v1 (doc 01 section 7.3) - rows of the planar tensor.
CH_GC, CH_SKEW, CH_TM, CH_DG, CH_Z, CH_CGR_X, CH_CGR_Y = 0, 1, 2, 3, 4, 5, 6
N_CHANNELS = 13  # 0-6 native, 7 attention, 8-11 classifiers, 12 anomaly

_executor = ThreadPoolExecutor(max_workers=int(os.environ.get("HS_CORE_EXECUTOR_THREADS", "2")),
                               thread_name_prefix="hs-core")


class CoreUnavailableError(RuntimeError):
    code = "CORE_UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class CoreParams:
    """Everything here is part of params_hash (doc 03 section 12)."""
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
    """float32 [13, L], C-contiguous, NaN-filled. Each row is a contiguous 1-D buffer that C++ writes in place."""
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
    n = len(codes)  # NumPy fallback, same window rule as window.hpp
    w = min(window, n)
    pre = lambda m: np.concatenate(([0], np.cumsum(m, dtype=np.int64)))  # noqa: E731
    pg, pc, pu = pre(codes == 2), pre(codes == 1), pre(codes < 4)
    s = np.clip(np.arange(n) - w // 2, 0, n - w)
    g, c, u = pg[s + w] - pg[s], pc[s + w] - pc[s], pu[s + w] - pu[s]
    with np.errstate(divide="ignore", invalid="ignore"):
        out_gc[:] = np.where(u > 0, 100.0 * (g + c) / u, np.nan)
        out_skew[:] = np.where((g + c) > 0, (g - c) / (g + c), np.nan)


def local_thermo(codes: np.ndarray, pos: int, p: CoreParams = CoreParams()) -> Optional[tuple[float, float]]:
    """(tm_c, dg_kcal) of the window centered on pos, or None if it contains an ambiguity code (mutation scoring)."""
    _need_core()
    tm, dg, _, _, _ = _core.thermo_at(codes, pos, p.thermo_window, p.na_mM, p.strand_nM, p.temp_c)
    return None if (tm != tm or dg != dg) else (tm, dg)


def compute_core_channels(codes: np.ndarray, planes: np.ndarray, p: CoreParams = CoreParams()) -> np.ndarray:
    """Fill rows 0-6 of `planes` in place; returns the k-mer count matrix [n_windows, 4**k] (for anomaly.py)."""
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
    """Runs the five native kernels concurrently (the GIL is released inside C++) so the event loop stays free."""
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
```
`planes[CH_GC]` is a C-contiguous 1-D view of one row, so pybind11 receives it without a copy and C++ writes straight into the tensor that `framing.pack_chunk` later slices (`planes[:, s:e]` → `.tobytes(order="C")` gives channel-major frames, doc 01 §7.3). `core_bridge/buffers.py` from doc 00's tree is therefore just `alloc_planes` (kept in this file).

### 7.1 Bridge tests — `backend/tests/test_core_bridge.py`
```python
import asyncio

import numpy as np
import pytest

from helixsight.core_bridge import native as nb

pytestmark = pytest.mark.skipif(not nb.CORE_AVAILABLE, reason="helixsight_core not built")


def test_encode_and_invalid_offset():
    assert nb.encode("ACGTN").tolist() == [0, 1, 2, 3, 4]
    with pytest.raises(ValueError, match="offset 2"):
        nb.encode("ACZT")


def test_all_channels_and_nan_masking():
    codes = nb.encode("ACGT" * 2500 + "N" * 5 + "CGCGCGCGCGCG" * 10)
    planes = nb.alloc_planes(len(codes))
    counts = asyncio.run(nb.compute_core_channels_async(codes, planes))
    assert counts.shape == (37, 256)
    assert np.isfinite(planes[nb.CH_GC]).all() and np.isfinite(planes[nb.CH_CGR_X]).sum() == len(codes) - 5
    assert np.isnan(planes[7:]).all()                      # ML channels are filled elsewhere
    assert nb.local_thermo(codes, 10002) is None           # window over the N-run
    assert nb.local_thermo(codes, len(codes) - 20) is not None


def test_numpy_fallback_matches_native_gc(monkeypatch):
    codes = nb.encode("ACGTNNGGCC" * 300)
    g1, k1, g2, k2 = (np.empty(len(codes), np.float32) for _ in range(4))
    nb.gc_per_position(codes, 100, g1, k1)
    monkeypatch.setattr(nb, "_core", None)
    nb.gc_per_position(codes, 100, g2, k2)
    assert np.allclose(g1, g2, equal_nan=True) and np.allclose(k1, k2, equal_nan=True)


def test_boundary_errors():
    codes = nb.encode("ACGT" * 10)
    ro = np.empty(40, np.float32)
    ro.flags.writeable = False
    with pytest.raises(ValueError):
        nb._core.cgr_points(codes, ro, np.empty(40, np.float32))
    with pytest.raises(TypeError):
        nb._core.cgr_points(codes, np.empty(40, np.float64), np.empty(40, np.float32))
    with pytest.raises(ValueError):
        nb._core.kmer_matrix(codes, 4, 20, 25, np.empty((1, 256), np.uint32))   # stride > window
```
(The first three flows and the error cases were executed in script form against the built module with the outputs noted in §2.2; this pytest file is the same logic reorganised.)

---

## 8. DUCKDB SCHEMA — `backend/src/helixsight/db/migrations/001_init.sql` (complete)

```sql
-- HelixSight AI - DuckDB schema v1 (doc 04 section 8).
-- Design rules:
--  * NO FOREIGN KEY constraints: DuckDB executes UPDATEs on indexed columns as delete+insert and
--    FK checks interact badly with that; referential integrity is enforced in db/repo.py and
--    audited by verify_integrity().
--  * Never UPDATE an indexed column (scan_id, sha256, (source, accession_key), analysis_id).
--  * All timestamps are UTC (connection runs SET TimeZone='UTC'; Python passes naive UTC values).
--  * One writer: every write goes through DuckStore.write_tx (single-thread executor).

CREATE TABLE IF NOT EXISTS schema_meta (
  key   VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS rev_seq START 1;

-- Content-addressed sequences: identity = sha256("hs1:" + canonical residues).
CREATE TABLE IF NOT EXISTS sequences (
  sha256          VARCHAR PRIMARY KEY CHECK (length(sha256) = 64),
  residues        VARCHAR NOT NULL,
  molecule        VARCHAR NOT NULL CHECK (molecule IN ('DNA', 'RNA')),
  length          UINTEGER NOT NULL CHECK (length > 0),
  gc_pct          FLOAT NOT NULL DEFAULT 0,            -- (G+C)/(A+C+G+T)*100, 0 if no unambiguous base
  a_count         UINTEGER NOT NULL DEFAULT 0,
  c_count         UINTEGER NOT NULL DEFAULT 0,
  g_count         UINTEGER NOT NULL DEFAULT 0,
  t_count         UINTEGER NOT NULL DEFAULT 0,
  ambiguous_count UINTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL
);

-- Provenance: one row per acquisition (NCBI fetch, PDB fetch, paste, file).
CREATE TABLE IF NOT EXISTS source_records (
  record_id    VARCHAR PRIMARY KEY,                    -- UUIDv7
  sha256       VARCHAR NOT NULL,                       -- -> sequences.sha256 (logical)
  source       VARCHAR NOT NULL CHECK (source IN ('NCBI', 'PDB', 'PASTE', 'FILE')),
  accession    VARCHAR,                                -- NM_004006.3 | 1BNA
  entity_id    INTEGER,                                -- PDB polymer entity
  display_name VARCHAR NOT NULL,
  description  VARCHAR,
  organism     VARCHAR,
  meta_json    JSON,                                   -- subset of esummary / RCSB metadata
  fetched_at   TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_records_sha ON source_records (sha256);

-- Network-avoidance cache: accession key -> sequence.
CREATE TABLE IF NOT EXISTS accession_index (
  source         VARCHAR NOT NULL CHECK (source IN ('NCBI', 'PDB')),
  accession_key  VARCHAR NOT NULL,                     -- 'NM_004006' | 'NC_045512.2' | '1BNA:1'
  sha256         VARCHAR NOT NULL,
  resolved_acc   VARCHAR,                              -- versioned accession returned by NCBI
  fetched_at     TIMESTAMP NOT NULL,
  ttl_expires_at TIMESTAMP,                            -- NULL = immutable (versioned accession)
  PRIMARY KEY (source, accession_key)
);

-- Analysis cache: immutable metadata row; the tensor lives in analysis_chunks.
-- A row exists only after ALL chunks were written in the same transaction (no partial state).
CREATE TABLE IF NOT EXISTS analysis_cache (
  analysis_id     VARCHAR PRIMARY KEY,                 -- UUIDv7
  sha256          VARCHAR NOT NULL,
  model_version   VARCHAR NOT NULL,
  core_version    VARCHAR NOT NULL,
  params_hash     VARCHAR NOT NULL,
  params_json     JSON NOT NULL,
  length          UINTEGER NOT NULL,
  channel_ids     VARCHAR NOT NULL,                    -- JSON array text, e.g. [0,1,...,12]
  n_channels      USMALLINT NOT NULL,
  chunk_positions UINTEGER NOT NULL,                   -- positions per stored chunk (default 65536)
  n_chunks        UINTEGER NOT NULL,
  codec           VARCHAR NOT NULL CHECK (codec IN ('raw', 'zstd')),
  anomaly_count   INTEGER NOT NULL DEFAULT 0,
  summary_json    JSON,                                -- anomaly regions, per-class peaks
  overview_bins   UINTEGER NOT NULL DEFAULT 0,
  overview        BLOB,                                -- planar float32 [n_channels x overview_bins]
  created_at      TIMESTAMP NOT NULL,
  UNIQUE (sha256, model_version, core_version, params_hash)
);

CREATE TABLE IF NOT EXISTS analysis_chunks (
  analysis_id VARCHAR NOT NULL,                        -- -> analysis_cache.analysis_id (logical)
  chunk_idx   UINTEGER NOT NULL,
  start_pos   UINTEGER NOT NULL,
  count       UINTEGER NOT NULL,
  payload     BLOB NOT NULL,                           -- planar float32 [n_channels x count], LE, codec applied
  PRIMARY KEY (analysis_id, chunk_idx)
);

-- History: one row per user-visible run; this is what the sidebar lists and what syncs to IndexedDB.
CREATE TABLE IF NOT EXISTS analysis_history (
  scan_id          VARCHAR PRIMARY KEY,                -- UUIDv7
  sha256           VARCHAR NOT NULL,
  record_id        VARCHAR,
  analysis_id      VARCHAR,                            -- NULL until a cached analysis exists
  source           VARCHAR NOT NULL CHECK (source IN ('NCBI', 'PDB', 'PASTE', 'FILE')),
  display_name     VARCHAR NOT NULL,
  accession        VARCHAR,
  length           UINTEGER NOT NULL,
  gc_pct           FLOAT NOT NULL,
  anomaly_count    INTEGER NOT NULL DEFAULT 0,
  last_scanned_pos UINTEGER NOT NULL DEFAULT 0,
  mutation_count   INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL,
  updated_at       TIMESTAMP NOT NULL,
  deleted          BOOLEAN NOT NULL DEFAULT FALSE,     -- tombstone for delta sync
  rev              BIGINT NOT NULL DEFAULT nextval('rev_seq')
  -- rev is deliberately NOT indexed: sync does `WHERE rev > ?` over a small table, and an index
  -- would turn every rev bump into a delete+insert.
);
CREATE INDEX IF NOT EXISTS idx_history_sha ON analysis_history (sha256);
CREATE INDEX IF NOT EXISTS idx_history_created ON analysis_history (created_at);

CREATE TABLE IF NOT EXISTS mutations (
  mutation_id      VARCHAR PRIMARY KEY,                -- UUIDv7
  scan_id          VARCHAR NOT NULL,
  sha256           VARCHAR NOT NULL,                   -- parent sequence
  position         UINTEGER NOT NULL,                  -- 0-based
  ref_base         VARCHAR NOT NULL CHECK (ref_base IN ('A', 'C', 'G', 'T', 'N')),
  alt_base         VARCHAR NOT NULL CHECK (alt_base IN ('A', 'C', 'G', 'T')),
  delta_tm_c       FLOAT,
  delta_dg_kcal    FLOAT,
  delta_p_promoter FLOAT,
  delta_p_cpg      FLOAT,
  delta_p_splice   FLOAT,
  pathogenicity    FLOAT CHECK (pathogenicity IS NULL OR (pathogenicity >= 0 AND pathogenicity <= 1)),
  created_at       TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mutations_scan ON mutations (scan_id);

-- Watched-folder bookkeeping (prevents re-ingest loops and half-written files).
CREATE TABLE IF NOT EXISTS watch_files (
  path        VARCHAR PRIMARY KEY,
  size_bytes  UBIGINT NOT NULL,
  mtime_ns    UBIGINT NOT NULL,
  status      VARCHAR NOT NULL CHECK (status IN ('ingested', 'failed')),
  error       VARCHAR,
  ingested_at TIMESTAMP NOT NULL
);

-- API shape of HistoryRecord (doc 01 section 10) incl. fields that live in other tables.
CREATE OR REPLACE VIEW v_history_record AS
SELECT h.scan_id, h.sha256, h.source, h.display_name, h.accession, r.organism, s.molecule,
       h.length, h.gc_pct, h.anomaly_count, h.last_scanned_pos, h.mutation_count,
       h.created_at, h.updated_at, h.rev, h.deleted
FROM analysis_history h
JOIN sequences s ON s.sha256 = h.sha256
LEFT JOIN source_records r ON r.record_id = h.record_id;

INSERT OR IGNORE INTO schema_meta VALUES ('contract_version', '1');
```

### 8.1 Table-by-table contract

| Table | Written by | Read by | Notes |
|---|---|---|---|
| `sequences` | `ingest_one` (insert-if-absent) | `ScanSession` (residues), `/api/sequences/{sha}` | Content-addressed; dedups NCBI + paste + file of the same letters. `residues` is canonical IUPAC; the `uint8` codes are derived by `native.encode`. |
| `source_records` | `ingest_one` (always) | `v_history_record` (organism), provenance UI | One row per acquisition; `meta_json` keeps the NCBI `esummary` / RCSB subset. |
| `accession_index` | `ingest_one` upsert (`ON CONFLICT (source, accession_key) DO UPDATE`) | `lookup_accession` (network avoidance) | Versioned NCBI accessions and PDB keys are immutable (`ttl_expires_at NULL`); unversioned NCBI accessions get a 30-day TTL (doc 01 §3.1). Expired rows count as misses so the caller revalidates with `esummary`. |
| `analysis_cache` | `put_analysis` (insert only) | `find_analysis`, `get_analysis_meta`, streamer | Unique on `(sha256, model_version, core_version, params_hash)`; never updated. `prune_stale_analyses` deletes rows whose versions are not current. |
| `analysis_chunks` | `put_analysis` | `get_chunk` | PK `(analysis_id, chunk_idx)`; planar `[n_channels × count]` little-endian float32, optional zstd. WS frames (256 positions) are sliced from a decoded chunk. |
| `analysis_history` | `ingest_one` (insert), `put_analysis`/`checkpoint`/`delete_history`/mutation ops (updates of non-indexed columns only) | `history_page`, `history_sync` | Every mutation of a row sets `rev = nextval('rev_seq')`; `deleted` is a tombstone so deletions replicate to IndexedDB. |
| `mutations` | `add_mutation` | `list_mutations`, MutationPanel | Parent `sha256` + position/alt (no derived sequences). Add/delete bumps the history row's `rev` and `mutation_count` so other clients refetch. |
| `watch_files` | watcher | watcher | `(path, size, mtime_ns)` identifies a file version; a changed `mtime_ns` re-ingests. |
| `schema_meta` | migration runner | startup | `schema_version` is the highest applied migration. |

### 8.2 Query catalog (exact SQL used by the API layer)

```sql
-- /api/history/sync?since_rev=N
SELECT * FROM v_history_record WHERE rev > ? AND NOT deleted ORDER BY rev;
SELECT scan_id FROM analysis_history WHERE rev > ? AND deleted;
SELECT coalesce(max(rev), 0) FROM analysis_history;

-- /api/history?limit&before_rev&source&q   (newest first)
SELECT * FROM v_history_record WHERE NOT deleted [AND rev < ?] [AND source = ?]
       [AND (display_name ILIKE ? OR accession ILIKE ?)] ORDER BY rev DESC LIMIT ?;

-- ingestion fast path (NCBI/PDB)
SELECT * FROM accession_index WHERE source = ? AND accession_key = ?
       AND (ttl_expires_at IS NULL OR ttl_expires_at > ?);

-- analysis cache hit test (IngestItem.has_analysis_cache, start_scan)
SELECT analysis_id, anomaly_count FROM analysis_cache
 WHERE sha256 = ? AND model_version = ? AND core_version = ? AND params_hash = ?;

-- streaming a cached analysis, one stored chunk at a time
SELECT start_pos, count, payload FROM analysis_chunks WHERE analysis_id = ? AND chunk_idx = ?;
```

---

## 9. DUCKDB ACCESS LAYER (COMPLETE)

### 9.1 `helixsight/ids.py`
```python
"""Time-sortable UUIDv7 (RFC 9562 layout); Python 3.11/3.12 have no uuid.uuid7."""
from __future__ import annotations

import os
import time
import uuid


def uuid7() -> str:
    ts_ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")  # 80 random bits
    value = (
        ((ts_ms & ((1 << 48) - 1)) << 80)  # 48-bit unix ms timestamp
        | (0x7 << 76)  # version 7
        | (((rand >> 68) & 0xFFF) << 64)  # rand_a (12 bits)
        | (0b10 << 62)  # RFC variant
        | (rand & ((1 << 62) - 1))  # rand_b (62 bits)
    )
    return str(uuid.UUID(int=value))
```

### 9.2 `helixsight/db/duckdb_store.py`
```python
"""DuckDB access layer: ONE connection, ONE serialized writer, many short-lived read cursors."""
from __future__ import annotations

import asyncio
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, TypeVar

import duckdb

T = TypeVar("T")
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


class DuckStore:
    def __init__(self, path: str = "data/helixsight.duckdb", memory_limit: str = "1GB",
                 threads: int = 4, read_workers: int = 4) -> None:
        self._path, self._memory_limit, self._threads = path, memory_limit, threads
        self._writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="duck-writer")
        self._readers = ThreadPoolExecutor(max_workers=read_workers, thread_name_prefix="duck-read")
        self._con: duckdb.DuckDBPyConnection | None = None
        self._wcur: duckdb.DuckDBPyConnection | None = None

    # ---- lifecycle -------------------------------------------------------------------------
    def open(self) -> None:
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._con = duckdb.connect(self._path)
        self._con.execute("SET TimeZone = 'UTC'")
        self._con.execute(f"SET memory_limit = '{self._memory_limit}'")
        self._con.execute(f"SET threads = {int(self._threads)}")
        self._migrate(self._con)
        self._wcur = self._con.cursor()  # used ONLY from the writer thread

    def close(self) -> None:
        self._writer.shutdown(wait=True)
        self._readers.shutdown(wait=True)
        if self._con is not None:
            self._con.close()
            self._con = None

    @staticmethod
    def _migrate(con: duckdb.DuckDBPyConnection) -> None:
        con.execute("CREATE TABLE IF NOT EXISTS schema_meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)")
        row = con.execute("SELECT value FROM schema_meta WHERE key = 'schema_version'").fetchone()
        current = int(row[0]) if row else 0
        files = sorted(p for p in MIGRATIONS_DIR.glob("*.sql") if re.match(r"^\d{3}_", p.name))
        for f in files:
            version = int(f.name[:3])
            if version <= current:
                continue
            con.execute("BEGIN TRANSACTION")
            try:
                con.execute(f.read_text(encoding="utf-8"))
                con.execute("INSERT OR REPLACE INTO schema_meta VALUES ('schema_version', ?)", [str(version)])
                con.execute("COMMIT")
            except BaseException:
                con.execute("ROLLBACK")
                raise
            current = version

    # ---- sync primitives (run inside executors) --------------------------------------------
    def _run_read(self, fn: Callable[[duckdb.DuckDBPyConnection], T]) -> T:
        cur = self._con.cursor()  # type: ignore[union-attr]
        try:
            return fn(cur)
        finally:
            cur.close()

    def _run_tx(self, fn: Callable[[duckdb.DuckDBPyConnection], T]) -> T:
        cur = self._wcur
        assert cur is not None
        cur.execute("BEGIN TRANSACTION")
        try:
            out = fn(cur)
            cur.execute("COMMIT")
            return out
        except BaseException:
            cur.execute("ROLLBACK")
            raise

    # ---- async API used by FastAPI routes / ScanSession -------------------------------------
    async def read(self, fn: Callable[[duckdb.DuckDBPyConnection], T]) -> T:
        return await asyncio.get_running_loop().run_in_executor(self._readers, self._run_read, fn)

    async def write_tx(self, fn: Callable[[duckdb.DuckDBPyConnection], T]) -> T:
        return await asyncio.get_running_loop().run_in_executor(self._writer, self._run_tx, fn)
```
**Concurrency model:** one DuckDB instance per process; all writes are serialized on a single-thread executor (so check-then-insert patterns such as `put_analysis` are race-free) and every write is one transaction; reads use `con.cursor()` objects on a 4-thread pool, each used by exactly one thread. File watchers and other threads never touch DuckDB — they enqueue work for the event loop (doc 01 §3.5). No other process may open the `.duckdb` file while the server runs.

### 9.3 `helixsight/db/repo.py`
```python
"""Repository functions. Every function takes a DuckDB cursor and runs inside the caller's
transaction (DuckStore.write_tx) or read cursor (DuckStore.read). Referential integrity that the
schema deliberately does not enforce (no FKs) is maintained here and audited by verify_integrity()."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import duckdb
import numpy as np

from ..ids import uuid7

try:  # optional codec (BSD); HS_CACHE_CODEC=zstd
    import zstandard as _zstd
except ImportError:  # pragma: no cover
    _zstd = None

Cur = duckdb.DuckDBPyConnection
CHUNK_POSITIONS = 65_536


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC for TIMESTAMP columns


@dataclass(frozen=True, slots=True)
class CanonicalRecord:  # produced by ingestion/sanitizer.py (doc 01 section 3.0)
    sha256: str
    residues: str
    molecule: str  # 'DNA' | 'RNA'
    length: int
    gc_pct: float
    a: int
    c: int
    g: int
    t: int
    ambiguous: int
    display_name: str
    description: Optional[str] = None


@dataclass(frozen=True, slots=True)
class SourceMeta:
    source: str  # 'NCBI' | 'PDB' | 'PASTE' | 'FILE'
    accession: Optional[str] = None
    entity_id: Optional[int] = None
    organism: Optional[str] = None
    meta_json: Optional[dict[str, Any]] = None
    accession_key: Optional[str] = None  # set for NCBI/PDB -> accession_index upsert
    resolved_acc: Optional[str] = None
    ttl_days: Optional[int] = None  # None = immutable


def _rows(cur: Cur) -> list[dict[str, Any]]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(cur: Cur) -> Optional[dict[str, Any]]:
    rows = _rows(cur)
    return rows[0] if rows else None


# ------------------------------------------------------------------ ingestion ------------------
def lookup_accession(cur: Cur, source: str, key: str, now: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    """Fresh accession_index hit or None (expired rows count as a miss -> caller revalidates)."""
    now = now or utcnow()
    return _one(cur.execute(
        "SELECT * FROM accession_index WHERE source = ? AND accession_key = ? "
        "AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)", [source, key, now]))


def find_analysis(cur: Cur, sha256: str, model_version: str, core_version: str, params_hash: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute(
        "SELECT analysis_id, anomaly_count FROM analysis_cache WHERE sha256 = ? AND model_version = ? "
        "AND core_version = ? AND params_hash = ?", [sha256, model_version, core_version, params_hash]))


def ingest_one(cur: Cur, rec: CanonicalRecord, meta: SourceMeta,
               analysis_key: Optional[tuple[str, str, str]] = None,
               now: Optional[datetime] = None) -> dict[str, Any]:
    """Store sequence (dedup by sha256) + provenance + accession index + a NEW history row.
    Returns {'sequence_existed': bool, 'has_analysis_cache': bool, 'record': <v_history_record row>}."""
    now = now or utcnow()
    existed = cur.execute("SELECT 1 FROM sequences WHERE sha256 = ?", [rec.sha256]).fetchone() is not None
    if not existed:
        cur.execute(
            "INSERT INTO sequences (sha256, residues, molecule, length, gc_pct, a_count, c_count, g_count, "
            "t_count, ambiguous_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [rec.sha256, rec.residues, rec.molecule, rec.length, rec.gc_pct, rec.a, rec.c, rec.g, rec.t,
             rec.ambiguous, now])
    record_id = uuid7()
    cur.execute(
        "INSERT INTO source_records (record_id, sha256, source, accession, entity_id, display_name, description, "
        "organism, meta_json, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [record_id, rec.sha256, meta.source, meta.accession, meta.entity_id, rec.display_name, rec.description,
         meta.organism, json.dumps(meta.meta_json) if meta.meta_json is not None else None, now])
    if meta.accession_key is not None:
        ttl = now + timedelta(days=meta.ttl_days) if meta.ttl_days else None
        cur.execute(
            "INSERT INTO accession_index (source, accession_key, sha256, resolved_acc, fetched_at, ttl_expires_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT (source, accession_key) DO UPDATE SET "
            "sha256 = excluded.sha256, resolved_acc = excluded.resolved_acc, "
            "fetched_at = excluded.fetched_at, ttl_expires_at = excluded.ttl_expires_at",
            [meta.source, meta.accession_key, rec.sha256, meta.resolved_acc, now, ttl])
    cached = find_analysis(cur, rec.sha256, *analysis_key) if analysis_key else None
    scan_id = uuid7()
    cur.execute(
        "INSERT INTO analysis_history (scan_id, sha256, record_id, analysis_id, source, display_name, accession, "
        "length, gc_pct, anomaly_count, last_scanned_pos, mutation_count, created_at, updated_at, deleted, rev) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,FALSE,nextval('rev_seq'))",
        [scan_id, rec.sha256, record_id, cached["analysis_id"] if cached else None, meta.source, rec.display_name,
         meta.accession or rec.display_name, rec.length, rec.gc_pct, cached["anomaly_count"] if cached else 0,
         now, now])
    row = _one(cur.execute("SELECT * FROM v_history_record WHERE scan_id = ?", [scan_id]))
    return {"sequence_existed": existed, "has_analysis_cache": cached is not None, "record": row}


# ------------------------------------------------------------------ history --------------------
def history_page(cur: Cur, limit: int = 50, before_rev: Optional[int] = None, source: Optional[str] = None,
                 q: Optional[str] = None) -> list[dict[str, Any]]:
    sql, args = "SELECT * FROM v_history_record WHERE NOT deleted", []
    if before_rev is not None:
        sql += " AND rev < ?"; args.append(before_rev)
    if source:
        sql += " AND source = ?"; args.append(source)
    if q:
        sql += " AND (display_name ILIKE ? OR accession ILIKE ?)"; args += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY rev DESC LIMIT ?"; args.append(limit)
    return _rows(cur.execute(sql, args))


def history_sync(cur: Cur, since_rev: int) -> dict[str, Any]:
    upserts = _rows(cur.execute("SELECT * FROM v_history_record WHERE rev > ? AND NOT deleted ORDER BY rev", [since_rev]))
    deleted = [r[0] for r in cur.execute("SELECT scan_id FROM analysis_history WHERE rev > ? AND deleted", [since_rev]).fetchall()]
    latest = cur.execute("SELECT coalesce(max(rev), 0) FROM analysis_history").fetchone()[0]
    return {"since_rev": since_rev, "latest_rev": int(latest), "upserts": upserts, "deleted": deleted}


def checkpoint(cur: Cur, scan_id: str, pos: int, now: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    cur.execute("UPDATE analysis_history SET last_scanned_pos = ?, updated_at = ?, rev = nextval('rev_seq') "
                "WHERE scan_id = ? AND NOT deleted", [pos, now or utcnow(), scan_id])
    return _one(cur.execute("SELECT * FROM v_history_record WHERE scan_id = ?", [scan_id]))


def delete_history(cur: Cur, scan_id: str, now: Optional[datetime] = None) -> None:
    cur.execute("UPDATE analysis_history SET deleted = TRUE, updated_at = ?, rev = nextval('rev_seq') WHERE scan_id = ?",
                [now or utcnow(), scan_id])
    cur.execute("DELETE FROM mutations WHERE scan_id = ?", [scan_id])


# ------------------------------------------------------------------ analysis cache --------------
def _encode(buf: bytes, codec: str) -> bytes:
    if codec == "raw":
        return buf
    if _zstd is None:
        raise RuntimeError("codec 'zstd' requested but the 'zstandard' package is not installed")
    return _zstd.ZstdCompressor(level=3).compress(buf)


def _decode(buf: bytes, codec: str) -> bytes:
    if codec == "raw":
        return buf
    if _zstd is None:
        raise RuntimeError("cache entry is zstd-compressed but 'zstandard' is not installed")
    return _zstd.ZstdDecompressor().decompress(buf)


def put_analysis(cur: Cur, *, sha256: str, model_version: str, core_version: str, params_hash: str,
                 params: dict[str, Any], planes: np.ndarray, channel_ids: list[int], anomaly_count: int,
                 summary: dict[str, Any], overview: Optional[np.ndarray] = None, codec: str = "raw",
                 chunk_positions: int = CHUNK_POSITIONS, now: Optional[datetime] = None) -> str:
    """planes: float32 C-contiguous [n_channels, L]. Idempotent per (sha256, versions, params_hash)."""
    now = now or utcnow()
    existing = find_analysis(cur, sha256, model_version, core_version, params_hash)
    if existing:  # single writer => check-then-insert is race-free
        return existing["analysis_id"]
    assert planes.dtype == np.float32 and planes.ndim == 2 and planes.shape[0] == len(channel_ids)
    n_ch, length = planes.shape
    n_chunks = (length + chunk_positions - 1) // chunk_positions
    analysis_id = uuid7()
    for ci in range(n_chunks):
        s, e = ci * chunk_positions, min(length, (ci + 1) * chunk_positions)
        payload = _encode(np.ascontiguousarray(planes[:, s:e]).astype("<f4", copy=False).tobytes(order="C"), codec)
        cur.execute("INSERT INTO analysis_chunks (analysis_id, chunk_idx, start_pos, count, payload) VALUES (?,?,?,?,?)",
                    [analysis_id, ci, s, e - s, payload])
    ov = overview.astype("<f4", copy=False).tobytes(order="C") if overview is not None else None
    cur.execute(
        "INSERT INTO analysis_cache (analysis_id, sha256, model_version, core_version, params_hash, params_json, "
        "length, channel_ids, n_channels, chunk_positions, n_chunks, codec, anomaly_count, summary_json, "
        "overview_bins, overview, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [analysis_id, sha256, model_version, core_version, params_hash, json.dumps(params, sort_keys=True),
         length, json.dumps(channel_ids), n_ch, chunk_positions, n_chunks, codec, anomaly_count,
         json.dumps(summary), overview.shape[1] if overview is not None else 0, ov, now])
    cur.execute("UPDATE analysis_history SET analysis_id = ?, anomaly_count = ?, updated_at = ?, rev = nextval('rev_seq') "
                "WHERE sha256 = ? AND NOT deleted", [analysis_id, anomaly_count, now, sha256])
    return analysis_id


def get_analysis_meta(cur: Cur, sha256: str, model_version: str, core_version: str, params_hash: str) -> Optional[dict[str, Any]]:
    return _one(cur.execute(
        "SELECT analysis_id, sha256, length, channel_ids, n_channels, chunk_positions, n_chunks, codec, "
        "anomaly_count, summary_json, overview_bins FROM analysis_cache WHERE sha256 = ? AND model_version = ? "
        "AND core_version = ? AND params_hash = ?", [sha256, model_version, core_version, params_hash]))


def get_chunk(cur: Cur, analysis_id: str, chunk_idx: int, n_channels: int, codec: str) -> Optional[tuple[int, np.ndarray]]:
    """Returns (start_pos, planes[n_channels, count]) as a zero-copy read-only float32 view."""
    row = cur.execute("SELECT start_pos, count, payload FROM analysis_chunks WHERE analysis_id = ? AND chunk_idx = ?",
                      [analysis_id, chunk_idx]).fetchone()
    if row is None:
        return None
    start, count, payload = row
    arr = np.frombuffer(_decode(bytes(payload), codec), dtype="<f4").reshape(n_channels, count)
    return int(start), arr


def get_overview(cur: Cur, analysis_id: str, n_channels: int) -> Optional[np.ndarray]:
    row = cur.execute("SELECT overview, overview_bins FROM analysis_cache WHERE analysis_id = ?", [analysis_id]).fetchone()
    if row is None or row[0] is None:
        return None
    return np.frombuffer(bytes(row[0]), dtype="<f4").reshape(n_channels, int(row[1]))


def prune_stale_analyses(cur: Cur, keep_model_version: str, keep_core_version: str) -> int:
    ids = [r[0] for r in cur.execute("SELECT analysis_id FROM analysis_cache WHERE model_version <> ? OR core_version <> ?",
                                     [keep_model_version, keep_core_version]).fetchall()]
    for aid in ids:
        cur.execute("DELETE FROM analysis_chunks WHERE analysis_id = ?", [aid])
        cur.execute("DELETE FROM analysis_cache WHERE analysis_id = ?", [aid])
        cur.execute("UPDATE analysis_history SET analysis_id = NULL WHERE analysis_id = ?", [aid])
    return len(ids)


# ------------------------------------------------------------------ mutations -------------------
def add_mutation(cur: Cur, *, scan_id: str, sha256: str, position: int, ref: str, alt: str,
                 deltas: dict[str, Optional[float]], now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or utcnow()
    mid = uuid7()
    cur.execute(
        "INSERT INTO mutations (mutation_id, scan_id, sha256, position, ref_base, alt_base, delta_tm_c, delta_dg_kcal, "
        "delta_p_promoter, delta_p_cpg, delta_p_splice, pathogenicity, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [mid, scan_id, sha256, position, ref, alt, deltas.get("delta_tm_c"), deltas.get("delta_dg_kcal"),
         deltas.get("delta_p_promoter"), deltas.get("delta_p_cpg"), deltas.get("delta_p_splice"),
         deltas.get("pathogenicity"), now])
    _bump_mutation_count(cur, scan_id, now)
    return _one(cur.execute("SELECT * FROM mutations WHERE mutation_id = ?", [mid]))  # type: ignore[return-value]


def delete_mutation(cur: Cur, mutation_id: str, now: Optional[datetime] = None) -> bool:
    row = cur.execute("SELECT scan_id FROM mutations WHERE mutation_id = ?", [mutation_id]).fetchone()
    if row is None:
        return False
    cur.execute("DELETE FROM mutations WHERE mutation_id = ?", [mutation_id])
    _bump_mutation_count(cur, row[0], now or utcnow())
    return True


def list_mutations(cur: Cur, scan_id: str) -> list[dict[str, Any]]:
    return _rows(cur.execute("SELECT * FROM mutations WHERE scan_id = ? ORDER BY created_at", [scan_id]))


def _bump_mutation_count(cur: Cur, scan_id: str, now: datetime) -> None:
    cur.execute("UPDATE analysis_history SET mutation_count = (SELECT count(*) FROM mutations WHERE scan_id = ?), "
                "updated_at = ?, rev = nextval('rev_seq') WHERE scan_id = ?", [scan_id, now, scan_id])


# ------------------------------------------------------------------ integrity -------------------
def verify_integrity(cur: Cur) -> dict[str, int]:
    """Counts of logical-FK violations (all must be 0). Run in tests, on startup (warn) and via /api/health?deep=1."""
    checks = {
        "history_without_sequence": "SELECT count(*) FROM analysis_history h ANTI JOIN sequences s ON s.sha256 = h.sha256",
        "source_records_without_sequence": "SELECT count(*) FROM source_records r ANTI JOIN sequences s ON s.sha256 = r.sha256",
        "accession_index_without_sequence": "SELECT count(*) FROM accession_index a ANTI JOIN sequences s ON s.sha256 = a.sha256",
        "mutations_without_history": "SELECT count(*) FROM mutations m ANTI JOIN analysis_history h ON h.scan_id = m.scan_id",
        "chunks_without_analysis": "SELECT count(*) FROM analysis_chunks c ANTI JOIN analysis_cache a ON a.analysis_id = c.analysis_id",
        "history_with_dangling_analysis": "SELECT count(*) FROM analysis_history h WHERE h.analysis_id IS NOT NULL AND NOT EXISTS "
                                          "(SELECT 1 FROM analysis_cache a WHERE a.analysis_id = h.analysis_id)",
        "analysis_missing_chunks": "SELECT count(*) FROM analysis_cache a WHERE a.n_chunks <> "
                                   "(SELECT count(*) FROM analysis_chunks c WHERE c.analysis_id = a.analysis_id)",
    }
    return {name: int(cur.execute(sql).fetchone()[0]) for name, sql in checks.items()}
```

**Pipeline wiring (who calls what):** `pipeline.ingest_records` canonicalizes each record, then for each runs `store.write_tx(lambda c: repo.ingest_one(c, rec, meta, analysis_key))` and maps the result to `IngestItem`: `cache_status = HIT_ACCESSION` if `lookup_accession` hit before any network call, else `HIT_SHA` if `sequence_existed`, else `MISS_STORED`; `has_analysis_cache` comes straight from the result. `ScanSession` calls `find_analysis` → on hit streams `get_chunk` slices; on miss runs the compute pipeline (doc 01 §4.1) and finishes with one `put_analysis` transaction. `routes_history` call `history_page`/`history_sync`/`checkpoint`/`delete_history`; mutation routes call `add_mutation`/`delete_mutation`/`list_mutations`.

### 9.4 Repository test — `backend/tests/test_duckdb_repo.py`
```python
import asyncio
import hashlib

import duckdb
import numpy as np
import pytest

from helixsight.db import repo
from helixsight.db.duckdb_store import DuckStore
from helixsight.db.repo import CanonicalRecord, SourceMeta


def canon(res: str, name: str) -> CanonicalRecord:
    return CanonicalRecord(hashlib.sha256(("hs1:" + res).encode()).hexdigest(), res, "DNA", len(res),
                           100.0 * (res.count("G") + res.count("C")) / len(res),
                           res.count("A"), res.count("C"), res.count("G"), res.count("T"), 0, name, "test")


async def scenario() -> None:
    st = DuckStore(":memory:")
    st.open()
    rec = canon("ACGT" * 5000, "seqA")
    key = ("model+1", "0.1.0", "pppppppp")
    meta = SourceMeta("NCBI", "NM_004006.3", organism="Homo sapiens", accession_key="NM_004006",
                      resolved_acc="NM_004006.3", ttl_days=30, meta_json={"slen": 20000})
    r1 = await st.write_tx(lambda c: repo.ingest_one(c, rec, meta, key))
    r2 = await st.write_tx(lambda c: repo.ingest_one(c, rec, SourceMeta("PASTE"), key))
    assert (r1["sequence_existed"], r2["sequence_existed"]) == (False, True)       # dedup by sha256
    assert r1["record"]["organism"] == "Homo sapiens"

    assert (await st.read(lambda c: repo.lookup_accession(c, "NCBI", "NM_004006")))["sha256"] == rec.sha256
    far = repo.utcnow().replace(year=2100)
    assert await st.read(lambda c: repo.lookup_accession(c, "NCBI", "NM_004006", far)) is None   # TTL expired -> miss

    sync0 = await st.read(lambda c: repo.history_sync(c, 0))
    assert len(sync0["upserts"]) == 2 and sync0["latest_rev"] == 2

    planes = np.random.default_rng(1).random((13, 150_000)).astype(np.float32)
    planes[3, 10] = np.nan
    ov = planes[:, :100].copy()
    for codec in ("raw", "zstd"):
        k = (f"model+{codec}", "0.1.0", "h")
        put = lambda c: repo.put_analysis(c, sha256=rec.sha256, model_version=k[0], core_version=k[1], params_hash=k[2],  # noqa: E731
                                          params={"w": 20}, planes=planes, channel_ids=list(range(13)),
                                          anomaly_count=3, summary={"regions": []}, overview=ov, codec=codec)
        aid = await st.write_tx(put)
        assert aid == await st.write_tx(put)                                         # idempotent
        meta_row = await st.read(lambda c: repo.get_analysis_meta(c, rec.sha256, *k))
        assert meta_row["n_chunks"] == 3
        chunks = [(await st.read(lambda c: repo.get_chunk(c, aid, i, 13, codec)))[1] for i in range(3)]
        assert np.array_equal(np.concatenate(chunks, axis=1), planes, equal_nan=True)
        assert np.array_equal(await st.read(lambda c: repo.get_overview(c, aid, 13)), ov, equal_nan=True)

    after = await st.read(lambda c: repo.history_sync(c, sync0["latest_rev"]))
    assert len(after["upserts"]) == 2 and after["upserts"][0]["anomaly_count"] == 3

    sid = r1["record"]["scan_id"]
    m = await st.write_tx(lambda c: repo.add_mutation(c, scan_id=sid, sha256=rec.sha256, position=5, ref="A",
                                                      alt="G", deltas={"delta_tm_c": -1.2, "pathogenicity": 0.4}))
    page = await st.read(lambda c: repo.history_page(c))
    assert sorted(x["mutation_count"] for x in page) == [0, 1]
    assert (await st.write_tx(lambda c: repo.checkpoint(c, sid, 1234)))["last_scanned_pos"] == 1234
    with pytest.raises(duckdb.ConstraintException):                                    # CHECK constraint
        await st.write_tx(lambda c: repo.add_mutation(c, scan_id=sid, sha256=rec.sha256, position=5, ref="A",
                                                      alt="G", deltas={"pathogenicity": 1.5}))
    assert len(await st.read(lambda c: repo.list_mutations(c, sid))) == 1             # failed tx rolled back
    assert await st.write_tx(lambda c: repo.delete_mutation(c, m["mutation_id"]))
    await st.write_tx(lambda c: repo.delete_history(c, sid))
    s2 = await st.read(lambda c: repo.history_sync(c, 0))
    assert len(s2["deleted"]) == 1 and len(s2["upserts"]) == 1
    assert all(v == 0 for v in (await st.read(repo.verify_integrity)).values())
    assert await st.write_tx(lambda c: repo.prune_stale_analyses(c, "model+raw", "0.1.0")) == 1
    assert all(v == 0 for v in (await st.read(repo.verify_integrity)).values())
    st.close()


def test_repository_end_to_end():
    asyncio.run(scenario())
```
(Executed in script form with identical assertions; observed: dedup, TTL expiry, raw and zstd round-trips with NaN preserved, rev bumps on every history change, CHECK rollback, tombstone sync, integrity all zero, stale-version pruning.)

---

## 10. INTERCONNECTION MATRIX

| Caller | Callee | Channel / payload | Purpose |
|---|---|---|---|
| `sanitizer.canonicalize` | `native.encode` | `str → uint8[L]` | codes for all native kernels |
| `ScanSession` | `native.alloc_planes` | `float32[13,L]` NaN-filled | the one tensor everything writes into |
| `ScanSession` | `native.compute_core_channels_async` | `codes`, `planes`, `CoreParams` | rows 0–6 + k-mer counts |
| `native.py` | `helixsight_core.*` | zero-copy `noconvert` arrays | GIL-free kernels |
| `ml/anomaly.py` | `kmer counts uint32[nWin,256]` | in-memory | `anomaly_scores`, channel 12 |
| `ml/pathogenicity.py` | `native.local_thermo` | `(codes, pos, CoreParams)` → `(tm, dg)|None` | mutation ΔTm/ΔΔG |
| `ScanSession` | `repo.find_analysis` / `get_chunk` | SQL on `analysis_*` | cache hit → stream chunks |
| `ScanSession` (miss) | `repo.put_analysis` (one tx) | planes → `analysis_chunks` | write-through after full compute |
| `pipeline.ingest_records` | `repo.lookup_accession` / `ingest_one` | SQL | network avoidance, dedup, history row |
| `routes_history` | `repo.history_sync` / `history_page` / `checkpoint` / `delete_history` | `v_history_record` | sidebar + IndexedDB reconcile |
| `routes_*` (mutations) | `repo.add_mutation` / `delete_mutation` / `list_mutations` | SQL | MutationPanel persistence |
| `DuckStore.write_tx` | single writer thread | transaction per call | serialized, atomic writes |
| startup | `repo.verify_integrity` | 7 audit queries | warn on logical-FK drift |

---

## 11. PHASE-TRACKER REFINEMENTS (apply to `00` §8)

```text
P1.1 [ ] encode_into + gc_per_position + window.hpp + tests       (code in §3.3–3.5, §6)
P1.2 [ ] kmer_matrix incremental sweep + brute-force test         (§3.6)
P1.3 [ ] cgr_points (planar)                                      (§3.7)
P1.4 [ ] thermo_window / thermo_per_position + analytic tests     (§3.9–3.10)
P1.5 [ ] zdna_per_position heuristic                              (§3.8)
P1.6 [ ] pybind11 module (noconvert, GIL release, ABI version)    (§4)
P1.7 [ ] scikit-build-core wheel via uv; clean-venv import check  (§5, doc 05 §6)
P1.8 [ ] bench: 1 Mbp total native < 100 ms recorded in MODEL/BENCH notes (§2.2 reference: ~65 ms)
P2.2 [ ] DuckStore + 001_init.sql + repo.py + test_duckdb_repo.py (§8–9)
P2.2b[ ] verify_integrity wired into startup + /api/health?deep=1
```