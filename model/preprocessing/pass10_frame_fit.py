"""Pass 10 (steps 4 and 5): estimate and validate the smartphone -> vehicle frame
transformation, per session, from data only.

No universal rotation matrix is assumed. For each lag-corrected synchronised session we
solve least squares against the VBOX channels that actually observe the vehicle frame:

    v_acc_long  ~ r_fwd  . linear_acc      (row 1 of the accelerometer rotation)
    v_acc_lat   ~ r_lat  . linear_acc      (row 2)
    v_yaw_rate  ~ r_yaw  . gyro            (vertical row of the GYROSCOPE rotation)

The vertical accelerometer row is derived as r_fwd x r_lat.

The accelerometer and the gyroscope are fitted SEPARATELY and on purpose: pass 6 showed
they are not in a consistent axis convention, so forcing one matrix on both would be
wrong. Bias correction is applied here for the FIRST time (smartphone_core/ holds raw,
gravity-subtracted values only).

Emits outputs/frame_transformations.json and outputs/frame_validation.csv.
"""
import os, json
import numpy as np
import pandas as pd
from scipy.signal import correlate

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'outputs')
CORE = os.path.join(BASE, 'smartphone_core')
CAL = os.path.join(BASE, 'calibration')
VREF = os.path.join(BASE, 'vehicle_reference')
G = 9.80665

sync = pd.read_csv(os.path.join(OUT, 'synchronization_report.csv'))
cal = pd.read_csv(os.path.join(OUT, 'calibration_bias.csv')).set_index('dataset_id')
SMOOTH_S = 1.0


def smooth(a, w):
    return pd.DataFrame(a).rolling(w, center=True, min_periods=1).mean().to_numpy()


def apply_lag(s, v, L):
    """best_lag(S,V)=L means S is delayed by L samples; align with S[n+L] <-> V[n]."""
    if L > 0:
        return s[L:], v[:len(v) - L]
    if L < 0:
        return s[:len(s) + L], v[-L:]
    return s, v


def fit(X, y):
    """Least squares y ~ X.c + b. Returns coeffs, intercept, r, rmse."""
    m = np.isfinite(y) & np.isfinite(X).all(axis=1)
    if m.sum() < 200:
        return None
    A = np.c_[X[m], np.ones(m.sum())]
    coef, *_ = np.linalg.lstsq(A, y[m], rcond=None)
    pred = A @ coef
    resid = y[m] - pred
    rmse = float(np.sqrt(np.mean(resid ** 2)))
    r = float(np.corrcoef(pred, y[m])[0, 1]) if np.std(pred) > 1e-12 else np.nan
    return dict(c=coef[:3].tolist(), b=float(coef[3]), r=r, rmse=rmse,
                r2=float(1 - np.var(resid) / np.var(y[m])), n=int(m.sum()))


def corr_rmse(a, b):
    m = np.isfinite(a) & np.isfinite(b)
    if m.sum() < 50 or np.std(a[m]) < 1e-12 or np.std(b[m]) < 1e-12:
        return np.nan, np.nan
    return (float(np.corrcoef(a[m], b[m])[0, 1]),
            float(np.sqrt(np.mean((a[m] - b[m]) ** 2))))


transforms, valrows = {}, []
use = sync[sync.usable_for_vbox_supervision]

