# 05_SETUP_REQUIREMENTS_AND_ROADMAP.md

> **HelixSight AI** · Document `05` of `05` · Depends on: `00`–`04`
> Scope: exact terminal commands (WSL2/Ubuntu primary, Windows-native secondary), dependency manifests, config files, and the step-by-step build order with acceptance checks.
> **Verification status — read this first.** Verified on Ubuntu 24.04 / gcc 13.3 / Python 3.12: the C++ compile + sanitizer run, the standalone CMake/ctest flow, the scikit-build-core wheel build + clean-venv import, the DuckDB layer, and the Python bridge (doc 04). **Not executed here:** `uv sync` on the workspace below, torch/ONNX steps, everything under `frontend/`, the Windows-native path (MSVC, winget), and Playwright. Package version ranges are conservative lower bounds that I have **not** checked against the latest releases; after the first successful install, `uv.lock` and `pnpm-lock.yaml` become the truth (commit them) and you bump deliberately.

---

## 0. HOW THE PIECES BUILD AND CONNECT

```text
 uv workspace (root pyproject.toml)
   ├─ member: cpp_core ──(scikit-build-core + CMake + Ninja + g++)──► wheel "helixsight-core" ──► installed into .venv  (import helixsight_core)
   └─ member: backend  ──(hatchling)────────────────────────────────► package "helixsight"      (depends on helixsight-core via workspace source)
 .venv ──► uvicorn helixsight.main:create_app --factory   :8000   (REST /api, WS /ws/scan, /ws/events)
 ml_models/training ──► checkpoints/*.pt ──► make export-onnx ──► ml_models/onnx/*.onnx ──► frontend/public/models/ (+ ORT WASM → public/ort/)
 pnpm workspace ──► frontend (Vite :5173) ──proxy /api, /ws──► :8000
 data/helixsight.duckdb  (backend)   ⇄ sync(rev) ⇄   IndexedDB "helixsight" (browser)
```

| Concern | Decision |
|---|---|
| Primary platform | **WSL2 Ubuntu 24.04**, repo stored in the **Linux filesystem** (`~/projects/helixsight-ai`), never under `/mnt/c` (slow I/O, no inotify, C-5). |
| Browser | Windows Chrome/Edge opens `http://localhost:5173` (WSL2 forwards localhost). |
| Python | 3.12 via `uv python install 3.12` (spec floor is 3.11). |
| Node | 22 LTS (Vite 6 needs ≥ 20.19). pnpm pinned via `packageManager` (Corepack). |
| Compilers | `g++` ≥ 11 for C++20 (Ubuntu 24.04 ships 13), CMake ≥ 3.20, Ninja. |

---

## 1. WINDOWS 11 HOST SETUP (PowerShell as Administrator)

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
wsl --set-default-version 2
wsl -l -v          # Ubuntu-24.04 must show VERSION 2
```
Reboot if prompted, launch "Ubuntu 24.04", create the Linux user.

Create `%UserProfile%\.wslconfig` (caps WSL so a 16 GB machine stays responsive):
```ini
[wsl2]
memory=10GB
processors=6
swap=4GB
localhostForwarding=true
```
Apply it:
```powershell
wsl --shutdown
```
Optional: install VS Code + the "WSL" extension and open the repo with `code .` from inside Ubuntu.

---

## 2. UBUNTU TOOLCHAIN (inside WSL2)

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential cmake ninja-build pkg-config git curl ca-certificates unzip jq

# uv (Python manager + resolver)
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.local/bin/env 2>/dev/null || export PATH="$HOME/.local/bin:$PATH"
uv --version
uv python install 3.12

# Node 22 LTS via nvm, pnpm via Corepack
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 22 && nvm use 22
corepack enable
node --version && pnpm --version     # pnpm resolves from package.json "packageManager"

# verify the native toolchain
g++ --version | head -1     # >= 11 (13.x on Ubuntu 24.04)
cmake --version | head -1   # >= 3.20
ninja --version
```
Persist the nvm/uv lines by letting their installers edit `~/.bashrc`, then open a new shell.

---

## 3. REPOSITORY BOOTSTRAP

```bash
mkdir -p ~/projects && cd ~/projects
mkdir helixsight-ai && cd helixsight-ai
git init -b main

mkdir -p docs/adr docs/diagrams scripts data \
         frontend/public/icons frontend/public/models frontend/public/ort frontend/scripts \
         frontend/src/{contracts,api,db,lib,store,workers,audio,components/{ingestion,history,helix,hud,common}} \
         backend/src/helixsight/{api,schemas,ingestion,db/migrations,core_bridge,ml,streaming} backend/tests \
         cpp_core/{include/helixsight,src,bindings,tests,third_party/doctest} \
         ml_models/{training,datasets,checkpoints,onnx,MODEL_CARDS}

# put the six spec files in docs/
cp /path/to/00_MASTER_CONTEXT_AND_RULES.md /path/to/01_SYSTEM_ARCHITECTURE_AND_DATAFLOW.md \
   /path/to/02_UI_UX_AND_VISUAL_ENGINE_SPEC.md /path/to/03_AI_DL_INFERENCE_PIPELINE.md \
   /path/to/04_CPP_BIO_ENGINE_AND_SCHEMAS.md /path/to/05_SETUP_REQUIREMENTS_AND_ROADMAP.md docs/

# package markers
touch backend/src/helixsight/__init__.py backend/src/helixsight/{api,schemas,ingestion,db,core_bridge,ml,streaming}/__init__.py
```

