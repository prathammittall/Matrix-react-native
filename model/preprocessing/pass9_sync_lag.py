"""Pass 9 (step 3): per-session S/V temporal offset analysis.

Separates the two distinct quantities that both get loosely called "offset":

  time_offset_seconds  = absolute wall-clock difference between the phone clock
                         (LOCAL time) and the VBOX clock (UTC time-of-day), measured
                         at the row-aligned start of the session. Contains the
                         BST/GMT term plus any fixed device clock offset.

  estimated_lag_seconds = RESIDUAL lag remaining AFTER the authors' row-index
                         alignment, found by cross-correlating phone gyroscope
                         against VBOX yaw rate. This is what actually matters for
                         using VBOX as supervision.

Emits outputs/synchronization_report.csv. Reads only; writes nothing to raw data.
"""
import os, re, json, glob
import numpy as np
import pandas as pd
from scipy.signal import correlate

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'outputs')
BASE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.join(BASE, 'smartphone_core')
CAL = os.path.join(BASE, 'calibration')
VREF = os.path.join(BASE, 'vehicle_reference')

syn = pd.read_csv(os.path.join(OUT, 'sv_synchronisation_final.csv'))
inv = pd.read_csv(os.path.join(OUT, 'raw_inventory.csv'))

MAX_LAG_S = 60.0          # search +/- 60 s of residual lag
SMOOTH_S = 1.0            # 1 s smoothing kills vibration, keeps vehicle dynamics


def norm(x):
    x = np.asarray(x, dtype='float64')
    m = np.isfinite(x)
    if m.sum() < 10:
        return None
    x = np.where(m, x, np.nanmean(x[m]))
    s = x.std()
    return (x - x.mean()) / s if s > 1e-12 else None


def best_lag(a, b, max_lag):
    """Return (lag_samples, r) maximising |corr| for a shifted against b."""
    a, b = norm(a), norm(b)
    if a is None or b is None:
        return np.nan, np.nan
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    c = correlate(a, b, mode='full', method='fft') / n
    lags = np.arange(-(n - 1), n)
    k = (np.abs(lags) <= max_lag)
    c, lags = c[k], lags[k]
    if not len(c):
        return np.nan, np.nan
    i = int(np.nanargmax(np.abs(c)))
    return int(lags[i]), float(c[i])


def smooth(x, w):
    return pd.Series(x).rolling(w, center=True, min_periods=1).mean().to_numpy()


def sload(ds):
    p = os.path.join(CORE, f'{ds}.parquet')
    if not os.path.exists(p):
        p = os.path.join(CAL, f'{ds}.parquet')
    return pd.read_parquet(p) if os.path.exists(p) else None


