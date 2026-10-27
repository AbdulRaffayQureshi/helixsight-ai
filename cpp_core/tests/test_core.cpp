#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <algorithm>
#include <cmath>
#include <random>
#include <string>
#include <vector>

#include "doctest.h"
#include "helixsight/cgr.hpp"
#include "helixsight/encode.hpp"
#include "helixsight/gc.hpp"
#include "helixsight/kmer.hpp"
#include "helixsight/thermo.hpp"
#include "helixsight/window.hpp"
#include "helixsight/zdna.hpp"

using namespace hs;

namespace {
std::vector<std::uint8_t> enc(const std::string& s) {
  std::vector<std::uint8_t> v(s.size());
  REQUIRE(encode_into(s, v.data()) == -1);
  return v;
}

std::vector<std::uint8_t> random_seq(std::size_t n, unsigned seed, double p_n = 0.0) {
  std::mt19937 rng(seed);
  std::uniform_int_distribution<int> base(0, 3);
  std::uniform_real_distribution<double> u(0.0, 1.0);
  std::vector<std::uint8_t> v(n);
  for (auto& b : v) b = (u(rng) < p_n) ? 4 : static_cast<std::uint8_t>(base(rng));
  return v;
}

bool same_float(float a, float b, float tol = 1e-3f) {
  if (std::isnan(a) || std::isnan(b)) return std::isnan(a) && std::isnan(b);
  return std::fabs(a - b) <= tol * std::max(1.0f, std::fabs(a));
}
}  // namespace

TEST_CASE("encode: IUPAC, lowercase, U, invalid") {
  std::vector<std::uint8_t> out(10);
  CHECK(encode_into("ACGTacgtRN", out.data()) == -1);
  const std::vector<std::uint8_t> want{0, 1, 2, 3, 0, 1, 2, 3, 4, 4};
  CHECK(out == want);
  std::vector<std::uint8_t> o2(4);
  CHECK(encode_into("ACUG", o2.data()) == -1);
  CHECK(o2[2] == 3);
  CHECK(encode_into("AC!G", o2.data()) == 2);
  CHECK(o2[2] == 4);
  CHECK(decode_base(2) == 'G');
  CHECK(decode_base(9) == 'N');
}

TEST_CASE("window plan: centered, shift-clamped") {
  const WindowPlan p = plan_windows(10, 4);
  CHECK(p.w == 4);
  CHECK(p.n_windows == 7);
  CHECK(p.start_for(0) == 0);
  CHECK(p.start_for(2) == 0);
  CHECK(p.start_for(5) == 3);
  CHECK(p.start_for(9) == 6);
  const WindowPlan q = plan_windows(3, 100);
  CHECK(q.w == 3);
  CHECK(q.start_for(2) == 0);
  CHECK_THROWS_AS(plan_windows(5, 0), std::invalid_argument);
}

TEST_CASE("gc: windowed values, edges, ambiguity") {
  const auto s = enc("GGCCAATT");
  std::vector<float> gc(8), sk(8);
  gc_per_position(s.data(), 8, 4, gc.data(), sk.data());
  CHECK(gc[0] == doctest::Approx(100.0f));
  CHECK(sk[0] == doctest::Approx(0.0f));
  CHECK(gc[7] == doctest::Approx(0.0f));
  CHECK(std::isnan(sk[7]));
  const auto n = enc("GNNN");
  std::vector<float> g2(4), k2(4);
  gc_per_position(n.data(), 4, 4, g2.data(), k2.data());
  CHECK(g2[0] == doctest::Approx(100.0f));
  const auto allN = enc("NNNN");
  gc_per_position(allN.data(), 4, 4, g2.data(), k2.data());
  CHECK(std::isnan(g2[0]));
}

TEST_CASE("thermo: analytic SantaLucia values (1 M Na+)") {
  ThermoParams p;
  p.na_mM = 1000.0;
  const auto cg = enc("CGCGCG");
  const ThermoResult r = thermo_window(cg.data(), cg.size(), 0, 6, p);
  CHECK(r.self_complementary);
  CHECK(r.dh_kcal == doctest::Approx(-51.2).epsilon(1e-9));
  CHECK(r.ds_cal == doctest::Approx(-137.4).epsilon(1e-9));
  CHECK(r.dg_kcal == doctest::Approx(-8.5854).epsilon(1e-4));
  CHECK(std::fabs(r.tm_c - 32.33) < 0.05);

  const auto a6 = enc("AAAAAA");
  const ThermoResult q = thermo_window(a6.data(), 6, 0, 6, p);
  CHECK_FALSE(q.self_complementary);
  CHECK(q.dh_kcal == doctest::Approx(-34.9).epsilon(1e-9));
  CHECK(q.ds_cal == doctest::Approx(-102.8).epsilon(1e-9));
  CHECK(q.dg_kcal == doctest::Approx(-3.0166).epsilon(1e-3));
}

TEST_CASE("thermo: salt correction and ambiguity") {
  const auto a6 = enc("AAAAAA");
  ThermoParams p1, p2;
  p1.na_mM = 1000.0;
  p2.na_mM = 50.0;
  const double d = thermo_window(a6.data(), 6, 0, 6, p2).ds_cal - thermo_window(a6.data(), 6, 0, 6, p1).ds_cal;
  CHECK(d == doctest::Approx(0.368 * 5 * std::log(0.05)).epsilon(1e-9));
  const auto n = enc("AANAAA");
  CHECK(std::isnan(thermo_window(n.data(), 6, 0, 6, p2).tm_c));
  CHECK_THROWS_AS(thermo_window(a6.data(), 6, 4, 4, p2), std::out_of_range);
  ThermoParams bad;
  bad.na_mM = 0.0;
  CHECK_THROWS_AS(thermo_window(a6.data(), 6, 0, 6, bad), std::invalid_argument);
}

