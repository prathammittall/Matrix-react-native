"""Pass 5 (Tasks 7, 8, 9): stationary detection, sensor-bias estimation,
gravity-semantics validation and coordinate-frame analysis.

Nothing here modifies raw files. All conclusions are drawn from measured values.
"""
import os
import numpy as np
import pandas as pd
from common import ROOT, OUT, load_raw, map_cols, parse_s_date

inv = pd.read_csv(os.path.join(OUT, 'raw_inventory.csv'))
S = inv[inv.kind == 'S']

G_NOM = 9.80665


def prep(r):
    d = load_raw(r.canonical_path)
    d = d.loc[:, [c for c in d.columns if c.strip() != '']]
    # S-A4 has one spurious empty field per data row, shifting columns right by 1
    if str(r.dataset_id).upper() == 'S-A4':
        raw = pd.read_csv(os.path.join(ROOT, r.canonical_path), encoding='latin-1',
                          header=None, skiprows=1, low_memory=False)
        if raw.shape[1] == 25 and raw[6].isna().all():
            names = [c for c in load_raw(r.canonical_path).columns if c.strip() != '']
            raw = raw.drop(columns=[6])
            raw.columns = names[:raw.shape[1]]
            d = raw
    m = map_cols(list(d.columns), r.kind)
    d = d.rename(columns={c: v for c, v in m.items() if v})
    return d.loc[:, ~d.columns.duplicated(keep='first')]


rows = []
for _, r in S.iterrows():
    d = prep(r)
    need = ['acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z',
            'gravity_x', 'gravity_y', 'gravity_z']
    if not all(c in d.columns for c in need):
        continue
    n = {c: pd.to_numeric(d[c], errors='coerce') for c in need}
    spd = pd.to_numeric(d.get('gps_speed_kmh'), errors='coerce')
    acc = np.c_[n['acc_x'], n['acc_y'], n['acc_z']]
    gyr = np.c_[n['gyro_x'], n['gyro_y'], n['gyro_z']]
    grv = np.c_[n['gravity_x'], n['gravity_y'], n['gravity_z']]
    amag, gmag, vmag = (np.linalg.norm(x, axis=1) for x in (acc, gyr, grv))

    e = dict(dataset_id=r.dataset_id, driver_id=r.driver_id, phone_id=r.phone_id,
             n_rows=len(d))
    e['gravity_norm_mean'] = round(float(np.nanmean(vmag)), 5)
    e['gravity_norm_std'] = round(float(np.nanstd(vmag)), 5)
    e['acc_norm_mean'] = round(float(np.nanmean(amag)), 5)

    # ---- stationary mask: near-zero GPS speed + quiet gyro + |acc| close to g.
    # Thresholds calibrated on the three known-stationary recordings (S-Vw1, S-Vw15,
    # S-I): with the engine running, vibration gives rolling gyro sd ~0.02 rad/s and
    # rolling |acc| sd ~0.09 m/s^2, so a 0.01 threshold would wrongly reject them.
    win = 25
    gy_roll = pd.Series(gmag).rolling(win, center=True, min_periods=5).std()
    ac_roll = pd.Series(amag).rolling(win, center=True, min_periods=5).std()
    quiet = (gy_roll < 0.03) & (ac_roll < 0.20)
    slow = (spd.fillna(9e9) < 0.5) if spd is not None else pd.Series(False, index=range(len(d)))
    st = (quiet & slow).to_numpy()
    e['stationary_frac'] = round(float(np.nanmean(st)), 4)
    e['stationary_samples'] = int(np.nansum(st))
    e['speed_max_kmh'] = round(float(np.nanmax(spd)), 3) if spd is not None and spd.notna().any() else np.nan
    e['is_stationary_dataset'] = bool(e['stationary_frac'] > 0.9)

    if st.sum() >= 50:
        sa, sg, sv = acc[st], gyr[st], grv[st]
        # gyro bias = mean gyro while stationary (true rate ~ earth rate, negligible)
        for i, ax in enumerate('xyz'):
            e[f'gyro_bias_{ax}'] = round(float(np.nanmean(sg[:, i])), 6)
            e[f'gyro_noise_{ax}'] = round(float(np.nanstd(sg[:, i])), 6)
        # ---- GRAVITY SEMANTICS (Task 8): test acc - gravity vs acc + gravity
        res_sub = sa - sv
        res_add = sa + sv
        e['stat_resid_sub_norm_mean'] = round(float(np.nanmean(np.linalg.norm(res_sub, axis=1))), 5)
        e['stat_resid_add_norm_mean'] = round(float(np.nanmean(np.linalg.norm(res_add, axis=1))), 5)
        e['stat_acc_norm_mean'] = round(float(np.nanmean(np.linalg.norm(sa, axis=1))), 5)
        e['stat_grav_norm_mean'] = round(float(np.nanmean(np.linalg.norm(sv, axis=1))), 5)
        # cosine between acc and gravity while stationary: +1 => same direction
        cs = np.sum(sa * sv, axis=1) / (np.linalg.norm(sa, axis=1) * np.linalg.norm(sv, axis=1) + 1e-12)
        e['stat_cos_acc_gravity'] = round(float(np.nanmean(cs)), 5)
        # accelerometer bias = residual after removing gravity, while stationary
        for i, ax in enumerate('xyz'):
            e[f'acc_bias_{ax}'] = round(float(np.nanmean(res_sub[:, i])), 6)
            e[f'acc_noise_{ax}'] = round(float(np.nanstd(res_sub[:, i])), 6)
        # ---- COORDINATE FRAME (Task 9): mean gravity direction = phone tilt
        gu = np.nanmean(sv, axis=0)
        gu = gu / (np.linalg.norm(gu) + 1e-12)
        e['grav_unit_x'], e['grav_unit_y'], e['grav_unit_z'] = [round(float(v), 4) for v in gu]
        e['tilt_from_vertical_deg'] = round(float(np.degrees(np.arccos(np.clip(gu[2], -1, 1)))), 2)
    rows.append(e)
    print('.', end='', flush=True)

cal = pd.DataFrame(rows)
cal.to_csv(os.path.join(OUT, 'calibration_bias.csv'), index=False)
print("\nwrote calibration_bias.csv", cal.shape)

print("\n=== stationary datasets (>90% stationary) ===")
sd = cal[cal.is_stationary_dataset]
print(sd[['dataset_id', 'driver_id', 'phone_id', 'n_rows', 'stationary_frac',
          'speed_max_kmh']].to_string(index=False))

print("\n=== GRAVITY SEMANTICS across datasets with >=50 stationary samples ===")
g = cal.dropna(subset=['stat_resid_sub_norm_mean'])
print(f"datasets tested: {len(g)}")
print(g[['stat_acc_norm_mean', 'stat_grav_norm_mean', 'stat_resid_sub_norm_mean',
         'stat_resid_add_norm_mean', 'stat_cos_acc_gravity']].describe().round(4).to_string())

print("\n=== phone tilt (gravity unit vector) by phone ===")
print(cal.dropna(subset=['grav_unit_z']).groupby('phone_id')[
    ['grav_unit_x', 'grav_unit_y', 'grav_unit_z', 'tilt_from_vertical_deg']].describe().round(3)
    .loc[:, (slice(None), ['mean', 'min', 'max'])].to_string())