for _, s in use.iterrows():
    p = os.path.join(CORE, f'{s.dataset_id}.parquet')
    if not os.path.exists(p):
        p = os.path.join(CAL, f'{s.dataset_id}.parquet')
    S = pd.read_parquet(p).sort_values('row_index_original')
    S = S[S.session_id == s.session_id]
    V = pd.read_parquet(os.path.join(VREF, f'{s.v_dataset_id}__V_sync.parquet'))
    idx = S.row_index_original.to_numpy()
    idx = idx[idx < len(V)]
    S = S.iloc[:len(idx)]
    Vs = V.iloc[idx]
    dt = float(pd.Series(S.timestamp_s.to_numpy()).diff().median()) or 0.1
    w = max(1, int(round(SMOOTH_S / dt)))

    # ---- bias correction: FIRST application (core parquet holds raw values)
    cb = cal.loc[s.dataset_id] if s.dataset_id in cal.index else None
    gb = np.array([float(cb.get(f'gyro_bias_{a}', 0) or 0) for a in 'xyz']) \
        if cb is not None else np.zeros(3)
    ab = np.array([float(cb.get(f'acc_bias_{a}', 0) or 0) for a in 'xyz']) \
        if cb is not None else np.zeros(3)
    gb = np.nan_to_num(gb)
    ab = np.nan_to_num(ab)

    gyro = S[['gyro_x', 'gyro_y', 'gyro_z']].to_numpy(float) - gb
    lin = S[['linear_acc_x', 'linear_acc_y', 'linear_acc_z']].to_numpy(float) - ab
    v_long = pd.to_numeric(Vs.v_acc_long_g, errors='coerce').to_numpy(float) * G
    v_lat = pd.to_numeric(Vs.v_acc_lat_g, errors='coerce').to_numpy(float) * G
    v_yaw = np.radians(pd.to_numeric(Vs.v_yaw_rate_dps, errors='coerce').to_numpy(float))

    L = int(round(float(s.recommended_shift_seconds) / dt)) if np.isfinite(s.recommended_shift_seconds) else 0
    gyro_a, v_yaw_a = apply_lag(gyro, v_yaw, L)
    lin_a, v_long_a = apply_lag(lin, v_long, L)
    _, v_lat_a = apply_lag(lin, v_lat, L)
    n = min(len(gyro_a), len(v_yaw_a))
    if n < 300:
        continue
    gyro_a, lin_a = gyro_a[:n], lin_a[:n]
    v_yaw_a, v_long_a, v_lat_a = v_yaw_a[:n], v_long_a[:n], v_lat_a[:n]

    gs, ls = smooth(gyro_a, w), smooth(lin_a, w)
    ys = smooth(v_yaw_a.reshape(-1, 1), w).ravel()
    los = smooth(v_long_a.reshape(-1, 1), w).ravel()
    las = smooth(v_lat_a.reshape(-1, 1), w).ravel()

    f_yaw, f_long, f_lat = fit(gs, ys), fit(ls, los), fit(ls, las)
    if not (f_yaw and f_long and f_lat):
        continue

    # ---- BEFORE: the naive assumption phone X=forward, Y=lateral, Z=yaw, no lag fix
    g0, y0 = smooth(gyro, w), smooth(v_yaw.reshape(-1, 1), w).ravel()
    l0 = smooth(lin, w)
    lo0 = smooth(v_long.reshape(-1, 1), w).ravel()
    la0 = smooth(v_lat.reshape(-1, 1), w).ravel()
    k = min(len(g0), len(y0))
    b_yaw_r, b_yaw_rmse = corr_rmse(g0[:k, 2], y0[:k])          # gyro_z vs yaw
    b_long_r, b_long_rmse = corr_rmse(l0[:k, 0], lo0[:k])       # lin_acc_x vs long
    b_lat_r, b_lat_rmse = corr_rmse(l0[:k, 1], la0[:k])         # lin_acc_y vs lat

    rf = np.array(f_long['c'])
    rl = np.array(f_lat['c'])
    rv = np.cross(rf, rl)
    nf, nl = np.linalg.norm(rf), np.linalg.norm(rl)
    orth = float(abs(np.dot(rf / (nf + 1e-12), rl / (nl + 1e-12))))

    # ---- quality gating. Least-squares rows are only a valid rotation where the fit is
    # strong; with a weak fit the coefficients are contaminated by errors-in-variables
    # (row norm correlates ~0.8 with fit quality), so they must NOT be used as a rotation.
    gyro_ok = abs(f_yaw['r']) >= 0.80
    acc_ok = (abs(f_long['r']) >= 0.50 and abs(f_lat['r']) >= 0.50)
    key = s.session_id
    transforms[key] = {
        'gyro_transform_usable': bool(gyro_ok),
        'acc_transform_usable': bool(acc_ok),
        'transform_quality': ('good' if gyro_ok and acc_ok else
                              'yaw_only' if gyro_ok else
                              'unusable'),
        'dataset_id': s.dataset_id, 'v_dataset_id': s.v_dataset_id,
        'session_id': s.session_id, 'driver_id': str(S.driver_id.iloc[0]),
        'phone_id': str(S.phone_id.iloc[0]), 'vehicle_id': str(S.vehicle_id.iloc[0]),
        'n_samples_fitted': int(n), 'sample_dt_s': round(dt, 4),
        'lag_applied_samples': L, 'lag_applied_seconds': round(L * dt, 3),
        'sync_confidence': s.confidence,
        'bias_removed': {'gyro': gb.round(6).tolist(), 'acc': ab.round(6).tolist()},
        'accelerometer_to_vehicle': {
            'note': 'rows map phone linear_acc -> vehicle axes; intercept in m/s^2',
            'forward_row': [round(x, 5) for x in f_long['c']],
            'forward_intercept': round(f_long['b'], 5),
            'lateral_row': [round(x, 5) for x in f_lat['c']],
            'lateral_intercept': round(f_lat['b'], 5),
            'vertical_row_derived': [round(x, 5) for x in rv.tolist()],
            'forward_row_norm': round(float(nf), 4),
            'lateral_row_norm': round(float(nl), 4),
            'row_nonorthogonality': round(orth, 4),
            'r_forward': round(f_long['r'], 4), 'rmse_forward_ms2': round(f_long['rmse'], 4),
            'r_lateral': round(f_lat['r'], 4), 'rmse_lateral_ms2': round(f_lat['rmse'], 4)},
        'gyroscope_to_vehicle': {
            'note': 'only the vertical (yaw) row is observable from VBOX; rad/s',
            'yaw_row': [round(x, 5) for x in f_yaw['c']],
            'yaw_intercept': round(f_yaw['b'], 6),
            'yaw_row_norm': round(float(np.linalg.norm(f_yaw['c'])), 4),
            'r_yaw': round(f_yaw['r'], 4), 'rmse_yaw_rads': round(f_yaw['rmse'], 5)},
    }
    valrows.append(dict(
        dataset_id=s.dataset_id, session_id=s.session_id, phone_id=S.phone_id.iloc[0],
        driver_id=S.driver_id.iloc[0], n=n, lag_s=round(L * dt, 3),
        sync_confidence=s.confidence,
        before_r_long=round(b_long_r, 4), after_r_long=round(f_long['r'], 4),
        before_rmse_long=round(b_long_rmse, 4), after_rmse_long=round(f_long['rmse'], 4),
        before_r_lat=round(b_lat_r, 4), after_r_lat=round(f_lat['r'], 4),
        before_rmse_lat=round(b_lat_rmse, 4), after_rmse_lat=round(f_lat['rmse'], 4),
        before_r_yaw=round(b_yaw_r, 4), after_r_yaw=round(f_yaw['r'], 4),
        before_rmse_yaw=round(b_yaw_rmse, 5), after_rmse_yaw=round(f_yaw['rmse'], 5),
        yaw_row_norm=round(float(np.linalg.norm(f_yaw['c'])), 4),
        fwd_row_norm=round(float(nf), 4), lat_row_norm=round(float(nl), 4),
        nonorthogonality=round(orth, 4),
        gyro_transform_usable=bool(gyro_ok), acc_transform_usable=bool(acc_ok),
        transform_quality=('good' if gyro_ok and acc_ok else
                           'yaw_only' if gyro_ok else 'unusable')))
    print('.', end='', flush=True)

