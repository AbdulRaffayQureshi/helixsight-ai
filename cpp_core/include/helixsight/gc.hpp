#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {
void gc_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window, float* out_gc,
                     float* out_skew);
}  // namespace hs
