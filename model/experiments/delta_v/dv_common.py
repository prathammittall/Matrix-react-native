"""Shared dense-prediction and anchored dead-reckoning utilities for the delta-v experiment."""
import os, sys, json
import numpy as np
import pandas as pd
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'baseline'))
from train_baseline import MatrixBaseline, DEVICE   # noqa: E402

PRE = os.path.join(HERE, '..', '..', 'preprocessing')
DS = os.path.join(PRE, 'training_dataset', 'core')
CORE = os.path.join(PRE, 'smartphone_core')
TGT = os.path.join(PRE, 'targets')
W, DT = 50, 0.1
FEATS = ['acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z']
MAX_ACC = 15.0

_sc = json.load(open(os.path.join(DS, 'scaler', 'scaler.json')))
FMU = np.array(_sc['feature_mean'][:6], np.float32)
FSD = np.array(_sc['feature_std'][:6], np.float32)
_cal = pd.read_csv(os.path.join(PRE, 'outputs', 'calibration_bias.csv')).set_index('dataset_id')


def session_frame(ds, sess):
    S = pd.read_parquet(os.path.join(CORE, f'{ds}.parquet'))
    S = S[S.session_id == sess].sort_values(['timestamp_s', 'row_index_original'])
    T = pd.read_parquet(os.path.join(TGT, f'{sess}.parquet'))
    S = S.merge(T[['row_index_original', 'target_v_forward', 'target_yaw_rate',
                   'target_valid', 'target_source', 'target_confidence']],
                on='row_index_original', how='left')
    if ds in _cal.index and pd.notna(_cal.loc[ds].get('gyro_bias_x', np.nan)):
        r = _cal.loc[ds]
        gb = np.nan_to_num(np.array([float(r[f'gyro_bias_{a}']) for a in 'xyz']))
        ab = np.nan_to_num(np.array([float(r[f'acc_bias_{a}']) for a in 'xyz']))
    else:
        gb = ab = np.zeros(3)
    for i, a in enumerate('xyz'):
        S[f'acc_{a}'] = S[f'acc_{a}'].to_numpy(float) - ab[i]
        S[f'gyro_{a}'] = S[f'gyro_{a}'].to_numpy(float) - gb[i]
    return S


def dense(S):
    F = S[FEATS].to_numpy(np.float32)
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
def predict(model, X, tmu, tsd, bs=2048):
    P = []
    for i in range(0, len(X), bs):
        xb = torch.from_numpy(((X[i:i + bs] - FMU) / FSD).astype(np.float32)).to(DEVICE)
        P.append(model(xb).cpu().numpy())
    return np.concatenate(P) * tsd + tmu


def load_ckpt(path):
    ck = torch.load(path, map_location=DEVICE, weights_only=False)
    m = MatrixBaseline().to(DEVICE)
    m.load_state_dict(ck['model'])
    m.eval()
    return m, ck


def reconstruct_velocity(dv_pred, k, v0, method='accel', clip=None):
    """Rebuild absolute velocity from dv_k predictions given a ground-truth anchor v0.

    'accel'  : treat dv_k/(k*dt) as a backward-averaged acceleration and integrate every
               step. Uses every prediction; introduces a k/2 lag.
    'stride' : apply v[t] = v[t-k] + dv_k[t] on a stride-k lattice and linearly
               interpolate between lattice points. Uses each dv exactly once.
    clip     : optional (lo, hi) bound on dv, derived from the TRAIN distribution only.
    """
    d = dv_pred.copy()
    if clip is not None:
        d = np.clip(d, clip[0], clip[1])
    n = len(d)
    if method == 'accel':
        a = d / (k * DT)
        a = np.clip(a, -MAX_ACC, MAX_ACC)
        v = v0 + np.cumsum(a * DT)
    else:
        v = np.full(n, np.nan)
        lat = np.arange(0, n, k)
        cur = v0
        v[0] = v0
        for j in range(1, len(lat)):
            cur = cur + d[lat[j]]
            v[lat[j]] = cur
        idx = lat[~np.isnan(v[lat])]
        v = np.interp(np.arange(n), idx, v[idx])
    return np.maximum(v, 0.0)          # a forward speed cannot be negative


def dead_reckon(v, yaw, dt=DT):
    h = np.cumsum(yaw * dt)
    hm = np.concatenate([[0.0], h[:-1]]) + yaw * dt / 2.0
    return np.cumsum(v * np.cos(hm) * dt), np.cumsum(v * np.sin(hm) * dt), h
