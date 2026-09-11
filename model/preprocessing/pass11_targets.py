"""Pass 11 (steps 7, 8, 9): generate the two target strategies with quality flags.

Strategy A - VBOX-supervised (preferred): dense 10 Hz targets from the lag-corrected,
             row-aligned VBOX channels.
Strategy B - GPS-supervised (fallback): SPARSE targets defined ONLY between consecutive
             valid GPS fixes. GPS is never forward-filled and repeated GPS values are
             never treated as new measurements: non-fix rows get target_valid = False.

No windows are created, nothing is normalised, no model is trained.
Emits targets/<session>.parquet and outputs/target_summary.csv.
"""
import os, json
import numpy as np
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'outputs')
CORE = os.path.join(BASE, 'smartphone_core')
CAL = os.path.join(BASE, 'calibration')
VREF = os.path.join(BASE, 'vehicle_reference')
TGT = os.path.join(BASE, 'targets')
os.makedirs(TGT, exist_ok=True)
G = 9.80665
R_EARTH = 6371000.0

sync = pd.read_csv(os.path.join(OUT, 'synchronization_report.csv'))
val = pd.read_csv(os.path.join(OUT, 'frame_validation.csv')).set_index('session_id')
cm = pd.read_csv(os.path.join(OUT, 'compatibility_matrix.csv'))
tf = json.load(open(os.path.join(OUT, 'frame_transformations.json')))['sessions']

vbox_sessions = set(sync[sync.usable_for_vbox_supervision].session_id) & set(tf)


def apply_lag_idx(n, L):
    """Return (s_slice, v_slice) index arrays aligning S[n+L] with V[n]."""
    if L > 0:
        return slice(L, n), slice(0, n - L)
    if L < 0:
        return slice(0, n + L), slice(-L, n)
    return slice(0, n), slice(0, n)


def bearing(la1, lo1, la2, lo2):
    p1, p2 = np.radians(la1), np.radians(la2)
    dl = np.radians(lo2 - lo1)
    y = np.sin(dl) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return np.degrees(np.arctan2(y, x)) % 360


