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