### 3.1 Root files

`.gitignore`
```gitignore
.venv/
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.mypy_cache/
node_modules/
dist/
build/
*.egg-info/
*.so
*.pyd
.env
data/
ml_models/checkpoints/
ml_models/datasets/processed/
ml_models/datasets/raw/
frontend/public/ort/
frontend/test-results/
frontend/playwright-report/
```

`.gitattributes` (prevents CRLF corruption of shell scripts and SQL when edited from Windows)
```gitattributes
* text=auto eol=lf
*.bat text eol=crlf
*.ps1 text eol=crlf
*.onnx binary
*.pt binary
```

`.python-version`
```text
3.12
```

`.env.example` (copy to `.env`; never commit `.env`)
```ini
# --- storage / watcher -----------------------------------------------------------
HS_DB_PATH=data/helixsight.duckdb
HS_DUCKDB_MEMORY_LIMIT=1GB
HS_WATCH_DIR=~/helixsight_watch          # keep in the Linux filesystem on WSL2 (C-5)
# --- NCBI E-Utilities (free; identify yourself per NCBI usage policy) -------------
HS_NCBI_TOOL=helixsight
HS_NCBI_EMAIL=you@example.com
HS_NCBI_API_KEY=                          # optional, free: raises 3 -> 10 requests/s
# --- compute -----------------------------------------------------------------------
HS_RUNNER=ort                             # ort | torch
HS_MODEL_DIR=ml_models/onnx
HS_ORT_THREADS=1                          # keep 1 for cache-writing runs (determinism, doc 03 §12)
HS_CORE_EXECUTOR_THREADS=2
HS_CACHE_CODEC=raw                        # raw | zstd
HS_MAX_SEQ_BP=5000000
# --- server --------------------------------------------------------------------------
HS_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
HS_SERVE_STATIC=0                         # 1 = serve frontend/dist with COOP/COEP headers (single-process mode)
HS_LOG_LEVEL=info
```

Root `pyproject.toml` (uv workspace root; a real project so `uv sync` / `uv run` work from the repo root)
```toml
[project]
name = "helixsight-workspace"
version = "0.0.0"
requires-python = ">=3.11"
dependencies = ["helixsight[bio,zstd]"]

[tool.uv]
package = false                      # the root itself is never built

[tool.uv.workspace]
members = ["backend", "cpp_core"]

[tool.uv.sources]
helixsight = { workspace = true }
torch = { index = "pytorch-cpu" }    # CPU wheels: ~200 MB instead of multi-GB CUDA stacks

[[tool.uv.index]]
name = "pytorch-cpu"
url = "https://download.pytorch.org/whl/cpu"
explicit = true

[dependency-groups]
dev = [
  "pytest>=8.3",
  "pytest-asyncio>=0.24",
  "ruff>=0.6",
  "mypy>=1.11",
  "pip-licenses>=5.0",
]

[tool.pytest.ini_options]
testpaths = ["backend/tests"]
asyncio_mode = "auto"

[tool.ruff]
line-length = 110
target-version = "py311"
extend-exclude = ["cpp_core/third_party"]

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
ignore = ["E501"]
```

`backend/pyproject.toml`
```toml
[build-system]
requires = ["hatchling>=1.25"]
build-backend = "hatchling.build"

[project]
name = "helixsight"
version = "0.1.0"
description = "HelixSight AI backend: ingestion, streaming, ML inference"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "httpx>=0.27",
  "python-multipart>=0.0.9",     # required by FastAPI for multipart file uploads
  "pydantic>=2.8",
  "pydantic-settings>=2.4",
  "duckdb>=1.1",
  "watchdog>=5.0",
  "numpy>=1.26",
  "scikit-learn>=1.5",
  "torch>=2.4",
  "onnx>=1.16",
  "onnxruntime>=1.19",
  "helixsight-core",
]

[project.optional-dependencies]
bio = ["biopython>=1.84"]
zstd = ["zstandard>=0.23"]
hf = ["transformers>=4.44", "optimum[onnxruntime]>=1.22"]   # only for the optional pretrained-adapter slot

[tool.uv.sources]
helixsight-core = { workspace = true }

[tool.hatch.build.targets.wheel]
packages = ["src/helixsight"]
```

