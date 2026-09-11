"""MATRIX Phase 1 baseline: Conv1D -> Conv1D -> GRU -> Dense -> 2 outputs.

Trains one model per candidate loss (MSE / MAE / Huber), selects on VALIDATION only.
The test split is not read anywhere in this file.

Inputs : X (N, 50, 6) = acc_xyz + gyro_xyz, bias-corrected, raw (unscaled) on disk.
Targets: y (N, 2)     = target_v_forward (m/s), target_yaw_rate (rad/s).
Scaling: train-only scaler from the dataset build; targets are standardised too, so the
         loss is not dominated by v_forward (std 6.4) over yaw_rate (std 0.13).
"""
import os, json, time, random
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import TensorDataset, DataLoader

HERE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(HERE, '..', 'preprocessing', 'training_dataset', 'core')
CKPT = os.path.join(HERE, 'checkpoints')
os.makedirs(CKPT, exist_ok=True)

SEED = 1337
EPOCHS = 80
PATIENCE = 12
BATCH = 256
LR = 1e-3
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'


def set_seed(s):
    random.seed(s); np.random.seed(s)
    torch.manual_seed(s); torch.cuda.manual_seed_all(s)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False


class MatrixBaseline(nn.Module):
    """Deliberately small: 2 temporal conv layers -> 1 GRU -> 2 dense."""

    def __init__(self, n_feat=6, c1=64, c2=128, hidden=128, fc=64, k=5, p_drop=0.2):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv1d(n_feat, c1, kernel_size=k, padding=k // 2),
            nn.BatchNorm1d(c1), nn.ReLU(), nn.Dropout(p_drop),
            nn.Conv1d(c1, c2, kernel_size=k, padding=k // 2),
            nn.BatchNorm1d(c2), nn.ReLU(), nn.Dropout(p_drop))
        self.gru = nn.GRU(c2, hidden, num_layers=1, batch_first=True)
        self.head = nn.Sequential(
            nn.Linear(hidden, fc), nn.ReLU(), nn.Dropout(p_drop), nn.Linear(fc, 2))

    def forward(self, x):                 # x: (B, T, F)
        h = self.conv(x.transpose(1, 2))  # (B, C2, T)
        out, _ = self.gru(h.transpose(1, 2))
        return self.head(out[:, -1])      # last timestep -> causal target at t


def load_split(tag, sub):
    X = np.load(os.path.join(DS, sub, f'X_{tag}.npy'))
    y = np.load(os.path.join(DS, sub, f'y_{tag}.npy'))
    return X, y


def main():
    set_seed(SEED)
    sc = json.load(open(os.path.join(DS, 'scaler', 'scaler.json')))
    fmu = np.array(sc['feature_mean'][:6], dtype=np.float32)
    fsd = np.array(sc['feature_std'][:6], dtype=np.float32)
    tmu = np.array(sc['target_mean'], dtype=np.float32)
    tsd = np.array(sc['target_std'], dtype=np.float32)

    Xtr, ytr = load_split('train', 'train')
    Xva, yva = load_split('val', 'validation')
    print(f'train {Xtr.shape} {ytr.shape} | val {Xva.shape} {yva.shape} | device {DEVICE}')

    Xtr = (Xtr - fmu) / fsd
    Xva = (Xva - fmu) / fsd
    ytr_s = (ytr - tmu) / tsd
    yva_s = (yva - tmu) / tsd

    tr = DataLoader(TensorDataset(torch.from_numpy(Xtr), torch.from_numpy(ytr_s)),
                    batch_size=BATCH, shuffle=True, drop_last=False,
                    generator=torch.Generator().manual_seed(SEED))
    va = DataLoader(TensorDataset(torch.from_numpy(Xva), torch.from_numpy(yva_s)),
                    batch_size=512, shuffle=False)

    losses = {'mse': nn.MSELoss(), 'mae': nn.L1Loss(), 'huber': nn.HuberLoss(delta=1.0)}
    history, summary = [], {}

    for name, crit in losses.items():
        set_seed(SEED)                      # identical init for a fair comparison
        model = MatrixBaseline().to(DEVICE)
        nparam = sum(p.numel() for p in model.parameters())
        opt = torch.optim.Adam(model.parameters(), lr=LR)
        sched = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, 'min', factor=0.5,
                                                           patience=4, min_lr=1e-6)
        best, best_ep, bad = np.inf, -1, 0
        t0 = time.time()
        for ep in range(1, EPOCHS + 1):
            model.train(); tl = n = 0
            for xb, yb in tr:
                xb, yb = xb.to(DEVICE), yb.to(DEVICE)
                opt.zero_grad()
                loss = crit(model(xb), yb)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 5.0)
                opt.step()
                tl += loss.item() * len(xb); n += len(xb)
            tl /= n

            model.eval(); vl = m = 0; P = []
            with torch.no_grad():
                for xb, yb in va:
                    xb, yb = xb.to(DEVICE), yb.to(DEVICE)
                    p = model(xb)
                    vl += crit(p, yb).item() * len(xb); m += len(xb)
                    P.append(p.cpu().numpy())
            vl /= m
            pred = np.concatenate(P) * tsd + tmu          # back to physical units
            # loss-independent selection metric: mean normalised RMSE over both targets
            nrmse = float(np.mean([
                np.sqrt(np.mean((pred[:, i] - yva[:, i]) ** 2)) / tsd[i] for i in range(2)]))
            sched.step(vl)
            history.append(dict(loss_fn=name, epoch=ep, train_loss=round(tl, 6),
                                val_loss=round(vl, 6), val_nrmse=round(nrmse, 6),
                                lr=opt.param_groups[0]['lr']))
            if vl < best - 1e-5:
                best, best_ep, bad = vl, ep, 0
                torch.save({'model': model.state_dict(), 'epoch': ep, 'val_loss': vl,
                            'val_nrmse': nrmse, 'loss_fn': name, 'seed': SEED,
                            'n_params': nparam},
                           os.path.join(CKPT, f'best_{name}.pt'))
                best_nrmse = nrmse
            else:
                bad += 1
            if ep % 5 == 0 or ep == 1:
                print(f'  [{name}] ep{ep:3d} train {tl:.5f} val {vl:.5f} nrmse {nrmse:.5f}',
                      flush=True)
            if bad >= PATIENCE:
                print(f'  [{name}] early stop at epoch {ep} (best {best_ep})')
                break
        summary[name] = dict(best_epoch=best_ep, best_val_loss=round(best, 6),
                             best_val_nrmse=round(best_nrmse, 6), epochs_run=ep,
                             n_params=nparam, minutes=round((time.time() - t0) / 60, 2))
        print(f'  [{name}] best ep {best_ep} val_loss {best:.5f} val_nRMSE {best_nrmse:.5f}')

    pd.DataFrame(history).to_csv(os.path.join(HERE, 'training_history.csv'), index=False)
    winner = min(summary, key=lambda k: summary[k]['best_val_nrmse'])
    summary['selected'] = winner
    summary['selection_metric'] = ('mean normalised RMSE on the VALIDATION split '
                                   '(loss-independent, so the three losses are comparable)')
    summary['test_used_for_selection'] = False
    json.dump(summary, open(os.path.join(HERE, 'loss_comparison.json'), 'w'), indent=2)
    print('\nselected loss:', winner, json.dumps(summary[winner]))


if __name__ == '__main__':
    main()
