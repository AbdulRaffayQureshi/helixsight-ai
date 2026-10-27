.RECIPEPREFIX = >
.PHONY: setup native test-native test-py test-web test dev export-onnx license-audit clean

setup:
> uv python install 3.12
> uv sync
> cd frontend && pnpm install

native:
> uv sync --reinstall-package helixsight-core
> uv run python -c "import helixsight_core as h; print(h.__version__, h.build_info())"

test-native:
> cmake -S cpp_core -B cpp_core/build/tests -G Ninja -DHS_BUILD_PYTHON=OFF -DHS_BUILD_TESTS=ON -DHS_SANITIZE=ON -DCMAKE_BUILD_TYPE=Debug
> cmake --build cpp_core/build/tests
> ctest --test-dir cpp_core/build/tests --output-on-failure

test-py:
> uv run pytest

test-web:
> cd frontend && pnpm test

test: test-native test-py test-web

dev:
> bash scripts/dev.sh

export-onnx:
> uv run python -m helixsight.ml.onnx_export
> cp ml_models/onnx/hs-cnnbilstm-v1.fp32.onnx ml_models/onnx/model.json frontend/public/models/

license-audit:
> uv run pip-licenses --format=json --output-file=/tmp/py-licenses.json
> cd frontend && pnpm licenses list --json > /tmp/js-licenses.json
> uv run python scripts/license_audit.py /tmp/py-licenses.json /tmp/js-licenses.json

clean:
> rm -rf cpp_core/build frontend/dist .pytest_cache