`backend/requirements.txt` — human-maintained mirror for people not using `uv sync` (the lock is `uv.lock`; regenerate an exact pinned export with `uv export --no-hashes --package helixsight -o backend/requirements.lock.txt`)
```text
# Runtime dependencies of backend/pyproject.toml. Install torch FIRST from the CPU index:
#   uv pip install torch --index-url https://download.pytorch.org/whl/cpu
# then:  uv pip install -r backend/requirements.txt && uv pip install ./cpp_core
fastapi>=0.115
uvicorn[standard]>=0.30
httpx>=0.27
python-multipart>=0.0.9
pydantic>=2.8
pydantic-settings>=2.4
duckdb>=1.1
watchdog>=5.0
numpy>=1.26
scikit-learn>=1.5
torch>=2.4
onnx>=1.16
onnxruntime>=1.19
biopython>=1.84
zstandard>=0.23
```

`backend/requirements-dev.txt`
```text
pytest>=8.3
pytest-asyncio>=0.24
ruff>=0.6
mypy>=1.11
pip-licenses>=5.0
```

### 3.2 `cpp_core/` and DuckDB files
Create exactly the files from doc 04: `cpp_core/CMakeLists.txt`, `cpp_core/pyproject.toml` (§5), `include/helixsight/*.hpp` (§3), `src/*.cpp` (§3), `bindings/module.cpp` (§4), `tests/test_core.cpp` (§6); `backend/src/helixsight/ids.py`, `db/duckdb_store.py`, `db/repo.py`, `db/migrations/001_init.sql`, `core_bridge/native.py` (§7–9); tests `backend/tests/test_core_bridge.py`, `test_duckdb_repo.py`. Vendor the test header:
```bash
curl -sSL -o cpp_core/third_party/doctest/doctest.h \
  https://raw.githubusercontent.com/doctest/doctest/v2.4.11/doctest/doctest.h
```

### 3.3 `backend/src/helixsight/config.py`
```python
from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration comes from HS_* environment variables / .env (see .env.example)."""
    model_config = SettingsConfigDict(env_prefix="HS_", env_file=".env", extra="ignore")

    db_path: Path = Path("data/helixsight.duckdb")
    duckdb_memory_limit: str = "1GB"
    watch_dir: Path = Path("~/helixsight_watch")
    ncbi_tool: str = "helixsight"
    ncbi_email: str = ""
    ncbi_api_key: str = ""
    runner: Literal["ort", "torch"] = "ort"
    model_dir: Path = Path("ml_models/onnx")
    ort_threads: int = 1
    core_executor_threads: int = 2
    cache_codec: Literal["raw", "zstd"] = "raw"
    max_seq_bp: int = 5_000_000
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    serve_static: bool = False
    log_level: str = "info"

    @field_validator("watch_dir", "db_path", "model_dir")
    @classmethod
    def _expand(cls, v: Path) -> Path:
        return v.expanduser()

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def watch_uses_polling(self) -> bool:
        return str(self.watch_dir.resolve()).startswith("/mnt/")   # WSL2 /mnt/* has no reliable inotify (C-5)


settings = Settings()
```
Single-process mode (`HS_SERVE_STATIC=1`, used for P9 packaging): `main.py` mounts `frontend/dist` with `StaticFiles(html=True)` and adds the isolation headers ONNX Runtime Web's threaded WASM needs:
```python
from starlette.middleware.base import BaseHTTPMiddleware

class IsolationHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        return resp
```

### 3.4 Frontend manifests

`pnpm-workspace.yaml`
```yaml
packages:
  - "frontend"
```

Root `package.json`
```json
{
  "name": "helixsight-ai",
  "private": true,
  "version": "0.1.0",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=20.19" },
  "scripts": {
    "dev:web": "pnpm --filter helixsight-frontend dev",
    "build:web": "pnpm --filter helixsight-frontend build",
    "test:web": "pnpm --filter helixsight-frontend test",
    "typecheck:web": "pnpm --filter helixsight-frontend typecheck"
  }
}
```

`frontend/package.json`
```json
{
  "name": "helixsight-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "predev": "node scripts/copy-ort-assets.mjs",
    "dev": "vite",
    "prebuild": "node scripts/copy-ort-assets.mjs",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview --port 4173",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "idb": "^8.0.0",
    "onnxruntime-web": "^1.20.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "three": "^0.170.0",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@types/three": "^0.170.0",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "fake-indexeddb": "^6.0.0",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vite-plugin-pwa": "^0.21.0",
    "vitest": "^3.0.0",
    "workbox-window": "^7.3.0"
  }
}
```
All of these are MIT/Apache/ISC/BSD (C-1). Tailwind is pinned to 3.x because its config/PostCSS layout differs in 4.x.

`frontend/vite.config.ts`
```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Cross-origin isolation enables multi-threaded WASM (SharedArrayBuffer) in onnxruntime-web.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "HelixSight AI",
        short_name: "HelixSight",
        description: "Local-first AI bioinformatics workbench",
        theme_color: "#070B14",
        background_color: "#070B14",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,wasm,mjs,onnx,json}"],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,   // ORT wasm + model
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: isolation,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: false },
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
```