TEST_CASE("thermo: per-position (prefix sums + rolling hash) equals direct evaluation") {
  for (std::size_t window : {2u, 5u, 20u, 21u, 32u, 40u}) {
    const auto seq = random_seq(300, 7 + static_cast<unsigned>(window), 0.01);
    ThermoParams p;
    std::vector<float> tm(seq.size()), dg(seq.size());
    thermo_per_position(seq.data(), seq.size(), window, p, tm.data(), dg.data());
    const WindowPlan wp = plan_windows(seq.size(), window);
    for (std::size_t i = 0; i < seq.size(); ++i) {
      const ThermoResult r = thermo_window(seq.data(), seq.size(), wp.start_for(i), wp.w, p);
      CHECK(same_float(tm[i], static_cast<float>(r.tm_c)));
      CHECK(same_float(dg[i], static_cast<float>(r.dg_kcal)));
    }
  }
}

TEST_CASE("thermo: palindromic windows are detected by the rolling hash") {
  const auto seq = enc("ACGTACGTACGTACGTACGT");
  ThermoParams p;
  std::vector<float> tm(20), dg(20);
  thermo_per_position(seq.data(), 20, 4, p, tm.data(), dg.data());
  const ThermoResult r = thermo_window(seq.data(), 20, 8, 4, p);
  CHECK(r.self_complementary);
  CHECK(same_float(tm[10], static_cast<float>(r.tm_c)));
}

TEST_CASE("kmer: incremental sweep equals brute force (with ambiguity, partial last window)") {
  const auto seq = random_seq(1000, 99, 0.01);
  for (unsigned k : {1u, 3u, 4u}) {
    const std::size_t window = 64, stride = 16;
    const std::size_t n_win = kmer_n_windows(seq.size(), window, stride);
    const std::size_t ncell = std::size_t{1} << (2 * k);
    std::vector<std::uint32_t> got(n_win * ncell, 7);
    kmer_matrix(seq.data(), seq.size(), k, window, stride, got.data());
    for (std::size_t i = 0; i < n_win; ++i) {
      const std::size_t s = i * stride, e = std::min(seq.size(), s + window);
      std::vector<std::uint32_t> want(ncell, 0);
      for (std::size_t j = s; j + k <= e; ++j) {
        std::uint32_t h = 0;
        bool ok = true;
        for (unsigned t = 0; t < k; ++t) {
          if (seq[j + t] > 3) { ok = false; break; }
          h = (h << 2) | seq[j + t];
        }
        if (ok) ++want[h];
      }
      for (std::size_t c = 0; c < ncell; ++c) REQUIRE(got[i * ncell + c] == want[c]);
    }
  }
}

TEST_CASE("kmer: window counts, k=8 shape and argument validation") {
  CHECK(kmer_n_windows(0, 10, 5) == 0);
  CHECK(kmer_n_windows(10, 10, 5) == 1);
  CHECK(kmer_n_windows(11, 10, 5) == 2);
  CHECK(kmer_n_windows(100, 10, 5) == 19);
  std::vector<std::uint32_t> out(4);
  const auto s = random_seq(50, 1);
  CHECK_THROWS_AS(kmer_matrix(s.data(), 50, 0, 10, 5, out.data()), std::invalid_argument);
  CHECK_THROWS_AS(kmer_matrix(s.data(), 50, 9, 20, 5, out.data()), std::invalid_argument);
  CHECK_THROWS_AS(kmer_matrix(s.data(), 50, 4, 3, 1, out.data()), std::invalid_argument);
  CHECK_THROWS_AS(kmer_matrix(s.data(), 50, 4, 10, 11, out.data()), std::invalid_argument);
}

TEST_CASE("cgr: corners, midpoint rule, ambiguity does not advance state") {
  const auto s = enc("AGNC");
  std::vector<float> x(4), y(4);
  cgr_points(s.data(), 4, x.data(), y.data());
  CHECK(x[0] == doctest::Approx(0.25f));
  CHECK(y[0] == doctest::Approx(0.25f));
  CHECK(x[1] == doctest::Approx(0.625f));
  CHECK(y[1] == doctest::Approx(0.625f));
  CHECK(std::isnan(x[2]));
  CHECK(x[3] == doctest::Approx(0.3125f));
  CHECK(y[3] == doctest::Approx(0.8125f));
}

TEST_CASE("zdna: CG repeat saturates, poly-A is zero, ambiguity is NaN") {
  const auto cg = enc("CGCGCGCGCGCG");
  std::vector<float> z(12);
  zdna_per_position(cg.data(), 12, 12, z.data());
  CHECK(z[5] == doctest::Approx(1.0f));
  const auto a = enc("AAAAAAAAAAAA");
  zdna_per_position(a.data(), 12, 12, z.data());
  CHECK(z[5] == doctest::Approx(0.0f));
  const auto n = enc("CGCGCNCGCGCG");
  zdna_per_position(n.data(), 12, 12, z.data());
  CHECK(std::isnan(z[5]));
  const auto ca = enc("CACACACACACA");
  zdna_per_position(ca.data(), 12, 12, z.data());
  CHECK(z[5] == doctest::Approx(0.41818f).epsilon(1e-3));
}
