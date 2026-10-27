from __future__ import annotations
import hashlib
import json
from ..core_bridge.native import CoreParams
from ..ml.registry import ModelBundle

ANOMALY = {"kind": "isolation_forest", "n_estimators": 200, "seed": 42, "z_alert": 3.5, "min_run": 3}

def canonical_json(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))

def build_params(core: CoreParams, bundle: ModelBundle) -> tuple[dict, str]:
    params = {**core.as_dict(), "win_ml": 1024, "stride_ml": 512, "runner": bundle.runner_name,
              "anomaly": {**ANOMALY, "window": core.kmer_window, "stride": core.kmer_stride},
              "mask_ambiguity": True, "channel_registry_version": 1}
    return params, hashlib.sha256(canonical_json(params).encode()).hexdigest()
