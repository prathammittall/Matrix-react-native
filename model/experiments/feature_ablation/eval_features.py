"""Experiment F evaluation: dead reckoning for every feature set, on VALIDATION,
then a single frozen TEST run.

Fusion uses the FROZEN Experiment-E filter: complementary, tau = 20 s, k = 5, dt = 0.1.
Tau is NOT retuned, so the only thing that changes is the dv model's input feature set.
The absolute-v side always comes from the frozen 6-feature baseline model.
"""
import os, sys, json, argparse
import numpy as np
import pandas as pd
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'baseline'))
sys.path.insert(0, os.path.join(ROOT, 'experiments', 'delta_v'))
sys.path.insert(0, os.path.join(ROOT, 'experiments', 'complementary_fusion'))
from train_baseline import MatrixBaseline, DEVICE                      # noqa: E402
from dv_common import session_frame, FEATS, W, DT                      # noqa: E402
from phase2_4_fusion_select import (dead_reckon, v_delta_stride,       # noqa: E402
                                    v_abs_anchored, complementary)

DS = os.path.join(ROOT, 'preprocessing', 'training_dataset', 'core')
FUSE_DENSE = os.path.join(ROOT, 'experiments', 'complementary_fusion', 'predictions', 'dense')
CKPT = os.path.join(HERE, 'checkpoints')
K, TAU = 5, 20.0                       # frozen from Experiment E
OUTAGES = [10, 30, 60, 120, 300]
STEP_S = 30
EXT = json.load(open(os.path.join(ROOT, 'preprocessing', 'outputs',
                                  'feature_schema.json')))['ext_channel_order']
SC = json.load(open(os.path.join(DS, 'scaler', 'scaler.json')))
FMU_ALL = np.array(SC['feature_mean'], np.float32)
FSD_ALL = np.array(SC['feature_std'], np.float32)
SETS = ['A_imu6', 'B_imu_linacc', 'C_imu_mag', 'D_all11']


def ext_features(S):
    """Rebuild the 11 X_ext channels for a session, exactly as preprocessing defined them.
    No re-derivation: acc/gyro already bias-corrected, linear_acc already gravity-removed."""
    a = S[['acc_x', 'acc_y', 'acc_z']].to_numpy(float)
    g = S[['gyro_x', 'gyro_y', 'gyro_z']].to_numpy(float)
    grav = S[['gravity_x', 'gravity_y', 'gravity_z']].to_numpy(float)
    # acc here is ALREADY bias-corrected by session_frame, and gravity is untouched, so
    # linear_acc_corrected = acc_corrected - gravity. This reproduces X_ext exactly;
    # gravity subtraction and bias correction are NOT applied a second time.
    lin = a - grav
    return np.c_[a, g, lin, np.linalg.norm(a, axis=1), np.linalg.norm(g, axis=1)].astype(np.float32)


def dense_ext(S):
    F = ext_features(S)
    ends = np.arange(W - 1, len(F))
    X = F[ends[:, None] + np.arange(-W + 1, 1)[None, :]]
    t = S.timestamp_s.to_numpy(float)
    span = t[ends] - t[ends - W + 1]
    tv = S.target_valid.fillna(False).to_numpy(bool)
    conf = S.target_confidence.fillna('none').to_numpy()
    ok = (tv[ends] & (conf[ends] == 'high')
          & np.isfinite(X).reshape(len(X), -1).all(1)
          & (np.abs(span - (W - 1) * DT) < 0.1 * (W - 1) * DT))
    return X, ends, ok


@torch.no_grad()
def predict(model, X, idx, tmu, tsd, bs=2048):
    mu, sd = FMU_ALL[idx], FSD_ALL[idx]
    P = []
    for i in range(0, len(X), bs):
        xb = torch.from_numpy(((X[i:i + bs][:, :, idx] - mu) / sd).astype(np.float32)).to(DEVICE)
        P.append(model(xb).cpu().numpy())
    return np.concatenate(P) * tsd + tmu


def load(setname):
    ck = torch.load(os.path.join(CKPT, f'best_{setname}_huber.pt'),
                    map_location=DEVICE, weights_only=False)
    m = MatrixBaseline(n_feat=len(ck['feature_idx'])).to(DEVICE)
    m.load_state_dict(ck['model']); m.eval()
    return m, ck


