"""Pass 12: build the ML-ready MATRIX dataset (no training).

Causal windows IMU[t-W+1 : t] -> target at t, built per session so no window ever
crosses a session boundary or a split boundary. Bias correction is applied here for the
first time. Gravity is NOT re-subtracted. No rotation is applied. GPS is never an input.

Outputs training_dataset/core/{train,validation,test,scaler,metadata} + reports.
"""
import os, json, hashlib
import numpy as np
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'outputs')
CORE = os.path.join(BASE, 'smartphone_core')
TGT = os.path.join(BASE, 'targets')
DS = os.path.join(BASE, 'training_dataset')
CDIR = os.path.join(DS, 'core')
RDIR = os.path.join(DS, 'reports')
for d in [CDIR, RDIR, os.path.join(CDIR, 'train'), os.path.join(CDIR, 'validation'),
          os.path.join(CDIR, 'test'), os.path.join(CDIR, 'scaler'),
          os.path.join(CDIR, 'metadata')]:
    os.makedirs(d, exist_ok=True)

W = 50                      # 5.0 s at the verified 10.0 Hz
STRIDE = {'train': 5, 'validation': W, 'test': W}   # overlap in train only
CAND_W = [10, 20, 50, 100]  # 1 s, 2 s, 5 s, 10 s
FEATS_A = ['acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z']
FEATS_EXT = FEATS_A + ['linear_acc_x', 'linear_acc_y', 'linear_acc_z',
                       'acc_mag', 'gyro_mag']
TARGETS = ['target_v_forward', 'target_yaw_rate']

dist = pd.read_csv(os.path.join(OUT, 'vbox_session_distribution.csv'))
cal = pd.read_csv(os.path.join(OUT, 'calibration_bias.csv')).set_index('dataset_id')
cm = pd.read_csv(os.path.join(OUT, 'compatibility_matrix.csv'))
veh = cm[cm.kind == 'S'].set_index('dataset_id').vehicle_id.to_dict()

H = dist[dist.conf == 'high'].copy()
VAL = {'S-S3a_s00', 'S-Vta16_s00', 'S-Vta2_s00', 'S-Vw11_s00', 'S-Vw3_s00'}
H['split'] = np.where(H.driver == 'B', 'test',
                      np.where(H.session_id.isin(VAL), 'validation', 'train'))
H['vehicle'] = H.dataset_id.map(veh)


def session_frame(ds, sess):
    """Bias-corrected feature frame + target frame for one session, time-ordered."""
    S = pd.read_parquet(os.path.join(CORE, f'{ds}.parquet'))
    S = S[S.session_id == sess].sort_values(['timestamp_s', 'row_index_original'])
    T = pd.read_parquet(os.path.join(TGT, f'{sess}.parquet'))
    S = S.merge(T[['row_index_original', 'target_v_forward', 'target_yaw_rate',
                   'target_source', 'target_valid', 'target_confidence']],
                on='row_index_original', how='left')
    has_bias = ds in cal.index and pd.notna(cal.loc[ds].get('gyro_bias_x', np.nan))
    if has_bias:
        r = cal.loc[ds]
        gb = np.array([float(r[f'gyro_bias_{a}']) for a in 'xyz'])
        ab = np.array([float(r[f'acc_bias_{a}']) for a in 'xyz'])
        gb, ab = np.nan_to_num(gb), np.nan_to_num(ab)
    else:
        gb = ab = np.zeros(3)
    for i, a in enumerate('xyz'):
        S[f'acc_{a}'] = S[f'acc_{a}'].to_numpy(float) - ab[i]
        S[f'gyro_{a}'] = S[f'gyro_{a}'].to_numpy(float) - gb[i]
        # linear_acc already has gravity removed; only the accel bias is taken out here
        S[f'linear_acc_{a}'] = S[f'linear_acc_{a}'].to_numpy(float) - ab[i]
    S['acc_mag'] = np.linalg.norm(S[['acc_x', 'acc_y', 'acc_z']].to_numpy(float), axis=1)
    S['gyro_mag'] = np.linalg.norm(S[['gyro_x', 'gyro_y', 'gyro_z']].to_numpy(float), axis=1)
    return S, bool(has_bias), gb, ab


