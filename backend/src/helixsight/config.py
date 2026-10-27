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
    watch_enabled: bool = True
    ncbi_tool: str = "helixsight"
    ncbi_email: str = ""
    ncbi_api_key: str = ""
    runner: Literal["ort", "torch"] = "ort"
    model_dir: Path = Path("ml_models/onnx")
    ort_threads: int = 1
    core_executor_threads: int = 2
    cache_codec: Literal["raw", "zstd"] = "raw"
    max_seq_bp: int = 5_000_000
    max_upload_mb: int = 50
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
        return str(self.watch_dir.resolve()).startswith("/mnt/")
