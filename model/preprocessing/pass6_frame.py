"""Pass 6 (Task 9): derive the smartphone -> vehicle axis relationship EXPERIMENTALLY.

Uses the row-aligned synchronised S/V pairs. The vehicle ECU gives ground-truth
longitudinal acceleration, lateral acceleration and yaw rate; correlating those
against the phone's linear-acceleration and gyroscope axes shows which phone axis
carries forward / lateral / vertical motion. No rotation matrix is invented.
"""
import os, re
import numpy as np
import pandas as pd
from common import ROOT, OUT, load_raw, map_cols

G = 9.80665
inv = pd.read_csv(os.path.join(OUT, 'raw_inventory.csv'))
syn = pd.read_csv(os.path.join(OUT, 'sv_synchronisation_final.csv'))
pairs = syn[syn.verdict.str.startswith('SYNC_ROW_ALIGNED')]


def base(i):
    return re.sub(r'^[sv]-', '', str(i).lower())


Si = inv[inv.kind == 'S'].set_index(inv[inv.kind == 'S'].dataset_id.map(base))
Vi = inv[inv.variant == 'V_sync'].set_index(inv[inv.variant == 'V_sync'].dataset_id.map(base))


def prep(r):
    d = load_raw(r.canonical_path)
    d = d.loc[:, [c for c in d.columns if c.strip() != '']]
    m = map_cols(list(d.columns), r.kind)
    d = d.rename(columns={c: v for c, v in m.items() if v})
    return d.loc[:, ~d.columns.duplicated(keep='first')]


rows = []
for b in pairs.pair_base:
    if b not in Si.index or b not in Vi.index:
        continue
    s, v = prep(Si.loc[b]), prep(Vi.loc[b])
    n = min(len(s), len(v))
    if n < 300:
        continue
    s, v = s.iloc[:n], v.iloc[:n]
    num = lambda df, c: pd.to_numeric(df[c], errors='coerce').to_numpy(dtype='float64')
    lin = {a: num(s, f'acc_{a}') - num(s, f'gravity_{a}') for a in 'xyz'}
    gyr = {a: num(s, f'gyro_{a}') for a in 'xyz'}
    v_long = num(v, 'v_acc_long_g') * G          # g -> m/s^2
    v_lat = num(v, 'v_acc_lat_g') * G
    v_yaw = np.radians(num(v, 'v_yaw_rate_dps'))  # deg/s -> rad/s
    v_spd = num(v, 'v_velocity_kmh')
    if np.nanstd(v_spd) < 1:      # skip stationary pairs; no motion to correlate
        continue

    def cor(a, c):
        m = np.isfinite(a) & np.isfinite(c)
        if m.sum() < 100 or np.nanstd(a[m]) < 1e-9 or np.nanstd(c[m]) < 1e-9:
            return np.nan
        return float(np.corrcoef(a[m], c[m])[0, 1])

    e = {'pair_base': b, 'n': n, 'driver_id': Si.loc[b, 'driver_id'],
         'phone_id': Si.loc[b, 'phone_id']}
    for a in 'xyz':
        e[f'r_lin{a}_vlong'] = round(cor(lin[a], v_long), 3)
        e[f'r_lin{a}_vlat'] = round(cor(lin[a], v_lat), 3)
        e[f'r_gyro{a}_vyaw'] = round(cor(gyr[a], v_yaw), 3)
    rows.append(e)
    print('.', end='', flush=True)

df = pd.DataFrame(rows)
df.to_csv(os.path.join(OUT, 'axis_correlation.csv'), index=False)
print(f"\npairs analysed: {len(df)}")
cols = [c for c in df.columns if c.startswith('r_')]
print("\n=== median correlation across synchronised pairs ===")
print(df[cols].median().round(3).to_string())
print("\n=== which phone axis best matches each vehicle channel (|r| median) ===")
for tgt in ['vlong', 'vlat']:
    sub = {a: df[f'r_lin{a}_{tgt}'].abs().median() for a in 'xyz'}
    print(f"  vehicle {tgt:6s} -> lin_{max(sub, key=sub.get)}  " +
          " ".join(f"{a}:{sub[a]:.3f}" for a in 'xyz'))
sub = {a: df[f'r_gyro{a}_vyaw'].abs().median() for a in 'xyz'}
print(f"  vehicle yawrate -> gyro_{max(sub, key=sub.get)}  " +
      " ".join(f"{a}:{sub[a]:.3f}" for a in 'xyz'))
print("\n=== sign consistency (fraction of pairs with positive r) ===")
for c in cols:
    s = df[c].dropna()
    print(f"  {c:16s} median={s.median():+.3f}  frac_positive={np.mean(s > 0):.2f}  n={len(s)}")