def build(sess_rows, split, w, stride, collect=True):
    Xs, Ys, META = [], [], []
    disc = dict(target_invalid=0, target_not_vbox=0, target_not_high=0,
                internal_time_gap=0, nonfinite_features=0, nonfinite_target=0)
    kept = 0
    for _, r in sess_rows.iterrows():
        S, has_bias, gb, ab = session_frame(r.dataset_id, r.session_id)
        n = len(S)
        if n < w:
            continue
        t = S.timestamp_s.to_numpy(float)
        F = S[FEATS_EXT].to_numpy(np.float64)
        y = S[TARGETS].to_numpy(np.float64)
        tv = S.target_valid.fillna(False).to_numpy(bool)
        src = S.target_source.fillna('none').to_numpy()
        conf = S.target_confidence.fillna('none').to_numpy()
        dt = float(np.median(np.diff(t))) if n > 1 else 0.1
        span_ok = (w - 1) * dt
        ends = np.arange(w - 1, n, stride)
        for e in ends:
            s0 = e - w + 1
            if not tv[e]:
                disc['target_invalid'] += 1; continue
            if src[e] != 'vbox':
                disc['target_not_vbox'] += 1; continue
            if conf[e] != 'high':
                disc['target_not_high'] += 1; continue
            span = t[e] - t[s0]
            if not (0.9 * span_ok <= span <= 1.1 * span_ok):
                disc['internal_time_gap'] += 1; continue
            blk = F[s0:e + 1]
            if not np.isfinite(blk).all():
                disc['nonfinite_features'] += 1; continue
            if not np.isfinite(y[e]).all():
                disc['nonfinite_target'] += 1; continue
            kept += 1
            if collect:
                Xs.append(blk.astype(np.float32))
                Ys.append(y[e].astype(np.float32))
                META.append((r.session_id, r.dataset_id, r.driver, r.vehicle, r.phone,
                             float(t[s0]), float(t[e]), int(S.row_index_original.iloc[s0]),
                             int(S.row_index_original.iloc[e]), has_bias))
    if not collect:
        return kept, disc
    X = np.stack(Xs) if Xs else np.zeros((0, w, len(FEATS_EXT)), np.float32)
    Y = np.stack(Ys) if Ys else np.zeros((0, len(TARGETS)), np.float32)
    M = pd.DataFrame(META, columns=['session_id', 'dataset_id', 'driver_id', 'vehicle_id',
                                    'phone_id', 'start_timestamp', 'end_timestamp',
                                    'start_row_original', 'end_row_original', 'bias_applied'])
    return X, Y, M, disc


# ---------- window-size study (counts only, no arrays) ----------
wstats = []
for w in CAND_W:
    for split in ['train', 'validation', 'test']:
        sr = H[H.split == split]
        k, d = build(sr, split, w, STRIDE[split] if w == W else w, collect=False)
        wstats.append(dict(window_samples=w, window_seconds=round(w / 10.0, 1), split=split,
                           stride=STRIDE[split] if w == W else w, n_windows=k, **d))
    print(f'  window {w} done', flush=True)
pd.DataFrame(wstats).to_csv(os.path.join(OUT, 'window_statistics.csv'), index=False)

# ---------- build the baseline W=50 ----------
data, disc_all = {}, {}
for split in ['train', 'validation', 'test']:
    X, Y, M, d = build(H[H.split == split], split, W, STRIDE[split])
    data[split] = (X, Y, M)
    disc_all[split] = d
    print(f'{split}: X={X.shape} y={Y.shape}', flush=True)

# ---------- scaler: TRAIN ONLY ----------
Xtr = data['train'][0]
flat = Xtr.reshape(-1, Xtr.shape[2])
mu, sd = flat.mean(0), flat.std(0)
sd = np.where(sd < 1e-8, 1.0, sd)
ytr = data['train'][1]
ymu, ysd = ytr.mean(0), ytr.std(0)
ysd = np.where(ysd < 1e-8, 1.0, ysd)
np.savez(os.path.join(CDIR, 'scaler', 'scaler.npz'), feature_mean=mu, feature_std=sd,
         target_mean=ymu, target_std=ysd,
         feature_names=np.array(FEATS_EXT), target_names=np.array(TARGETS))
json.dump({'fitted_on': 'train split only', 'n_train_windows': int(Xtr.shape[0]),
           'n_train_samples_flat': int(flat.shape[0]),
           'feature_names': FEATS_EXT,
           'feature_mean': mu.round(6).tolist(), 'feature_std': sd.round(6).tolist(),
           'target_names': TARGETS,
           'target_mean': ymu.round(6).tolist(), 'target_std': ysd.round(6).tolist(),
           'note': 'Arrays on disk are RAW (unscaled). Apply (x - mean)/std at load time. '
                   'Validation and test statistics never contributed to this scaler.'},
          open(os.path.join(CDIR, 'scaler', 'scaler.json'), 'w'), indent=2)

# ---------- write arrays ----------
idxA = [FEATS_EXT.index(f) for f in FEATS_A]
for split, sub in [('train', 'train'), ('validation', 'validation'), ('test', 'test')]:
    X, Y, M = data[split]
    tag = {'train': 'train', 'validation': 'val', 'test': 'test'}[split]
    np.save(os.path.join(CDIR, sub, f'X_{tag}.npy'), X[:, :, idxA])
    np.save(os.path.join(CDIR, sub, f'X_ext_{tag}.npy'), X)
    np.save(os.path.join(CDIR, sub, f'y_{tag}.npy'), Y)
    M.to_parquet(os.path.join(CDIR, 'metadata', f'metadata_{tag}.parquet'), index=False)

