import json
import torch
from pathlib import Path
from .models import HelixSightNet, ExportWrapper

def export():
    out_dir = Path("ml_models/onnx")
    out_dir.mkdir(parents=True, exist_ok=True)
    
    net = ExportWrapper(HelixSightNet()).eval()
    dummy_input = torch.zeros(1, 4, 1024)
    onnx_path = out_dir / "hs-cnnbilstm-v1.fp32.onnx"
    
    print("Exporting PyTorch model to ONNX...")
    torch.onnx.export(
        net, dummy_input, str(onnx_path),
        input_names=["onehot"], output_names=["probs", "attn"],
        dynamic_axes={
            "onehot": {0: "batch", 2: "length"},
            "probs": {0: "batch", 2: "length"},
            "attn": {0: "batch", 1: "length"}
        }
    )
    
    meta = {
        "model_id": "hs-cnnbilstm-v1",
        "weights_sha256": "dev-stub-weights",
        "artifacts": {"onnx_fp32": "hs-cnnbilstm-v1.fp32.onnx", "pt": "model.pt"},
        "scope": {"trained_on": "Synthetic Test Data", "warning": "Untrained stub network for development"}
    }
    (out_dir / "model.json").write_text(json.dumps(meta, indent=2))
    print(f"Export complete: {onnx_path}")

if __name__ == "__main__":
    export()
