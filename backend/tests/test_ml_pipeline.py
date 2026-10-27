import torch
from helixsight.ml.models import HelixSightNet, ExportWrapper

def test_model_shapes():
    net = ExportWrapper(HelixSightNet()).eval()
    # Batch=2, Channels=4, Length=1024
    x = torch.zeros(2, 4, 1024)
    with torch.no_grad():
        p, a = net(x)
    
    assert p.shape == (2, 4, 1024)
    assert a.shape == (2, 1024)