`frontend/vitest.config.ts`
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",                 // pure-math tests (geometry, FCGR, canonicalize); use `// @vitest-environment jsdom` per file for DOM tests
    setupFiles: ["fake-indexeddb/auto"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

`frontend/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["vite/client", "vite-plugin-pwa/client", "node"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`frontend/tailwind.config.ts`
```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)", panel: "var(--panel)", "panel-2": "var(--panel-2)", border: "var(--border)",
        text: "var(--text)", muted: "var(--muted)", head: "var(--head)", alert: "var(--alert)", attn: "var(--attn)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "Cascadia Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
} satisfies Config;
```

`frontend/postcss.config.js`
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`frontend/index.html`
```html
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#070B14" />
    <title>HelixSight AI</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`frontend/scripts/copy-ort-assets.mjs` (ORT-Web WASM must be served locally, C-2)
```js
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = join(process.cwd(), "node_modules", "onnxruntime-web", "dist");
const dst = join(process.cwd(), "public", "ort");
if (!existsSync(src)) {
  console.error(`onnxruntime-web not installed (${src}). Run: pnpm install`);
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) { cpSync(join(src, f), join(dst, f)); n++; }
}
console.log(`copied ${n} ORT-Web runtime files to public/ort`);
```

### 3.5 Task runner and dev script

`Makefile` (uses `.RECIPEPREFIX` so no tab characters are needed)
```make
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
```

`scripts/dev.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data "${HS_WATCH_DIR:-$HOME/helixsight_watch}"
[ -f .env ] || cp .env.example .env

uv run uvicorn helixsight.main:create_app --factory --host 127.0.0.1 --port 8000 \
    --reload --reload-dir backend/src &
API=$!
( cd frontend && pnpm dev ) &
WEB=$!
trap 'kill $API $WEB 2>/dev/null || true' EXIT INT TERM
echo "API http://127.0.0.1:8000/docs   |   UI http://localhost:5173"
wait -n
```
```bash
chmod +x scripts/dev.sh
```

`scripts/license_audit.py` (gate for C-1: fails on strong-copyleft licences)
```python
"""Usage: license_audit.py py-licenses.json js-licenses.json  (exit 1 on a disallowed licence)."""
import json
import re
import sys

BLOCK = re.compile(r"\b(AGPL|GPL|SSPL|BUSL|Commons Clause|CC-BY-NC)\b", re.I)
ALLOW_LGPL_NOTE = re.compile(r"LGPL", re.I)   # LGPL is dynamically linked pure-Python/JS only: review manually, don't hard-fail


def check(name: str, lic: str, bad: list, review: list) -> None:
    if ALLOW_LGPL_NOTE.search(lic):
        review.append((name, lic))
    elif BLOCK.search(lic):
        bad.append((name, lic))


def main(py_path: str, js_path: str) -> int:
    bad, review = [], []
    for p in json.load(open(py_path)):
        check(p["Name"], p["License"], bad, review)
    for lic, pkgs in json.load(open(js_path)).items():
        for p in pkgs:
            check(p["name"], lic, bad, review)
    for n, l in review:
        print(f"REVIEW  {n}: {l}")
    for n, l in bad:
        print(f"BLOCKED {n}: {l}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
```
Model weights are audited by hand through `MODEL_CARDS/` (doc 03 §14); this script covers code dependencies only.

---

## 4. FIRST BUILD (WSL2) — COMMAND SEQUENCE

```bash
cd ~/projects/helixsight-ai
cp .env.example .env && sed -i "s|you@example.com|YOUR_REAL_EMAIL|" .env

# 1) Python workspace: resolves, downloads the CPU torch wheel, compiles cpp_core into a wheel
uv sync
uv run python -c "import helixsight_core as h; print(h.__version__, h.build_info())"
#   expect: 0.1.0 {'version': '0.1.0', 'abi': 1, 'compiler': 'gcc 13...', 'cplusplus': 202002, ...}

# 2) native tests (standalone, with ASan/UBSan) and Python tests
make test-native        # expect: 100% tests passed out of 1  (11 doctest cases)
make test-py            # expect: test_core_bridge.py and test_duckdb_repo.py pass

# 3) frontend
cd frontend && pnpm install && pnpm typecheck && cd ..

# 4) run everything (after the backend/ frontend entry points from later steps exist)
make dev                # API :8000, UI :5173
```
`uv sync` rebuilds `helixsight-core` only when `cpp_core/` changes. After editing C++ run `make native` (forces a rebuild) — the wheel is installed as a normal package, not editable.

---

## 5. STANDALONE C++ AND KERNEL BENCHMARK

