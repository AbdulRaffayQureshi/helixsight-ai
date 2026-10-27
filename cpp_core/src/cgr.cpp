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
    const double cx = static_cast<double>(b >> 1);
    const double cy = static_cast<double>((b & 1u) ^ (b >> 1));
    x = 0.5 * (x + cx);
    y = 0.5 * (y + cy);
    out_x[i] = static_cast<float>(x);
    out_y[i] = static_cast<float>(y);
  }
}
}  // namespace hs
