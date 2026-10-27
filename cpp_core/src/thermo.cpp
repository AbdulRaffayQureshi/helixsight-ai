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
  double dh;
  double ds;
};

constexpr std::array<NN, 16> make_nn() {
  std::array<NN, 16> t{};
  constexpr int A = 0, C = 1, G = 2, T = 3;
  auto set = [&t](int a, int b, NN v) { t[static_cast<std::size_t>(4 * a + b)] = v; };
  constexpr NN k_aa{-7.9, -22.2}, k_at{-7.2, -20.4}, k_ta{-7.2, -21.3}, k_ca{-8.5, -22.7},
      k_gt{-8.4, -22.4}, k_ct{-7.8, -21.0}, k_ga{-8.2, -22.2}, k_cg{-10.6, -27.2},
      k_gc{-9.8, -24.4}, k_gg{-8.0, -19.9};
  set(A, A, k_aa); set(T, T, k_aa);
  set(A, T, k_at);
  set(T, A, k_ta);
  set(C, A, k_ca); set(T, G, k_ca);
  set(G, T, k_gt); set(A, C, k_gt);
  set(C, T, k_ct); set(A, G, k_ct);
  set(G, A, k_ga); set(T, C, k_ga);
  set(C, G, k_cg);
  set(G, C, k_gc);
  set(G, G, k_gg); set(C, C, k_gg);
  return t;
}
constexpr auto kNN = make_nn();

constexpr double kInitGC_dH = 0.1, kInitGC_dS = -2.8;
constexpr double kInitAT_dH = 2.3, kInitAT_dS = 4.1;
constexpr double kSymmetry_dS = -1.4;
constexpr double kR = 1.987;

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
  if (w % 2 != 0) return false;
  for (std::size_t i = 0; i < w / 2; ++i) {
    const std::uint8_t a = p[i], b = p[w - 1 - i];
    if (a > 3 || b > 3 || a + b != 3) return false;
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
  if (w < 2) {
    std::fill(out_tm, out_tm + L, kNaNf);
    std::fill(out_dg, out_dg + L, kNaNf);
    return;
  }

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
  std::uint64_t F = 0, R = 0;

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
    const std::size_t s = e + 1 - w;
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
