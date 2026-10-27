#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {
std::size_t kmer_n_windows(std::size_t L, std::size_t window, std::size_t stride);
void kmer_matrix(const std::uint8_t* seq, std::size_t L, unsigned k, std::size_t window,
                 std::size_t stride, std::uint32_t* out);
}  // namespace hs
