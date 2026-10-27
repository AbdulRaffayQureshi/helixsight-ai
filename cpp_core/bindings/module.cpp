#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

#include "helixsight/cgr.hpp"
#include "helixsight/encode.hpp"
#include "helixsight/gc.hpp"
#include "helixsight/kmer.hpp"
#include "helixsight/thermo.hpp"
#include "helixsight/types.hpp"
#include "helixsight/version.hpp"
#include "helixsight/window.hpp"
#include "helixsight/zdna.hpp"

namespace py = pybind11;

namespace {

template <class T>
using Arr = py::array_t<T, py::array::c_style>;

const std::uint8_t* in_seq(const Arr<std::uint8_t>& a, std::size_t* n) {
  if (a.ndim() != 1) throw std::invalid_argument("seq: expected a 1-D uint8 array");
  *n = static_cast<std::size_t>(a.shape(0));
  return a.data();
}

template <class T>
T* out_1d(Arr<T>& a, std::size_t expected, const char* name) {
  if (a.ndim() != 1 || static_cast<std::size_t>(a.shape(0)) != expected)
    throw std::invalid_argument(std::string(name) + ": expected a 1-D array of length " +
                                std::to_string(expected));
  return a.mutable_data();
}

hs::ThermoParams make_params(double na_mM, double strand_nM, double temp_c) {
  hs::ThermoParams p;
  p.na_mM = na_mM;
  p.strand_nM = strand_nM;
  p.temp_c = temp_c;
  return p;
}

std::string compiler_string() {
#if defined(__clang__)
  return std::string("clang ") + __clang_version__;
#elif defined(__GNUC__)
  return std::string("gcc ") + __VERSION__;
#elif defined(_MSC_VER)
  return "msvc " + std::to_string(_MSC_VER);
#else
  return "unknown";
#endif
}

}  // namespace

