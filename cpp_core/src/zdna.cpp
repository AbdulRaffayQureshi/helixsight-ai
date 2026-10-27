#include "helixsight/zdna.hpp"
#include <algorithm>
#include <array>
#include <vector>
#include "helixsight/types.hpp"
#include "helixsight/window.hpp"

namespace hs {
namespace {
constexpr double kRandomBaseline = 0.3125;

constexpr std::array<double, 16> make_steps() {
  std::array<double, 16> t{};
  constexpr int A = 0, C = 1, G = 2, T = 3;
  auto set = [&t](int a, int b, double v) { t[static_cast<std::size_t>(4 * a + b)] = v; };
  set(C, G, 1.0); set(G, C, 1.0);
  set(C, A, 0.6); set(T, G, 0.6); set(A, C, 0.6); set(G, T, 0.6);
  set(T, A, 0.3); set(A, T, 0.3);
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
  std::vector<double> ps(L, 0.0);
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
