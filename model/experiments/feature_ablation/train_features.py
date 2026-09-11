"""Experiment F: feature-set ablation on the frozen dv (k=5) target.

The ONLY independent variable is the input feature set. Architecture, seed, optimizer,
scheduler, early stopping, batch size, epochs, loss-comparison methodology, dataset, split,
windows and targets are all identical to the frozen dv experiment.

Feature sets are index subsets of the existing X_ext array - no new preprocessing, no new
features, no re-derivation of gravity/bias/rotation.

The test split is never opened in this file.
"""
import os, sys, json, time, argparse
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import TensorDataset, DataLoader

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'baseline'))
from train_baseline import MatrixBaseline, set_seed, SEED   # noqa: E402

DS = os.path.join(ROOT, 'preprocessing', 'training_dataset', 'core')
DVT = os.path.join(ROOT, 'experiments', 'delta_v', 'targets')
CKPT = os.path.join(HERE, 'checkpoints')
os.makedirs(CKPT, exist_ok=True)
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
EPOCHS, PATIENCE, BATCH, LR = 80, 12, 256, 1e-3
K = 5

EXT = json.load(open(os.path.join(ROOT, 'preprocessing', 'outputs',
                                  'feature_schema.json')))['ext_channel_order']
SETS = {
    'A_imu6':        [0, 1, 2, 3, 4, 5],
    'B_imu_linacc':  [0, 1, 2, 3, 4, 5, 6, 7, 8],
    'C_imu_mag':     [0, 1, 2, 3, 4, 5, 9, 10],
    'D_all11':       [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
}


def load(tag, sub, idx):
    X = np.load(os.path.join(DS, sub, f'X_ext_{tag}.npy'), mmap_mode='r')
    t = pd.read_parquet(os.path.join(DVT, f'dv_targets_{tag}.parquet'))
    m = t[f'dv{K}_valid'].to_numpy(bool)
    y = np.c_[t[f'dv{K}'].to_numpy(float), t['yaw_rate'].to_numpy(float)].astype(np.float32)
    return np.asarray(X[m])[:, :, idx].copy(), y[m]


def run(set_name, loss_name):
    idx = SETS[set_name]
    set_seed(SEED)
    Xtr, ytr = load('train', 'train', idx)
    Xva, yva = load('val', 'validation', idx)
    sc = json.load(open(os.path.join(DS, 'scaler', 'scaler.json')))
    fmu = np.array(sc['feature_mean'], np.float32)[idx]      # train-only scaler, subset
    fsd = np.array(sc['feature_std'], np.float32)[idx]
    tmu, tsd = ytr.mean(0), ytr.std(0)
    tsd = np.where(tsd < 1e-8, 1.0, tsd).astype(np.float32)
    Xtr = (Xtr - fmu) / fsd
    Xva = (Xva - fmu) / fsd

    tr = DataLoader(TensorDataset(torch.from_numpy(Xtr), torch.from_numpy((ytr - tmu) / tsd)),
                    batch_size=BATCH, shuffle=True,
                    generator=torch.Generator().manual_seed(SEED))
    va = DataLoader(TensorDataset(torch.from_numpy(Xva), torch.from_numpy((yva - tmu) / tsd)),
                    batch_size=512, shuffle=False)
    crit = {'mse': nn.MSELoss(), 'mae': nn.L1Loss(), 'huber': nn.HuberLoss(delta=1.0)}[loss_name]

    set_seed(SEED)
    model = MatrixBaseline(n_feat=len(idx)).to(DEVICE)
    npar = sum(p.numel() for p in model.parameters())
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    sch = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, 'min', factor=0.5, patience=4,
                                                     min_lr=1e-6)
    best, best_ep, bad, hist = np.inf, -1, 0, []
    name = f'{set_name}_{loss_name}'
    t0 = time.time()
    for ep in range(1, EPOCHS + 1):
        model.train(); tl = n = 0
        for xb, yb in tr:
            xb, yb = xb.to(DEVICE), yb.to(DEVICE)
            opt.zero_grad()
            l = crit(model(xb), yb); l.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()
            tl += l.item() * len(xb); n += len(xb)
        tl /= n
        model.eval(); vl = m = 0; P = []
        with torch.no_grad():
            for xb, yb in va:
                xb, yb = xb.to(DEVICE), yb.to(DEVICE)
                p = model(xb)
                vl += crit(p, yb).item() * len(xb); m += len(xb)
                P.append(p.cpu().numpy())
        vl /= m
        pred = np.concatenate(P) * tsd + tmu
        nrmse = float(np.mean([np.sqrt(np.mean((pred[:, i] - yva[:, i]) ** 2)) / tsd[i]
                               for i in range(2)]))
        r2 = [float(1 - np.sum((pred[:, i] - yva[:, i]) ** 2)
                    / np.sum((yva[:, i] - yva[:, i].mean()) ** 2)) for i in range(2)]
        sch.step(vl)
        hist.append(dict(feature_set=set_name, loss_fn=loss_name, epoch=ep,
                         train_loss=round(tl, 6), val_loss=round(vl, 6),
                         val_nrmse=round(nrmse, 6), val_r2_dv=round(r2[0], 5),
                         val_r2_yaw=round(r2[1], 5), lr=opt.param_groups[0]['lr']))
        if vl < best - 1e-5:
            best, best_ep, bad = vl, ep, 0
            torch.save({'model': model.state_dict(), 'epoch': ep, 'val_loss': vl,
                        'val_nrmse': nrmse, 'val_r2_dv': r2[0], 'val_r2_yaw': r2[1],
                        'feature_set': set_name, 'feature_idx': idx,
                        'feature_names': [EXT[i] for i in idx],
                        'loss_fn': loss_name, 'seed': SEED, 'n_params': npar,
                        'target_mean': tmu, 'target_std': tsd},
                       os.path.join(CKPT, f'best_{name}.pt'))
            bn, br2 = nrmse, r2
        else:
            bad += 1
        if bad >= PATIENCE:
            break
    print(f'  [{name}] nfeat={len(idx)} params={npar} best ep {best_ep}/{ep} '
          f'val_loss {best:.5f} nRMSE {bn:.5f} R2_dv {br2[0]:.4f} R2_yaw {br2[1]:.4f} '
          f'({(time.time()-t0)/60:.1f} min)', flush=True)
    return hist, dict(feature_set=set_name, n_features=len(idx), loss_fn=loss_name,
                      best_epoch=best_ep, epochs_run=ep, best_val_loss=round(best, 6),
                      best_val_nrmse=round(bn, 6), val_r2_dv=round(br2[0], 5),
                      val_r2_yaw=round(br2[1], 5), n_params=npar)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', default='loss', choices=['loss', 'ablation'])
    ap.add_argument('--loss', default='huber')
    a = ap.parse_args()
    H, S = [], []
    if a.stage == 'loss':
        print('Stage 1: loss comparison for the 11-feature set (validation only)')
        for ln in ['mse', 'mae', 'huber']:
            h, s = run('D_all11', ln); H += h; S.append(s)
        best = min(S, key=lambda d: d['best_val_nrmse'])
        json.dump({'runs': S, 'selected_loss': best['loss_fn'],
                   'selection_metric': 'validation mean normalised RMSE',
                   'test_used_for_selection': False},
                  open(os.path.join(HERE, 'loss_comparison.json'), 'w'), indent=2)
        pd.DataFrame(H).to_csv(os.path.join(HERE, 'history_loss.csv'), index=False)
        print('selected loss:', best['loss_fn'])
    else:
        print(f'Stage 2: feature-group ablation with loss={a.loss} (validation only)')
        for s in ['A_imu6', 'B_imu_linacc', 'C_imu_mag', 'D_all11']:
            h, r = run(s, a.loss); H += h; S.append(r)
        pd.DataFrame(H).to_csv(os.path.join(HERE, 'history_ablation.csv'), index=False)
        json.dump(S, open(os.path.join(HERE, 'ablation_comparison.json'), 'w'), indent=2)