```bash
# fast edit-compile-test loop without Python (also what CI should run)
cmake -S cpp_core -B cpp_core/build/tests -G Ninja -DHS_BUILD_PYTHON=OFF -DHS_BUILD_TESTS=ON -DCMAKE_BUILD_TYPE=Release
cmake --build cpp_core/build/tests && ./cpp_core/build/tests/hs_tests

# with sanitizers (what `make test-native` does)
cmake -S cpp_core -B cpp_core/build/asan -G Ninja -DHS_BUILD_PYTHON=OFF -DHS_BUILD_TESTS=ON -DHS_SANITIZE=ON -DCMAKE_BUILD_TYPE=Debug
cmake --build cpp_core/build/asan && ctest --test-dir cpp_core/build/asan --output-on-failure
```
`scripts/bench_core.py` (record numbers for P1.8; reference on the doc-04 machine: GC 14 ms, thermo 39 ms, Z 10 ms, CGR 2 ms, k-mer 3.3 ms per Mbp):
```python
import time

import numpy as np
import helixsight_core as hc

L = 1_000_000
seq = np.random.default_rng(0).integers(0, 4, L, dtype=np.uint8)


def timed(name, fn):
    t0 = time.perf_counter(); fn(); print(f"{name:22s}{(time.perf_counter() - t0) * 1000:8.1f} ms")


gc, sk, tm, dg, z, x, y = (np.empty(L, np.float32) for _ in range(7))
nw = hc.kmer_n_windows(L, 1024, 256)
km = np.empty((nw, 256), np.uint32)
timed("gc_per_position", lambda: hc.gc_per_position(seq, 100, gc, sk))
timed("thermo_per_position", lambda: hc.thermo_per_position(seq, 20, 50.0, 250.0, 37.0, tm, dg))
timed("zdna_per_position", lambda: hc.zdna_per_position(seq, 12, z))
timed("cgr_points", lambda: hc.cgr_points(seq, x, y))
timed("kmer_matrix k=4", lambda: hc.kmer_matrix(seq, 4, 1024, 256, km))
```
Run: `uv run python scripts/bench_core.py`.

---

## 6. WINDOWS-NATIVE ALTERNATIVE (secondary path; not executed during spec authoring)

Use only if you cannot use WSL2. Watched folders on NTFS work through `ReadDirectoryChangesW` (the `/mnt/*` caveat does not apply). PowerShell (admin) for tools:
```powershell
winget install --id Git.Git -e
winget install --id astral-sh.uv -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Kitware.CMake -e
winget install --id Ninja-build.Ninja -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```
Open **"Developer PowerShell for VS 2022"** (so `cl.exe` is on PATH), then:
```powershell
corepack enable
uv python install 3.12
cd $HOME\projects\helixsight-ai
uv sync
uv run python -c "import helixsight_core as h; print(h.__version__, h.build_info())"

# native tests (MSVC multi-config generator; sanitizers are GCC/Clang-only and ignored)
cmake -S cpp_core -B cpp_core\build\tests -DHS_BUILD_PYTHON=OFF -DHS_BUILD_TESTS=ON
cmake --build cpp_core\build\tests --config Release
ctest --test-dir cpp_core\build\tests -C Release --output-on-failure

# run
$env:HS_WATCH_DIR = "$HOME\helixsight_watch"
uv run uvicorn helixsight.main:create_app --factory --host 127.0.0.1 --port 8000 --reload
cd frontend; pnpm install; pnpm dev
```
`make` is not assumed on Windows: run the underlying commands from `Makefile`. MSVC flags `/W4 /permissive-` are configured in `CMakeLists.txt`; if MSVC rejects a construct, fix it in the C++ (do not weaken the flags) and add an ADR.

---

## 7. STEP-BY-STEP BUILD ORDER (with acceptance checks)

Each step names the tracker IDs in `00` §8, the files to create, the commands, and what "done" means. Do not start a step until the previous one's checks pass.

```text
B0 ─► B1 ─► B2 ─► B3 ─► B4 ─► B5 ─► B6 ───────────► B9 ─► B10 ─► B11 ─► B12
                  │                      ▲          ▲
                  └──────► B7 (ML) ──► B8 (streaming)┘      (B7 can start after B3; B8 needs B2, B3, B7-min)
```

**B0 — Toolchain & skeleton (P0.5, P0.6)**
Do: §1–§3 above. Add `scripts/license_audit.py`.
Check: `uv --version`, `pnpm --version`, `g++ --version`, `cmake --version` succeed; `git status` clean after first commit; `make license-audit` exits 0 once dependencies are installed.

**B1 — Native core (P1.1–P1.5)**
Do: create `cpp_core/{include,src,tests,CMakeLists.txt}` from doc 04 §3, §5.1, §6; vendor doctest.
Check: `make test-native` → "100% tests passed", no sanitizer reports. Edit one analytic expectation (e.g. ΔH of `CGCGCG`) and confirm the suite fails, then revert.

**B2 — Python binding + wheel (P1.6, P1.7, P1.8)**
Do: add `bindings/module.cpp`, `cpp_core/pyproject.toml`, `backend/.../core_bridge/native.py`, `backend/tests/test_core_bridge.py`; run `uv sync`.
Check: `uv run python -c "import helixsight_core"`; `uv run pytest backend/tests/test_core_bridge.py`; `uv run python scripts/bench_core.py` — native total for 1 Mbp ≤ 100 ms (record the numbers in `docs/adr/0001-native-bench.md`).