def haversine(la1, lo1, la2, lo2):
    p1, p2 = np.radians(la1), np.radians(la2)
    dp, dl = p2 - p1, np.radians(lo2 - lo1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def wrap180(d):
    return (d + 180.0) % 360.0 - 180.0


rows = []
usable = cm[(cm.kind == 'S') & (cm.group.isin(['B', 'C', 'E']))]
for _, c in usable.iterrows():
    p = os.path.join(CORE, f'{c.dataset_id}.parquet')
    if not os.path.exists(p):
        p = os.path.join(CAL, f'{c.dataset_id}.parquet')
    S_all = pd.read_parquet(p).sort_values('row_index_original')

    for sess, S in S_all.groupby('session_id', sort=True):
        S = S.reset_index(drop=True)
        n = len(S)
        t = S.timestamp_s.to_numpy(float)
        T = pd.DataFrame({'session_id': sess, 'dataset_id': c.dataset_id,
                          'driver_id': c.driver_id, 'vehicle_id': c.vehicle_id,
                          'phone_id': c.phone_id,
                          'row_index_original': S.row_index_original.to_numpy(),
                          'timestamp_s': t})
        for col in ['target_v_forward', 'target_v_lateral', 'target_yaw_rate',
                    'target_displacement_m', 'target_dt_s', 'target_delta_heading_deg',
                    'aux_centripetal_acc']:
            T[col] = np.nan
        # v_lateral is never an observed quantity in this dataset (see note below)
        T['target_v_lateral_observable'] = False
        T['target_source'] = 'none'
        T['target_valid'] = False
        T['target_confidence'] = 'none'

        # ================= Strategy A: VBOX-supervised =================
        if sess in vbox_sessions:
            sr = sync[sync.session_id == sess].iloc[0]
            V = pd.read_parquet(os.path.join(VREF, f'{sr.v_dataset_id}__V_sync.parquet'))
            idx = S.row_index_original.to_numpy()
            keep = idx < len(V)
            Vs = V.iloc[idx[keep]].reset_index(drop=True)
            m = int(keep.sum())
            dt = float(pd.Series(t).diff().median()) or 0.1
            L = int(round(float(sr.recommended_shift_seconds) / dt)) \
                if np.isfinite(sr.recommended_shift_seconds) else 0
            ss, vv = apply_lag_idx(m, L)

            v_fwd = pd.to_numeric(Vs.v_velocity_kmh, errors='coerce').to_numpy(float) / 3.6
            yaw = np.radians(pd.to_numeric(Vs.v_yaw_rate_dps, errors='coerce').to_numpy(float))
            a_lat = pd.to_numeric(Vs.v_acc_lat_g, errors='coerce').to_numpy(float) * G
            # Lateral velocity is NOT observable from these channels. Measured evidence:
            # corr(a_lat, yaw_rate * v_fwd) = 0.91, i.e. lateral acceleration is almost
            # entirely the centripetal term, and the residual (a_lat - yaw*v_fwd) is
            # noise-dominated (std 0.33 m/s^2). Leaky-integrating that residual implies a
            # sideslip ~7x larger than the physical bound for a road car (<2 deg), so any
            # such target would be fabricated. A non-holonomic ground vehicle has
            # v_lateral ~ 0 in the body frame, so we emit exactly that and flag it as
            # not observed rather than inventing a value.
            v_lat = np.zeros_like(v_fwd)
            centripetal = yaw * v_fwd            # auxiliary diagnostic, not a target
            tgt_i = np.flatnonzero(keep)[ss]
            T.loc[tgt_i, 'target_v_forward'] = v_fwd[vv]
            T.loc[tgt_i, 'target_yaw_rate'] = yaw[vv]
            T.loc[tgt_i, 'target_v_lateral'] = v_lat[vv]
            T.loc[tgt_i, 'target_v_lateral_observable'] = False
            T.loc[tgt_i, 'aux_centripetal_acc'] = centripetal[vv]
            T.loc[tgt_i, 'target_dt_s'] = dt
            T.loc[tgt_i, 'target_source'] = 'vbox'
            ok = np.isfinite(v_fwd[vv]) & np.isfinite(yaw[vv])
            T.loc[tgt_i[ok], 'target_valid'] = True
            vq = val.loc[sess] if sess in val.index else None
            hi = (sr.confidence == 'high' and vq is not None
                  and bool(vq.gyro_transform_usable))
            T.loc[tgt_i[ok], 'target_confidence'] = 'high' if hi else 'medium'

        # ================= Strategy B: GPS-supervised =================
        # Only between consecutive VALID fixes. No forward-fill anywhere.
        fix = (S.gps_is_fix & S.gps_valid).to_numpy()
        fi = np.flatnonzero(fix)
        gps_pairs = 0
        if len(fi) >= 2:
            la = S.gps_latitude.to_numpy(float)
            lo = S.gps_longitude.to_numpy(float)
            d = haversine(la[fi[:-1]], lo[fi[:-1]], la[fi[1:]], lo[fi[1:]])
            dts = t[fi[1:]] - t[fi[:-1]]
            brg = bearing(la[fi[:-1]], lo[fi[:-1]], la[fi[1:]], lo[fi[1:]])
            dhead = np.r_[np.nan, wrap180(np.diff(brg))]
            with np.errstate(invalid='ignore', divide='ignore'):
                spd = np.where(dts > 0, d / dts, np.nan)
            good = np.isfinite(spd) & (dts > 0) & (dts < 60) & (spd < 70)  # <252 km/h
            dest = fi[1:]                      # target attaches to the closing fix
            acc = S.gps_accuracy_m.to_numpy(float)[dest]
            sats = S.gps_satellites_used.to_numpy(float)[dest]
            conf = np.where(good & (acc <= 10) & (sats >= 6) & (dts <= 12), 'high',
                            np.where(good & (acc <= 20), 'medium', 'low'))
            fill = T.target_source.to_numpy() == 'none'
            sel = dest[fill[dest] & good]
            selmask = fill[dest] & good
            T.loc[sel, 'target_displacement_m'] = d[selmask]
            T.loc[sel, 'target_dt_s'] = dts[selmask]
            T.loc[sel, 'target_v_forward'] = spd[selmask]
            # velocity is along the travel direction by construction -> lateral is 0
            T.loc[sel, 'target_v_lateral'] = 0.0   # velocity is along travel direction
            T.loc[sel, 'target_delta_heading_deg'] = dhead[selmask]
            with np.errstate(invalid='ignore', divide='ignore'):
                T.loc[sel, 'target_yaw_rate'] = np.radians(dhead[selmask]) / dts[selmask]
            T.loc[sel, 'target_source'] = 'gps'
            T.loc[sel, 'target_valid'] = True
            T.loc[sel, 'target_confidence'] = conf[selmask]
            gps_pairs = int(len(sel))

        T.to_parquet(os.path.join(TGT, f'{sess}.parquet'), index=False)
        nv = int(T.target_valid.sum())
        rows.append(dict(
            session_id=sess, dataset_id=c.dataset_id, group=c.group,
            driver_id=c.driver_id, phone_id=c.phone_id, n_rows=n,
            duration_s=round(float(t[-1] - t[0]), 1) if n > 1 else 0.0,
            strategy=('A_vbox' if sess in vbox_sessions else
                      ('B_gps' if gps_pairs else 'none')),
            n_target_valid=nv, pct_target_valid=round(100 * nv / max(1, n), 2),
            n_vbox_targets=int((T.target_source == 'vbox').sum()),
            n_gps_targets=gps_pairs,
            conf_high=int((T.target_confidence == 'high').sum()),
            conf_medium=int((T.target_confidence == 'medium').sum()),
            conf_low=int((T.target_confidence == 'low').sum()),
            sync_confidence=(sync[sync.session_id == sess].confidence.iloc[0]
                             if (sync.session_id == sess).any() else ''),
            gyro_transform_usable=(bool(val.loc[sess].gyro_transform_usable)
                                   if sess in val.index else False),
            acc_transform_usable=(bool(val.loc[sess].acc_transform_usable)
                                  if sess in val.index else False)))
    print('.', end='', flush=True)

sm = pd.DataFrame(rows)
sm.to_csv(os.path.join(OUT, 'target_summary.csv'), index=False)
pd.set_option('display.width', 250)
print(f"\nsessions with targets: {len(sm)}")
print(sm.strategy.value_counts().to_string())
print("\nVBOX-supervised rows:", int(sm.n_vbox_targets.sum()),
      "| GPS-supervised targets:", int(sm.n_gps_targets.sum()))
print("\nconfidence totals: high=%d medium=%d low=%d" %
      (sm.conf_high.sum(), sm.conf_medium.sum(), sm.conf_low.sum()))
print("\nGPS-only sessions target density (%% of rows carrying a target):")
b = sm[sm.strategy == 'B_gps']
print(b.pct_target_valid.describe().round(3).to_string())