PYBIND11_MODULE(helixsight_core, m) {
  m.doc() = "HelixSight native bio engine: encoding, GC, thermodynamics, k-mers, CGR, Z-propensity";
  m.attr("__version__") = HS_CORE_VERSION;
  m.attr("abi_version") = HS_CORE_ABI;

  m.def(
      "build_info",
      [] {
        py::dict d;
        d["version"] = HS_CORE_VERSION;
        d["abi"] = HS_CORE_ABI;
        d["compiler"] = compiler_string();
        d["cplusplus"] = static_cast<long>(__cplusplus);
        d["pointer_bits"] = static_cast<int>(sizeof(void*) * 8);
        return d;
      },
      "Build metadata (version, ABI, compiler, C++ standard).");

  m.def(
      "encode_into",
      [](std::string_view seq, Arr<std::uint8_t> out) {
        std::uint8_t* o = out_1d(out, seq.size(), "out");
        std::int64_t bad;
        {
          py::gil_scoped_release nogil;
          bad = hs::encode_into(seq, o);
        }
        return bad;
      },
      py::arg("seq"), py::arg("out").noconvert(),
      "Encode an IUPAC string into uint8 codes (A0 C1 G2 T3 N4). Returns -1 or the offset of "
      "the first invalid character.");

  m.def(
      "gc_per_position",
      [](Arr<std::uint8_t> seq, std::size_t window, Arr<float> out_gc, Arr<float> out_skew) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        float* g = out_1d(out_gc, n, "out_gc");
        float* k = out_1d(out_skew, n, "out_skew");
        py::gil_scoped_release nogil;
        hs::gc_per_position(s, n, window, g, k);
      },
      py::arg("seq").noconvert(), py::arg("window"), py::arg("out_gc").noconvert(),
      py::arg("out_skew").noconvert(), "Windowed GC% and GC skew per position.");

  m.def(
      "thermo_per_position",
      [](Arr<std::uint8_t> seq, std::size_t window, double na_mM, double strand_nM,
         double temp_c, Arr<float> out_tm, Arr<float> out_dg) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        float* tm = out_1d(out_tm, n, "out_tm");
        float* dg = out_1d(out_dg, n, "out_dg");
        const hs::ThermoParams p = make_params(na_mM, strand_nM, temp_c);
        py::gil_scoped_release nogil;
        hs::thermo_per_position(s, n, window, p, tm, dg);
      },
      py::arg("seq").noconvert(), py::arg("window"), py::arg("na_mM") = 50.0,
      py::arg("strand_nM") = 250.0, py::arg("temp_c") = 37.0, py::arg("out_tm").noconvert(),
      py::arg("out_dg").noconvert(),
      "SantaLucia 1998 nearest-neighbour Tm (C) and dG (kcal/mol) per position.");

  m.def(
      "thermo_at",
      [](Arr<std::uint8_t> seq, std::size_t pos, std::size_t window, double na_mM,
         double strand_nM, double temp_c) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        if (pos >= n) throw std::out_of_range("pos out of range");
        const hs::ThermoParams p = make_params(na_mM, strand_nM, temp_c);
        const hs::WindowPlan wp = hs::plan_windows(n, window);
        hs::ThermoResult r;
        {
          py::gil_scoped_release nogil;
          r = hs::thermo_window(s, n, wp.start_for(pos), wp.w, p);
        }
        return py::make_tuple(r.tm_c, r.dg_kcal, r.dh_kcal, r.ds_cal, r.self_complementary);
      },
      py::arg("seq").noconvert(), py::arg("pos"), py::arg("window"), py::arg("na_mM") = 50.0,
      py::arg("strand_nM") = 250.0, py::arg("temp_c") = 37.0,
      "Thermodynamics of the single window centered on pos: (tm_c, dg_kcal, dh_kcal, ds_cal, "
      "self_complementary). Used for mutation deltas.");

  m.def(
      "zdna_per_position",
      [](Arr<std::uint8_t> seq, std::size_t window, Arr<float> out_z) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        float* z = out_1d(out_z, n, "out_z");
        py::gil_scoped_release nogil;
        hs::zdna_per_position(s, n, window, z);
      },
      py::arg("seq").noconvert(), py::arg("window"), py::arg("out_z").noconvert(),
      "Z-DNA propensity heuristic in [0,1] per position.");

  m.def(
      "cgr_points",
      [](Arr<std::uint8_t> seq, Arr<float> out_x, Arr<float> out_y) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        float* x = out_1d(out_x, n, "out_x");
        float* y = out_1d(out_y, n, "out_y");
        py::gil_scoped_release nogil;
        hs::cgr_points(s, n, x, y);
      },
      py::arg("seq").noconvert(), py::arg("out_x").noconvert(), py::arg("out_y").noconvert(),
      "Chaos Game Representation coordinates (planar x, y).");

  m.def("kmer_n_windows", &hs::kmer_n_windows, py::arg("length"), py::arg("window"),
        py::arg("stride"), "Number of rows kmer_matrix will write.");

  m.def(
      "kmer_matrix",
      [](Arr<std::uint8_t> seq, unsigned k, std::size_t window, std::size_t stride,
         Arr<std::uint32_t> out_counts) {
        std::size_t n;
        const std::uint8_t* s = in_seq(seq, &n);
        const std::size_t rows = hs::kmer_n_windows(n, window, stride);
        if (k < 1 || k > hs::kMaxK) throw std::invalid_argument("k must be in [1, 8]");
        const std::size_t cols = std::size_t{1} << (2 * k);
        if (out_counts.ndim() != 2 || static_cast<std::size_t>(out_counts.shape(0)) != rows ||
            static_cast<std::size_t>(out_counts.shape(1)) != cols)
          throw std::invalid_argument("out_counts: expected shape (" + std::to_string(rows) +
                                      ", " + std::to_string(cols) + ")");
        std::uint32_t* o = out_counts.mutable_data();
        py::gil_scoped_release nogil;
        hs::kmer_matrix(s, n, k, window, stride, o);
      },
      py::arg("seq").noconvert(), py::arg("k"), py::arg("window"), py::arg("stride"),
      py::arg("out_counts").noconvert(), "Sliding-window k-mer counts, shape (n_windows, 4**k).");
}
