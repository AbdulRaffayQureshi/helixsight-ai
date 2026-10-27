import torch
import torch.nn as nn

class HelixSightNet(nn.Module):
    def __init__(self):
        super().__init__()
        # 1D Convolution over the 4 DNA channels (A, C, G, T)
        self.cnn = nn.Conv1d(4, 32, kernel_size=7, padding=3)
        # Bidirectional LSTM for sequence context
        self.lstm = nn.LSTM(32, 32, batch_first=True, bidirectional=True)
        # Pointwise convolutions to map back to target channels
        self.probs = nn.Conv1d(64, 4, kernel_size=1)
        self.attn = nn.Conv1d(64, 1, kernel_size=1)

    def forward(self, x):
        # x shape: (Batch, 4, Length)
        c = torch.relu(self.cnn(x))
        c_t = c.transpose(1, 2)  # (Batch, Length, Channels)
        l_out, _ = self.lstm(c_t)
        l_out = l_out.transpose(1, 2)  # (Batch, 64, Length)
        
        p = torch.sigmoid(self.probs(l_out))            # 4 channels: Promoter, CpG, Donor, Acceptor
        a = torch.sigmoid(self.attn(l_out)).squeeze(1)  # 1 channel: Attention
        return p, a

class ExportWrapper(nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net
    def forward(self, onehot):
        return self.net(onehot)
