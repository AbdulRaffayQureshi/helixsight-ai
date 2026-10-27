from __future__ import annotations
import json
import logging
from dataclasses import dataclass
from typing import Optional
from ..config import Settings

log = logging.getLogger("helixsight.ml")

@dataclass(frozen=True)
class ModelBundle:
    runner: Optional[Any]
    model_version: str = "none"
    runner_name: str = "none"
    scope: Optional[dict] = None

def load_bundle(settings: Settings) -> ModelBundle:
    meta_path = settings.model_dir / "model.json"
    if not meta_path.exists():
        log.warning("no model.json in %s: ML channels disabled", settings.model_dir)
        return ModelBundle(None)
    # Full loader logic will go here in Step B7
    return ModelBundle(None)
