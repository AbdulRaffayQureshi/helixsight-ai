#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {
void zdna_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window, float* out_z);
}  // namespace hs
