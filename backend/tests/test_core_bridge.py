import asyncio
import numpy as np
import pytest
from helixsight.core_bridge import native as nb

pytestmark = pytest.mark.skipif(not nb.CORE_AVAILABLE, reason="helixsight_core not built")


def test_encode_and_invalid_offset():
    assert nb.encode("ACGTN").tolist() == [0, 1, 2, 3, 4]
    with pytest.raises(ValueError, match="offset 2"):
        nb.encode("ACZT")


def test_all_channels_and_nan_masking():
    codes = nb.encode("ACGT" * 2500 + "N" * 5 + "CGCGCGCGCGCG" * 10)
    planes = nb.alloc_planes(len(codes))
    counts = asyncio.run(nb.compute_core_channels_async(codes, planes))
    assert counts.shape == (37, 256)
    assert np.isfinite(planes[nb.CH_GC]).all() and np.isfinite(planes[nb.CH_CGR_X]).sum() == len(codes) - 5
    assert np.isnan(planes[7:]).all()
    assert nb.local_thermo(codes, 10002) is None
    assert nb.local_thermo(codes, len(codes) - 20) is not None


def test_numpy_fallback_matches_native_gc(monkeypatch):
    codes = nb.encode("ACGTNNGGCC" * 300)
    g1, k1, g2, k2 = (np.empty(len(codes), np.float32) for _ in range(4))
    nb.gc_per_position(codes, 100, g1, k1)
    monkeypatch.setattr(nb, "_core", None)
    nb.gc_per_position(codes, 100, g2, k2)
    assert np.allclose(g1, g2, equal_nan=True) and np.allclose(k1, k2, equal_nan=True)


def test_boundary_errors():
    codes = nb.encode("ACGT" * 10)
    ro = np.empty(40, np.float32)
    ro.flags.writeable = False
    with pytest.raises(ValueError):
        nb._core.cgr_points(codes, ro, np.empty(40, np.float32))
    with pytest.raises(TypeError):
        nb._core.cgr_points(codes, np.empty(40, np.float64), np.empty(40, np.float32))
    with pytest.raises(ValueError):
        nb._core.kmer_matrix(codes, 4, 20, 25, np.empty((1, 256), np.uint32))
