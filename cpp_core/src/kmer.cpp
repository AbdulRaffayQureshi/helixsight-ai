#include "helixsight/kmer.hpp"
#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <vector>
#include "helixsight/types.hpp"

namespace hs {
std::size_t kmer_n_windows(std::size_t L, std::size_t window, std::size_t stride) {
  if (window == 0 || stride == 0) throw std::invalid_argument("window and stride must be >= 1");
  if (L == 0) return 0;
  if (L <= window) return 1;
  return (L - window + stride - 1) / stride + 1;
}

void kmer_matrix(const std::uint8_t* seq, std::size_t L, unsigned k, std::size_t window,
                 std::size_t stride, std::uint32_t* out) {
  if (k < 1 || k > kMaxK) throw std::invalid_argument("k must be in [1, 8]");
  if (window < k) throw std::invalid_argument("window must be >= k");
  if (stride == 0 || stride > window) throw std::invalid_argument("stride must be in [1, window]");
  const std::size_t n_win = kmer_n_windows(L, window, stride);
  if (n_win == 0) return;

  const std::size_t ncell = std::size_t{1} << (2 * k);
  const std::uint32_t mask = static_cast<std::uint32_t>(ncell - 1);
  constexpr std::uint32_t kInvalid = 0xFFFFFFFFu;

  std::vector<std::uint32_t> kidx(L, kInvalid);
  {
    std::uint32_t h = 0;
    std::size_t run = 0;
    for (std::size_t j = 0; j < L; ++j) {
      const std::uint8_t b = seq[j];
      if (b > 3) {
        run = 0;
        h = 0;
        continue;
      }
      h = ((h << 2) | b) & mask;
      if (++run >= k) kidx[j] = h;
    }
  }

  std::vector<std::uint32_t> cur(ncell, 0);
  std::size_t lo = 0, hi = 0;
  for (std::size_t i = 0; i < n_win; ++i) {
    const std::size_t s = i * stride;
    const std::size_t e = std::min(L, s + window);
    const std::size_t nlo = std::min(s + k - 1, L);
    const std::size_t nhi = std::max(e, nlo);
    for (std::size_t j = lo, end = std::min(hi, nlo); j < end; ++j)
      if (kidx[j] != kInvalid) --cur[kidx[j]];
    for (std::size_t j = std::max(hi, nlo); j < nhi; ++j)
      if (kidx[j] != kInvalid) ++cur[kidx[j]];
    lo = nlo;
    hi = nhi;
    std::memcpy(out + i * ncell, cur.data(), ncell * sizeof(std::uint32_t));
  }
}
}  // namespace hs
