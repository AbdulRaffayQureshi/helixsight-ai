#pragma once
#include <cstddef>
#include <stdexcept>

namespace hs {
struct WindowPlan {
  std::size_t L = 0;
  std::size_t w = 0;
  std::size_t n_windows = 0;

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
