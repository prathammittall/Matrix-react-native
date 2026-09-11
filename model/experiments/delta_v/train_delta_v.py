"""Delta-v experiment training. Same architecture, split, seed and methodology as the
baseline; only the first target changes from absolute v to dv_k.

output 1 = dv_k (m/s over k*0.1 s)     output 2 = yaw_rate (rad/s)

The test split is never opened in this file.
"""
import os, sys, json, time, argparse
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import TensorDataset, DataLoader

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'baseline'))
from train_baseline import MatrixBaseline, set_seed, SEED   # noqa: E402

PRE = os.path.join(HERE, '..', '..', 'preprocessing')
DS = os.path.join(PRE, 'training_dataset', 'core')
CKPT = os.path.join(HERE, 'checkpoints')
os.makedirs(CKPT, exist_ok=True)
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
EPOCHS, PATIENCE, BATCH, LR = 80, 12, 256, 1e-3


def load(tag, sub, k):
    X = np.load(os.path.join(DS, sub, f'X_{tag}.npy'))
    t = pd.read_parquet(os.path.join(HERE, 'targets', f'dv_targets_{tag}.parquet'))
    m = t[f'dv{k}_valid'].to_numpy(bool)
    y = np.c_[t[f'dv{k}'].to_numpy(float), t['yaw_rate'].to_numpy(float)].astype(np.float32)
    return X[m], y[m], t[m].reset_index(drop=True)


def run(k, loss_name, tag_suffix=''):
    set_seed(SEED)
    Xtr, ytr, _ = load('train', 'train', k)
    Xva, yva, _ = load('val', 'validation', k)

    sc = json.load(open(os.path.join(DS, 'scaler', 'scaler.json')))
    fmu = np.array(sc['feature_mean'][:6], np.float32)
    fsd = np.array(sc['feature_std'][:6], np.float32)
    # dv scaler is fitted fresh on TRAIN only (the baseline scaler is for absolute v)
    tmu = ytr.mean(0)
    tsd = ytr.std(0)
    tsd = np.where(tsd < 1e-8, 1.0, tsd).astype(np.float32)
    Xtr = (Xtr - fmu) / fsd
    Xva = (Xva - fmu) / fsd

    tr = DataLoader(TensorDataset(torch.from_numpy(Xtr), torch.from_numpy((ytr - tmu) / tsd)),
                    batch_size=BATCH, shuffle=True,
                    generator=torch.Generator().manual_seed(SEED))
    va = DataLoader(TensorDataset(torch.from_numpy(Xva), torch.from_numpy((yva - tmu) / tsd)),
                    batch_size=512, shuffle=False)
    crit = {'mse': nn.MSELoss(), 'mae': nn.L1Loss(),
            'huber': nn.HuberLoss(delta=1.0)}[loss_name]

    set_seed(SEED)
    model = MatrixBaseline().to(DEVICE)
    nparam = sum(p.numel() for p in model.parameters())
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    sch = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, 'min', factor=0.5, patience=4,
                                                     min_lr=1e-6)
    best, best_ep, bad, hist = np.inf, -1, 0, []
    name = f'k{k}_{loss_name}{tag_suffix}'
    t0 = time.time()
    for ep in range(1, EPOCHS + 1):
        model.train(); tl = n = 0
        for xb, yb in tr:
            xb, yb = xb.to(DEVICE), yb.to(DEVICE)
            opt.zero_grad()
            l = crit(model(xb), yb)
            l.backward()
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
        hist.append(dict(k=k, loss_fn=loss_name, epoch=ep, train_loss=round(tl, 6),
                         val_loss=round(vl, 6), val_nrmse=round(nrmse, 6),
                         val_r2_dv=round(r2[0], 5), val_r2_yaw=round(r2[1], 5),
                         lr=opt.param_groups[0]['lr']))
        if vl < best - 1e-5:
            best, best_ep, bad = vl, ep, 0
            torch.save({'model': model.state_dict(), 'epoch': ep, 'val_loss': vl,
                        'val_nrmse': nrmse, 'val_r2_dv': r2[0], 'val_r2_yaw': r2[1],
                        'k': k, 'loss_fn': loss_name, 'seed': SEED, 'n_params': nparam,
                        'target_mean': tmu, 'target_std': tsd},
                       os.path.join(CKPT, f'best_{name}.pt'))
            bn, br2 = nrmse, r2
        else:
            bad += 1
        if bad >= PATIENCE:
            break
    print(f'  [{name}] best ep {best_ep}/{ep} val_loss {best:.5f} nRMSE {bn:.5f} '
          f'R2_dv {br2[0]:.4f} R2_yaw {br2[1]:.4f} ({(time.time()-t0)/60:.1f} min)', flush=True)
    return hist, dict(k=k, loss_fn=loss_name, best_epoch=best_ep, epochs_run=ep,
                      best_val_loss=round(best, 6), best_val_nrmse=round(bn, 6),
                      val_r2_dv=round(br2[0], 5), val_r2_yaw=round(br2[1], 5),
                      n_params=nparam)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--stage', default='formulation', choices=['formulation', 'loss'])
    ap.add_argument('--k', type=int, default=5)
    a = ap.parse_args()
    H, S = [], []
    if a.stage == 'formulation':
        print('Stage 1: horizon comparison (Huber, validation only)')
        for k in [1, 5, 10]:
            h, s = run(k, 'huber')
            H += h; S.append(s)
        pd.DataFrame(H).to_csv(os.path.join(HERE, 'history_formulation.csv'), index=False)
        json.dump(S, open(os.path.join(HERE, 'formulation_comparison.json'), 'w'), indent=2)
    else:
        print(f'Stage 2: loss comparison at k={a.k} (validation only)')
        for ln in ['mse', 'mae', 'huber']:
            h, s = run(a.k, ln)
            H += h; S.append(s)
        pd.DataFrame(H).to_csv(os.path.join(HERE, 'training_history.csv'), index=False)
        best = min(S, key=lambda d: d['best_val_nrmse'])
        json.dump({'runs': S, 'selected_loss': best['loss_fn'], 'k': a.k,
                   'selection_metric': 'validation mean normalised RMSE',
                   'test_used_for_selection': False},
                  open(os.path.join(HERE, 'loss_comparison.json'), 'w'), indent=2)
        print('selected loss:', best['loss_fn'])
