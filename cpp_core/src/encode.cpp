#include "helixsight/encode.hpp"
#include <array>
#include <cstddef>
#include "helixsight/types.hpp"

namespace hs {
namespace {
constexpr std::uint8_t kInvalid = 0xFF;

constexpr std::array<std::uint8_t, 256> make_lut() {
  std::array<std::uint8_t, 256> t{};
  for (auto& v : t) v = kInvalid;
  auto set = [&t](char upper, std::uint8_t v) {
    t[static_cast<unsigned char>(upper)] = v;
    t[static_cast<unsigned char>(upper) + 32] = v;
  };
  set('A', kBaseA);
  set('C', kBaseC);
  set('G', kBaseG);
  set('T', kBaseT);
  set('U', kBaseT);
  for (char c : {'R', 'Y', 'S', 'W', 'K', 'M', 'B', 'D', 'H', 'V', 'N'}) set(c, kBaseN);
  return t;
}
constexpr auto kLut = make_lut();
}  // namespace

std::int64_t encode_into(std::string_view s, std::uint8_t* out) noexcept {
  std::int64_t first_bad = -1;
  for (std::size_t i = 0; i < s.size(); ++i) {
    std::uint8_t v = kLut[static_cast<unsigned char>(s[i])];
    if (v == kInvalid) {
      if (first_bad < 0) first_bad = static_cast<std::int64_t>(i);
      v = kBaseN;
    }
    out[i] = v;
  }
  return first_bad;
}
}  // namespace hs
