#pragma once
#include <cstddef>
#include <cstdint>

namespace hs {
struct ThermoParams {
  double na_mM = 50.0;
  double strand_nM = 250.0;
  double temp_c = 37.0;
};

struct ThermoResult {
  double tm_c;
  double dg_kcal;
  double dh_kcal;
  double ds_cal;
  bool self_complementary;
};

ThermoResult thermo_window(const std::uint8_t* seq, std::size_t L, std::size_t start,
                           std::size_t len, const ThermoParams& p);

void thermo_per_position(const std::uint8_t* seq, std::size_t L, std::size_t window,
                         const ThermoParams& p, float* out_tm, float* out_dg);
}  // namespace hs