**B3 — Storage layer (P2.2)**
Do: `ids.py`, `db/duckdb_store.py`, `db/repo.py`, `db/migrations/001_init.sql`, `test_duckdb_repo.py`.
Check: `uv run pytest backend/tests/test_duckdb_repo.py`; `uv run python -c "from helixsight.db.duckdb_store import DuckStore; s=DuckStore('data/helixsight.duckdb'); s.open(); s.close()"` creates the file; reopening is idempotent (migration skipped).

**B4 — Sanitizer, hashing, paste lane, history API (P2.1, P2.3, P2.4, P2.5)**
Do: `config.py`, `main.py` (app factory + lifespan opening `DuckStore`), `schemas/*` (doc 01 §10), `ingestion/sanitizer.py` + `hasher.py` + `pipeline.py`, routes `routes_ingest.py` (paste), `routes_history.py`. Write `docs/golden_vectors.json` (≥ 20 cases: raw, multi-FASTA, GenBank numbering, RNA, lowercase, IUPAC, invalid char offsets, empty, too long) and assert the Python output against it.
Check:
```bash
uv run uvicorn helixsight.main:create_app --factory --port 8000 &
curl -s -X POST localhost:8000/api/ingest/paste -H 'content-type: application/json' \
     -d '{"text":">demo\nATGCGCGATATCGCGCGTA\n","label":"demo"}' | jq '.items[0] | {sha256, cache_status, length: .record.length}'
# run the same curl again: cache_status must be HIT_SHA and a second history row appears
curl -s 'localhost:8000/api/history/sync?since_rev=0' | jq '{latest_rev, n: (.upserts|length)}'
```

**B5 — External lanes & watcher (P3.1–P3.4)**
Do: `ncbi_client.py` (token bucket 3 req/s, 3 retries), `pdb_client.py` (entity classification), `file_ingest.py`, `watcher.py` (`PollingObserver` when `settings.watch_uses_polling`), `ws_events.py`.
Check:
```bash
curl -s -X POST localhost:8000/api/ingest/ncbi -H 'content-type: application/json' -d '{"accession":"NC_045512.2"}' | jq '.items[0].record | {length, organism}'
curl -s -X POST localhost:8000/api/ingest/pdb  -H 'content-type: application/json' -d '{"pdb_id":"1BNA"}'          | jq '.items[0].record.length'
# second NCBI call must return HIT_ACCESSION with no outbound request (watch server logs)
cp tests/fixtures/sample.fasta ~/helixsight_watch/ && sleep 3 && curl -s 'localhost:8000/api/history?limit=1' | jq '.items[0].source'   # "FILE"
```
`NC_045512.2` should report about 29.9 kb; `1BNA` is the 12-bp Dickerson dodecamer.

**B6 — Streaming engine without ML (P5.1–P5.3)**
Do: `streaming/framing.py` (doc 01 §7.3), `session.py`, `scheduler.py`, `ws_scan.py`; compute rows 0–6 via `compute_core_channels_async`; rows 7–12 stay NaN (`MODEL_UNAVAILABLE` path); persist with `repo.put_analysis`.
Check: a small Python WS client (`websockets`) completes `hello → start_scan → scan_ready → frames → scan_complete`; the second `start_scan` reports `cache: "HIT"`; `verify_integrity` all zero; the 14-kb DMD transcript reaches first frame < 150 ms on a cache hit.

**B7 — ML stack (P4.1–P4.5)** *(can run in parallel with B8 once B3 is done)*
Do, in order: `ml/models.py` + shape tests → dataset build → training → `anomaly.py` → `onnx_export.py` → `pathogenicity.py` (doc 03).
Free data (nothing committed; record terms in the MODEL_CARD before training):
```bash
mkdir -p ml_models/datasets/raw ml_models/datasets/processed && cd ml_models/datasets/raw
curl -O https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.fa.gz        # ~1 GB download, ~3.1 GB unpacked
gunzip hg38.fa.gz
GTF=$(curl -s https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/latest_release/ | grep -o 'gencode\.v[0-9]*\.annotation\.gtf\.gz' | head -1)
curl -O "https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/latest_release/$GTF"
cd ../../..
uv run python ml_models/training/build_dataset.py --fasta ml_models/datasets/raw/hg38.fa \
    --gtf ml_models/datasets/raw/$GTF --out ml_models/datasets/processed --chroms chr1 chr2 chr3 chr4 chr5 chr6 chr7 chr8 chr20 chr21 chr22
uv run python ml_models/training/train_cnn_bilstm.py
make export-onnx
```
(`read_chrom` in doc 03 re-parses the whole FASTA per chromosome; swap it for `Bio.SeqIO.index(fasta, "fasta")` before running all chromosomes.) Both files use `chr`-prefixed names (UCSC hg38 + GENCODE primary assembly), which is what `build_dataset.py` assumes. Disk: ~5 GB raw + ~3.3 GB processed for `chr1–8`.
Check: label-sanity (donor `GT`, acceptor `AG` > 95%); torch↔ORT parity < 1e-4; per-head AUPRC recorded in `MODEL_CARDS/hs-cnnbilstm-v1.md`; a smoke `train_cnn_bilstm.py` run with `steps=50, epochs=1` completes on CPU first.

