#pragma once
#include <cstdint>
#include <string_view>

namespace hs {
std::int64_t encode_into(std::string_view s, std::uint8_t* out) noexcept;

[[nodiscard]] inline char decode_base(std::uint8_t code) noexcept {
  return "ACGTN"[code > 4 ? 4 : code];
}
}  // namespace hs
