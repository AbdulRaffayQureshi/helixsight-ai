#pragma once
#include <cstddef>
#include <cstdint>
#include <limits>

namespace hs {
inline constexpr std::uint8_t kBaseA = 0, kBaseC = 1, kBaseG = 2, kBaseT = 3, kBaseN = 4;
inline constexpr float kNaNf = std::numeric_limits<float>::quiet_NaN();
inline constexpr unsigned kMaxK = 8;

[[nodiscard]] constexpr bool is_acgt(std::uint8_t b) noexcept { return b < 4; }
}  // namespace hs