rows = []
pairs = syn[syn.verdict.astype(str).str.startswith('SYNC_')]
for _, pr in pairs.iterrows():
    s_id, v_id = pr.s_id, pr.v_id
    S = sload(s_id)
    vp = os.path.join(VREF, f'{v_id}__V_sync.parquet')
    if S is None or not os.path.exists(vp):
        continue
    V = pd.read_parquet(vp)
    S = S.sort_values('row_index_original')
    dt_s = float(pd.Series(S.timestamp_s.to_numpy()).diff().median())
    if not np.isfinite(dt_s) or dt_s <= 0:
        dt_s = 0.1
    w = max(1, int(round(SMOOTH_S / dt_s)))
    max_lag = int(round(MAX_LAG_S / dt_s))

    for sess, g in S.groupby('session_id', sort=True):
        idx = g.row_index_original.to_numpy()
        idx = idx[idx < len(V)]
        if len(idx) < 300:
            rows.append(dict(dataset_id=s_id, v_dataset_id=v_id, session_id=sess,
                             n_rows=len(g), verdict=pr.verdict,
                             estimated_lag_seconds=np.nan, time_offset_seconds=np.nan,
                             correlation_used='none', correlation_r=np.nan,
                             confidence='unusable', usable_for_vbox_supervision=False,
                             note='session too short to estimate lag (<300 rows)'))
            continue
        gg = g.iloc[:len(idx)]
        Vs = V.iloc[idx]

        # ---- absolute clock offset (phone LOCAL vs VBOX UTC time-of-day)
        wt = pd.to_datetime(gg.wall_time_local)
        s_tod = (wt.dt.hour * 3600 + wt.dt.minute * 60 + wt.dt.second
                 + wt.dt.microsecond / 1e6).to_numpy()
        v_tod = pd.to_numeric(Vs.v_tod_s, errors='coerce').to_numpy(dtype='float64')
        off = np.nanmedian(s_tod - v_tod)

        # ---- residual lag: rotation-invariant |gyro| vs |yaw rate|
        gyro_mag = np.linalg.norm(gg[['gyro_x', 'gyro_y', 'gyro_z']].to_numpy(float), axis=1)
        yaw = np.radians(pd.to_numeric(Vs.v_yaw_rate_dps, errors='coerce').to_numpy(float))
        spd = pd.to_numeric(Vs.v_velocity_kmh, errors='coerce').to_numpy(float)
        moving = np.nanstd(spd) > 1.0

        cands = []
        if moving:
            L, r = best_lag(smooth(gyro_mag, w), smooth(np.abs(yaw), w), max_lag)
            cands.append(('abs_gyro_mag_vs_abs_yawrate', L, r))
            for ax in 'xyz':   # signed, per axis -- also tells us which axis carries yaw
                L2, r2 = best_lag(smooth(gg[f'gyro_{ax}'].to_numpy(float), w),
                                  smooth(yaw, w), max_lag)
                cands.append((f'gyro_{ax}_vs_yawrate', L2, r2))
        cands = [c for c in cands if np.isfinite(c[2])]
        if not cands:
            rows.append(dict(dataset_id=s_id, v_dataset_id=v_id, session_id=sess,
                             n_rows=len(gg), verdict=pr.verdict,
                             estimated_lag_seconds=np.nan, time_offset_seconds=round(float(off), 2),
                             correlation_used='none', correlation_r=np.nan,
                             confidence='unusable', usable_for_vbox_supervision=False,
                             note='no vehicle motion in session; lag unidentifiable'))
            continue
        used, L, r = max(cands, key=lambda c: abs(c[2]))
        lag_s = L * dt_s
        ar = abs(r)

        # Two INDEPENDENT estimates of the same misalignment:
        #   (a) cross-correlation peak -> lag_s
        #   (b) wall clock: after removing whole hours (BST/GMT), the residual clock
        #       difference predicts the lag as -residual.
        # Where the correlation is strong these agree within ~1 s, which shows the two
        # device clocks are consistent and the authors' row trimming is off by exactly
        # that residual. Where the correlation is weak, the xcorr peak is unreliable and
        # the wall clock is the better estimate.
        k = round(off / 3600.0) if np.isfinite(off) else 0
        wall_residual = off - 3600.0 * k if np.isfinite(off) else np.nan
        predicted_lag = -wall_residual if np.isfinite(wall_residual) else np.nan
        agree = (np.isfinite(predicted_lag) and abs(lag_s - predicted_lag) <= 2.0)

        note = ''
        if ar >= 0.60 and agree:
            conf = 'high'
            method, shift = 'xcorr+wallclock_agree', lag_s
        elif ar >= 0.60:
            conf = 'medium'
            method, shift = 'xcorr_only_wallclock_disagrees', lag_s
            note = (f'xcorr lag {lag_s:+.1f}s vs wall-clock prediction '
                    f'{predicted_lag:+.1f}s')
        elif ar >= 0.35 and agree:
            conf = 'medium'
            method, shift = 'wallclock_confirmed_by_weak_xcorr', predicted_lag
        elif ar >= 0.20:
            conf = 'low'
            method, shift = 'wallclock_preferred_xcorr_weak', predicted_lag
            note = 'weak correlation; xcorr peak not trusted, wall clock used'
        else:
            conf = 'unusable'
            method, shift = 'none', np.nan
            note = f'no usable correlation (|r|={ar:.2f})'
        if abs(lag_s) >= MAX_LAG_S - dt_s:
            conf, method, shift = 'unusable', 'none', np.nan
            note = 'lag hit search boundary; true offset exceeds +/-60 s'

        usable = conf in ('high', 'medium') and pr.verdict == 'SYNC_ROW_ALIGNED'
        if conf in ('high', 'medium') and pr.verdict != 'SYNC_ROW_ALIGNED':
            note = (note + '; ' if note else '') + f'pair verdict {pr.verdict}'
            usable = False
        rows.append(dict(dataset_id=s_id, v_dataset_id=v_id, session_id=sess,
                         n_rows=len(gg), verdict=pr.verdict,
                         estimated_lag_seconds=round(float(lag_s), 3),
                         time_offset_seconds=round(float(off), 2),
                         wall_clock_residual_s=round(float(wall_residual), 3)
                         if np.isfinite(wall_residual) else np.nan,
                         predicted_lag_from_clock_s=round(float(predicted_lag), 3)
                         if np.isfinite(predicted_lag) else np.nan,
                         lag_methods_agree=bool(agree),
                         recommended_shift_seconds=round(float(shift), 3)
                         if np.isfinite(shift) else np.nan,
                         alignment_method=method,
                         correlation_used=used, correlation_r=round(float(r), 4),
                         confidence=conf, usable_for_vbox_supervision=bool(usable),
                         note=note))
    print('.', end='', flush=True)

df = pd.DataFrame(rows)
df['bst_like_offset'] = (df.time_offset_seconds.abs().sub(3600).abs() < 120)
df.to_csv(os.path.join(OUT, 'synchronization_report.csv'), index=False)
print(f"\nsessions analysed: {len(df)}")
print(df.confidence.value_counts().to_string())
print("\nusable_for_vbox_supervision:", int(df.usable_for_vbox_supervision.sum()))
print("\ncorrelation_used (best signal) counts:")
print(df.correlation_used.value_counts().to_string())
print("\nresidual lag (usable only):")
u = df[df.usable_for_vbox_supervision]
print(u.estimated_lag_seconds.describe().round(3).to_string())
print("\ntime_offset clusters:")
print(df.time_offset_seconds.round(-1).value_counts().head(8).to_string())