payload = {
    'description': 'Per-session smartphone -> vehicle frame transformations for IO-VNBD, '
                   'estimated from lag-corrected synchronised VBOX data. No universal '
                   'rotation is assumed or applied.',
    'vehicle_frame': {'X': 'forward', 'Y': 'lateral', 'Z': 'vertical'},
    'important': [
        'Accelerometer and gyroscope are fitted with SEPARATE matrices: they are not in a '
        'consistent axis convention in this dataset (see preprocessing_report.md section 9).',
        'Only the forward and lateral accelerometer rows and the yaw gyroscope row are '
        'observable from VBOX. The vertical accelerometer row is derived as forward x lateral '
        'and is NOT independently validated.',
        'Rows are raw least-squares solutions and are deliberately NOT orthonormalised, so '
        'row norms and non-orthogonality remain visible as diagnostics.',
        'Bias correction is applied at this stage; smartphone_core/ contains raw '
        '(gravity-subtracted) values with bias NOT removed.',
        'These transformations are valid only for sessions with a synchronised VBOX pair. '
        'GPS-only sessions have no per-session rotation and must not borrow one.',
    ],
    'sessions': transforms,
}
with open(os.path.join(OUT, 'frame_transformations.json'), 'w', encoding='utf-8') as f:
    json.dump(payload, f, indent=2)
val = pd.DataFrame(valrows)
val.to_csv(os.path.join(OUT, 'frame_validation.csv'), index=False)

print(f"\nsessions fitted: {len(transforms)}")
pd.set_option('display.width', 250)
print("\n=== VALIDATION: before (naive axes, no lag) vs after (fitted, lag-corrected) ===")
for ch in ['long', 'lat', 'yaw']:
    b, a = val[f'before_r_{ch}'].abs(), val[f'after_r_{ch}'].abs()
    br, ar = val[f'before_rmse_{ch}'], val[f'after_rmse_{ch}']
    print(f"  {ch:5s} |r| median {b.median():.3f} -> {a.median():.3f} | "
          f"RMSE median {br.median():.4f} -> {ar.median():.4f} | "
          f"improved in {int((a > b).sum())}/{len(val)} sessions")
print("\n=== fitted row norms (1.0 would mean a pure rotation) ===")
print(val[['fwd_row_norm', 'lat_row_norm', 'yaw_row_norm', 'nonorthogonality']]
      .describe().round(3).to_string())