**B8 — Wire ML into streaming + mutations (P5.4, P4.5)**
Do: `ScanSession` calls `predict_sequence`, `anomaly_scores/regions`, assembles all 13 rows, emits `anomaly_alert`; `mutate` handler uses `score_mutation` + `native.local_thermo` and `repo.add_mutation`; add `GET /api/history/{scan_id}/mutations` and `DELETE /api/mutations/{mutation_id}` (doc 04 D12).
Check: the synthetic 20-kb sequence with a 3-kb GC-shifted insert yields one `anomaly_alert` overlapping the insert; `mutation_result` for `alt==ref` has all deltas 0; mutating then reloading history restores the mutation.

**B9 — Frontend shell, persistence, ingestion UI (P6.1–P6.5)**
Do: `main.tsx`, `App.tsx`, `contracts/*`, `lib/canonicalize.ts` + `sha256.ts` (assert against `docs/golden_vectors.json` in a vitest test), `db/*` (idb), `store/*`, `components/ingestion/*`, `components/history/*` (doc 02 §2–4).
Check: `pnpm test` (golden vectors identical to Python); ingest all four lanes from the UI; history survives a browser reload and an offline reload (DevTools → Network → Offline); `perf.mark("open_history")` median < 5 ms in the vitest/Playwright benchmark.

**B10 — Visual engine & HUD (P7.1–P7.8)**
Do: `Engine` + single rAF loop, geometry table worker, canvas helix, brackets, inspector, tracks, CGR worker + radar, sonifier, optional Three.js view (doc 02 §4–8).
Check: unit tests from doc 02 §10 (geometry, groove widths 1.2/2.2 ± 0.01, ring geometry, FCGR == C++ k-mer matrix mapping); p95 frame time < 16.6 ms in Chrome DevTools Performance at 1080p.

**B11 — Offline & polish (P8.1–P8.4)**
Do: `onnx.worker.ts` (FP32), COOP/COEP in dev/preview (already in `vite.config.ts`), service-worker precache of `/models/*` and `/ort/*`, reduced-motion/a11y pass, memory profiling at 5 Mbp.
Check: with the backend stopped and a previously scanned sequence, History opens instantly; a never-scanned sequence shows ML-only channels with the reduced-telemetry notice; TS vs Python stitcher parity < 1e-4; Chrome heap < 700 MB at 5 Mbp.

**B12 — Release (P9.1–P9.4)**
Do: Playwright E2E for all four lanes + history reload + mutation + undo-delete (`pnpm exec playwright install --with-deps chromium`); single-process mode (`HS_SERVE_STATIC=1` with `IsolationHeaders`); `make license-audit`; complete MODEL_CARDS; tag `v0.1.0`.
Check: fresh clone → `make setup && make test && make dev` works on a clean WSL2 instance; all 10 constraints in `00` §3 ticked.

---

## 8. TROUBLESHOOTING