H[['session_id', 'dataset_id', 'driver', 'vehicle', 'phone', 'split', 'rows',
   'duration_s', 'distance_km', 'target_rows', 'conf', 'source', 'sync_conf',
   'gyro_tf', 'acc_tf', 'has_bias', 'lag_s']].to_csv(
    os.path.join(CDIR, 'split_manifest.csv'), index=False)

json.dump({
    'baseline_feature_set': 'A',
    'baseline_features': FEATS_A,
    'window_samples': W, 'window_seconds': W / 10.0, 'sampling_rate_hz': 10.0,
    'causal': True, 'target_position': 'last sample of the window',
    'targets': TARGETS,
    'excluded_as_input': ['gps_latitude', 'gps_longitude', 'gps_speed_kmh',
                          'gps_bearing_deg', 'gps_accuracy_m', 'gps_satellites_used',
                          'gps_satellites_visible'],
    'excluded_as_target': ['target_v_lateral'],
    'stored_arrays': {
        'X_*.npy': f'(N, {W}, 6) float32 - feature set A, RAW (unscaled)',
        'X_ext_*.npy': f'(N, {W}, 11) float32 - superset for ablation, RAW',
        'y_*.npy': f'(N, 2) float32 - {TARGETS}'},
    'ext_channel_order': FEATS_EXT,
    'feature_sets': {
        'A': {'channels': FEATS_A,
              'ext_indices': [FEATS_EXT.index(f) for f in FEATS_A],
              'description': 'acc XYZ + gyro XYZ (baseline)'},
        'B': {'channels': FEATS_A + ['linear_acc_x', 'linear_acc_y', 'linear_acc_z'],
              'ext_indices': [FEATS_EXT.index(f) for f in
                              FEATS_A + ['linear_acc_x', 'linear_acc_y', 'linear_acc_z']],
              'description': 'A + gravity-removed linear acceleration'},
        'C': {'channels': FEATS_A + ['acc_mag', 'gyro_mag'],
              'ext_indices': [FEATS_EXT.index(f) for f in FEATS_A + ['acc_mag', 'gyro_mag']],
              'description': 'A + rotation-invariant magnitudes'},
        'D': {'channels': FEATS_EXT,
              'ext_indices': list(range(len(FEATS_EXT))),
              'description': 'A + linear_acc + magnitudes (all channels)'}},
    'preprocessing_applied': {
        'gravity_subtraction': 'already applied upstream; NOT reapplied',
        'accelerometer_bias': 'applied here, per session, 27/45 sessions have estimates',
        'gyroscope_bias': 'applied here, per session, 27/45 sessions have estimates',
        'coordinate_rotation': 'NOT applied (low confidence)',
        'normalisation': 'NOT baked in; scaler fitted on train only, stored separately'},
}, open(os.path.join(OUT, 'feature_schema.json'), 'w'), indent=2)

# ---------- dataset statistics ----------
stats = []
for split in ['train', 'validation', 'test']:
    X, Y, M = data[split]
    XA = X[:, :, idxA]
    row = dict(split=split, n_windows=int(X.shape[0]),
               n_sessions=int(M.session_id.nunique()) if len(M) else 0,
               drivers=','.join(sorted(M.driver_id.unique())) if len(M) else '',
               rows_covered=int(H[H.split == split].target_rows.sum()),
               stride=STRIDE[split],
               overlap_pct=round(100 * (1 - STRIDE[split] / W), 1))
    for i, f in enumerate(FEATS_A):
        row[f'{f}_mean'] = round(float(XA[:, :, i].mean()), 5) if len(XA) else np.nan
        row[f'{f}_std'] = round(float(XA[:, :, i].std()), 5) if len(XA) else np.nan
    for i, tn in enumerate(TARGETS):
        row[f'{tn}_mean'] = round(float(Y[:, i].mean()), 5) if len(Y) else np.nan
        row[f'{tn}_std'] = round(float(Y[:, i].std()), 5) if len(Y) else np.nan
        row[f'{tn}_min'] = round(float(Y[:, i].min()), 5) if len(Y) else np.nan
        row[f'{tn}_max'] = round(float(Y[:, i].max()), 5) if len(Y) else np.nan
    row.update({f'disc_{k}': v for k, v in disc_all[split].items()})
    stats.append(row)
pd.DataFrame(stats).to_csv(os.path.join(OUT, 'dataset_statistics.csv'), index=False)

print('\n=== discarded windows ===')
for s, d in disc_all.items():
    print(' ', s, d, 'total discarded:', sum(d.values()))
print('\nwrote training_dataset/')
