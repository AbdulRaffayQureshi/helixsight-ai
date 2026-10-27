#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {
void cgr_points(const std::uint8_t* seq, std::size_t L, float* out_x, float* out_y) noexcept;
}  // namespace hs