| Symptom | Cause | Fix |
|---|---|---|
| `uv sync` fails compiling `helixsight-core` | missing compiler/CMake | `sudo apt install build-essential cmake ninja-build`; re-run `uv sync --reinstall-package helixsight-core -v` for the CMake log |
| `Could not find pybind11` | build isolation disabled or pybind11 missing | keep `pybind11` in `cpp_core/pyproject.toml` `build-system.requires`; do not pass `--no-build-isolation` unless you installed it |
| `ImportError: helixsight_core ABI x != expected y` | stale wheel after changing `HS_CORE_ABI` | `make native` |
| `TypeError: incompatible function arguments` from a kernel | array dtype/contiguity (noconvert) | allocate with `native.alloc_planes` / `np.empty(..., dtype=...)`; slice rows (`planes[i]`), not columns |
| `ValueError: array is not writeable` | output array is a read-only view (e.g. `np.frombuffer`) | copy into a fresh `np.empty` |
| DuckDB `IO Error: Could not set lock` | a second process (CLI, notebook) opened the file | close it; one process owns `data/helixsight.duckdb` (doc 01 §9) |
| History shows no organism for old rows | `source_records.organism` null (paste/file lanes) | expected; only NCBI/PDB metadata carries it |
| Folder watcher never fires | repo or watch dir under `/mnt/c` | move `HS_WATCH_DIR` into the Linux FS; `/mnt/*` falls back to `PollingObserver` (2 s) automatically |
| `/ws/*` 404 in the browser | Vite proxy not applied (running `vite preview`) | use `pnpm dev`, or `HS_SERVE_STATIC=1` for the single-process mode |
| `SharedArrayBuffer is not defined` / ORT runs single-threaded | page is not cross-origin isolated | check response headers `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; hard-reload (service worker) |
| ONNX export fails on LSTM | exporter path changed between torch versions | use `dynamo=False` (as in doc 03 §10); on older torch omit the kwarg |
| `pnpm: command not found` after `nvm use` | Corepack not enabled for this Node | `corepack enable` once per Node install |
| Browser cannot reach `localhost:5173` from Windows | WSL localhost forwarding disabled | ensure `localhostForwarding=true` in `.wslconfig`, `wsl --shutdown`; fallback: `pnpm dev --host 0.0.0.0` and browse to the WSL IP (`hostname -I`) |
| Shell scripts fail with `\r` errors | CRLF from Windows editors | `.gitattributes` above; `dos2unix scripts/dev.sh` |
| NCBI `429` | > 3 req/s without a key | add the free `HS_NCBI_API_KEY`; the client's token bucket and `Retry-After` handling cap the rate |
| Out-of-memory at 5 Mbp | `.wslconfig` memory too low or DuckDB limit | raise `memory=` (host permitting) or lower `HS_MAX_SEQ_BP`; keep `HS_DUCKDB_MEMORY_LIMIT` ≤ 2GB |

---

## 9. ROADMAP BEYOND v0.1

| Item | Why | Notes |
|---|---|---|
| WASM port of thermo + k-mer core | full offline parity (today ML channels only offline) | reuse `hs_core` via Emscripten; keep golden vectors shared |
| Browser INT8 model | smaller/faster offline inference | only after an ORT-Web operator/parity spike (doc 03 §10) |
| Multi-entity PDB UI | pick among nucleic-acid entities | API already supports `entity_id` / `all_nucleic_acid` |
| Calibrated mutation scoring | replace uncalibrated weights | needs a held-out public variant set; new model card |
| Protein/RNA modes | broaden scope beyond DNA | separate alphabets and models; contract bump |
| Export/import of history (`.hsx` archive) | portability without any cloud | zip of DuckDB rows + chunks; local file only |

### 9.1 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Model trained on human DNA misleads on viral/bacterial input | persistent scope chip in the UI + `model_scope` in `scan_ready` (doc 03 §1) |
| NCBI/RCSB API changes | isolate in `ncbi_client.py`/`pdb_client.py`; recorded-response fixtures in tests |
| DuckDB single-writer limits | single writer executor; no second process; documented in troubleshooting |
| WASM/COOP-COEP deployment friction | dev/preview headers in `vite.config.ts`; `IsolationHeaders` for single-process mode |
| License drift in transitive dependencies | `make license-audit` in CI; manual weight-license review |
| Heuristic outputs read as diagnoses | C-9 labels on every pathogenicity/anomaly/Z surface |

---

## 10. INTERCONNECTION MATRIX (TOOLING & BUILD)

| Producer | Artifact | Consumer | Command |
|---|---|---|---|
| `cpp_core/*` | wheel `helixsight-core` | `backend` (`core_bridge/native.py`) | `uv sync` / `make native` |
| `cpp_core/*` | `hs_tests` binary | developer / CI | `make test-native` |
| `backend/migrations/*.sql` | `data/helixsight.duckdb` schema | `DuckStore.open()` | automatic at startup |
| `ml_models/training/*` | `checkpoints/*.pt` | `onnx_export.py` | `train_cnn_bilstm.py` |
| `onnx_export.py` | `ml_models/onnx/*.onnx`, `model.json` | `ml/registry.py`, `frontend/public/models/` | `make export-onnx` |
| `node_modules/onnxruntime-web` | `public/ort/*.wasm,*.mjs` | `onnx.worker.ts` | `predev`/`prebuild` script |
| `docs/golden_vectors.json` | shared test vectors | `sanitizer.py` tests and `canonicalize.ts` tests | pytest + vitest |
| `backend/schemas/*.py` | contracts | `frontend/src/contracts/*.ts` (diffed in CI, doc 00 P0.6) | `scripts/gen_ts_from_pydantic.py` (optional) |
| `.env` | `Settings` | backend | process start |
| `vite.config.ts` proxy | `/api`, `/ws` → `:8000` | browser | `make dev` |

---

## 11. FINAL TRACKER SNAPSHOT (replace `00` §8 headings with these step labels if you prefer build-order tracking)

```text
[ ] B0 toolchain & skeleton          [ ] B1 native core            [ ] B2 binding + wheel + bench
[ ] B3 DuckDB layer                   [ ] B4 sanitizer/paste/history [ ] B5 NCBI/PDB/file/watcher
[ ] B6 streaming (no ML)              [ ] B7 ML stack               [ ] B8 ML in streaming + mutations
[ ] B9 frontend shell + persistence   [ ] B10 visual engine + HUD   [ ] B11 offline + polish
[ ] B12 release (E2E, audit, tag v0.1.0)
```