def run(split):
    man = pd.read_csv(os.path.join(DS, 'split_manifest.csv'))
    sess = man[man.split == split][['session_id', 'dataset_id']].values.tolist()
    models = {s: load(s) for s in SETS}
    rows, yawrows = [], []
    for sid, dsid in sess:
        S = session_frame(dsid, sid)
        X, ends, ok = dense_ext(S)
        fd = pd.read_parquet(os.path.join(FUSE_DENSE, split, f'{sid}.parquet'))
        n = min(len(ends), len(fd))
        vt = S.target_v_forward.to_numpy(float)[ends][:n]
        wt = S.target_yaw_rate.to_numpy(float)[ends][:n]
        va = fd.v_abs_pred.to_numpy(float)[:n]
        ok = ok[:n] & fd.ok.to_numpy()[:n]
        preds = {}
        for s in SETS:
            m, ck = models[s]
            P = predict(m, X, ck['feature_idx'], ck['target_mean'], ck['target_std'])[:n]
            preds[s] = P
            e = P[ok, 1] - wt[ok]
            ss = np.sum((wt[ok] - wt[ok].mean()) ** 2)
            yawrows.append(dict(split=split, feature_set=s, session=sid,
                                yaw_MAE=float(np.mean(np.abs(e))),
                                yaw_RMSE=float(np.sqrt(np.mean(e ** 2))),
                                yaw_R2=float(1 - np.sum(e ** 2) / ss),
                                yaw_bias=float(e.mean()), n=int(ok.sum())))
        for T in OUTAGES:
            L = int(T / DT)
            for s0 in range(0, n - L, int(STEP_S / DT)):
                sl = slice(s0, s0 + L)
                if not ok[sl].all():
                    continue
                v0 = vt[s0]
                gx, gy, gh = dead_reckon(vt[sl], wt[sl])
                vaa = v_abs_anchored(va[sl], v0)
                for s in SETS:
                    dv, wp = preds[s][sl, 0], preds[s][sl, 1]
                    vds = v_delta_stride(dv, v0)
                    vf = complementary(dv, vaa, v0, TAU)
                    for mode, vv in [('deltav', vds), ('fused_tau20', vf)]:
                        x, y, h = dead_reckon(vv, wp)
                        e = np.hypot(x - gx, y - gy)
                        rows.append(dict(split=split, feature_set=s, mode=mode, session=sid,
                                         outage_s=T, start=s0, final_err=float(e[-1]),
                                         traj_rmse=float(np.sqrt(np.mean(e ** 2))),
                                         mean_err=float(e.mean()),
                                         heading_err_deg=float(np.degrees(np.arctan2(
                                             np.sin(h[-1] - gh[-1]), np.cos(h[-1] - gh[-1])))),
                                         drift_per_min=float(e[-1] / (T / 60.0)),
                                         vel_rmse=float(np.sqrt(np.mean((vv - vt[sl]) ** 2)))))
        print(f'  {split} {sid} done', flush=True)
    return pd.DataFrame(rows), pd.DataFrame(yawrows)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--split', default='validation', choices=['validation', 'test'])
    a = ap.parse_args()
    out = os.path.join(HERE, f'{a.split}_results'); os.makedirs(out, exist_ok=True)
    R, Y = run(a.split)
    R.to_csv(os.path.join(out, f'dr_{a.split}.csv'), index=False)
    Y.to_csv(os.path.join(out, f'yaw_{a.split}.csv'), index=False)
    pd.set_option('display.width', 260)
    for mode in ['deltav', 'fused_tau20']:
        p = R[R['mode'] == mode].pivot_table(index='feature_set', columns='outage_s',
                                             values='final_err', aggfunc='median').round(2)
        print(f'\n=== {a.split}: median final position error (m) — {mode} ===')
        print(p.to_string())
        print('  % vs A_imu6:')
        print(((p.div(p.loc['A_imu6'], axis=1) - 1) * 100).round(1).to_string())
    print(f'\n=== {a.split}: median velocity RMSE (m/s) — fused ===')
    print(R[R['mode'] == 'fused_tau20'].pivot_table(index='feature_set', columns='outage_s',
          values='vel_rmse', aggfunc='median').round(3).to_string())
    print(f'\n=== {a.split}: yaw metrics (weighted by session n) ===')
    g = Y.groupby('feature_set').apply(
        lambda d: pd.Series({'MAE': np.average(d.yaw_MAE, weights=d.n),
                             'RMSE': np.average(d.yaw_RMSE, weights=d.n),
                             'R2': np.average(d.yaw_R2, weights=d.n),
                             'bias': np.average(d.yaw_bias, weights=d.n)}), include_groups=False)
    print(g.round(5).to_string())
