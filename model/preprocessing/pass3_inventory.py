"""Pass 3: full per-dataset inventory (Tasks 1, 5, 6, 7).

Read-only with respect to the raw dataset. Emits outputs/raw_inventory.csv.
Sensor availability is determined from ACTUAL parsed CSV data, never from the README.
"""
import os, re, json
import numpy as np
import pandas as pd
from common import (ROOT, OUT, SY, UN, norm, map_cols, load_raw,
                    parse_s_date, parse_sats)

files = json.load(open(os.path.join(OUT, 'pass1_files.json'), encoding='utf-8'))
for f in files:
    f['id'] = os.path.splitext(f['filename'])[0]
    up = [norm(c) for c in f['cols']]
    f['kind'] = 'V' if 'NO OF GPS SATELLITES AVAILABLE' in up else 'S'

# ---- registry: one entry per unique (id, variant) --------------------------
reg = {}
for f in files:
    i = f['id'].lower()
    if f['kind'] == 'S':
        var = 'S'
    else:
        var = 'V_sync' if f['tree'] == SY else 'V_full'
    key = (i, var)
    reg.setdefault(key, {'id': f['id'], 'variant': var, 'kind': f['kind'], 'paths': []})
    reg[key]['paths'].append(f['rel_path'])


def group_of(i):
    b = re.sub(r'^[sv]-', '', i.lower())
    for g in ['vta', 'vtb', 'vfa', 'vfb', 'vw', 'st', 's', 'm', 'y', 't', 'a', 'i']:
        if b.startswith(g):
            return g
    return '?'


DRIVER = {'s': 'A', 'm': 'B', 'st': 'C', 'y': 'D', 'vta': 'E', 'vtb': 'E',
          'vfa': 'E', 'vfb': 'E', 'vw': 'E', 't': 'F', 'i': 'G', 'a': 'H'}
VEH = {'A': 'FordFiestaTitanium', 'B': 'FordFiestaTitanium', 'C': 'FordFiestaTitanium',
       'D': 'FordFiestaTitanium', 'E': 'FordFiestaTitanium', 'F': 'RenaultMegane',
       'G': 'ToyotaCorollaVerso', 'H': 'VolvoXC70'}
PHONE = {'A': 'HuaweiP20Pro', 'B': 'HuaweiP20Pro', 'C': 'HuaweiP20Pro',
         'D': 'HuaweiP20Pro', 'E': 'HuaweiP20Pro', 'F': 'MotorolaMotoG7Power',
         'G': 'HuaweiP20Pro', 'H': 'BlackberryPriv'}

rows = []
for (i, var), e in sorted(reg.items()):
    rel = sorted(e['paths'])[0]
    df = load_raw(rel)
    raw_cols = list(df.columns)
    df = df.loc[:, [c for c in df.columns if c.strip() != '']]
    m = map_cols(list(df.columns), e['kind'])
    unmapped = [c for c, v in m.items() if v is None]
    df2 = df.rename(columns={c: v for c, v in m.items() if v})
    dup_canon = sorted({c for c in df2.columns if list(df2.columns).count(c) > 1})
    if dup_canon:
        df2 = df2.loc[:, ~df2.columns.duplicated(keep='first')]
    g = group_of(i)
    drv = DRIVER.get(g, '?')
    r = dict(dataset_id=e['id'], variant=var, kind=e['kind'], group=g, driver_id=drv,
             vehicle_id=VEH.get(drv, '?'),
             phone_id=PHONE.get(drv, '?') if e['kind'] == 'S' else '',
             n_copies=len(e['paths']), canonical_path=rel,
             all_paths='|'.join(sorted(e['paths'])),
             n_rows=len(df), n_cols=len(raw_cols),
             columns_raw='|'.join(raw_cols), unmapped_columns='|'.join(unmapped),
             file_size_bytes=os.path.getsize(os.path.join(ROOT, rel)),
             duplicate_canonical_cols='|'.join(dup_canon))
    num = df2.apply(pd.to_numeric, errors='coerce')

    # ---- missing / duplicates / inf
    miss = {c: int(num[c].isna().sum()) for c in num.columns}
    r['missing_total'] = int(sum(miss.values()))
    r['missing_pct_max'] = round(100 * max(miss.values()) / max(1, len(df)), 4) if miss else 0
    r['cols_with_missing'] = '|'.join(f"{c}:{v}" for c, v in miss.items() if v)
    r['duplicate_rows'] = int(df.duplicated().sum())
    with np.errstate(invalid='ignore'):
        r['inf_values'] = int(np.isinf(num.to_numpy(dtype='float64')).sum())

    # ---- timestamps
    if e['kind'] == 'S':
        tms = pd.to_numeric(df2.get('t_ms'), errors='coerce')
        ts, ok = parse_s_date(df2['date_raw'] if 'date_raw' in df2 else pd.Series([''] * len(df)))
        r['timestamp_col'] = 'TIME SINCE START (ms) [+ DATE wall clock]'
        r['date_parse_fail'] = int((~ok).sum())
        t = tms / 1000.0
        r['wall_start'] = pd.to_datetime(ts[ok].min(), unit='s').isoformat() if ok.any() else ''
        r['wall_end'] = pd.to_datetime(ts[ok].max(), unit='s').isoformat() if ok.any() else ''
    else:
        t = pd.to_numeric(df2.get('v_tod_s'), errors='coerce')
        r['timestamp_col'] = 'Time Since Start of Day (seconds)'
        r['date_parse_fail'] = 0
        r['wall_start'] = str(round(float(t.min()), 2))
        r['wall_end'] = str(round(float(t.max()), 2))
    r['t_monotonic'] = bool(t.is_monotonic_increasing)
    r['duplicate_timestamps'] = int(t.duplicated().sum())
    dt = t.sort_values().diff().dropna()
    if len(dt):
        r.update(dt_min=round(float(dt.min()), 6), dt_max=round(float(dt.max()), 4),
                 dt_mean=round(float(dt.mean()), 6), dt_std=round(float(dt.std()), 6),
                 dt_median=round(float(dt.median()), 6),
                 rate_hz=round(1 / float(dt.median()), 4) if dt.median() > 0 else 0,
                 dt_zero=int((dt == 0).sum()),
                 gaps_gt_0p5s=int((dt > 0.5).sum()), gaps_gt_2s=int((dt > 2).sum()),
                 abnormal_dt=int(((dt < 0.05) | (dt > 0.15)).sum()),
                 duration_s=round(float(t.max() - t.min()), 2))

    # ---- sensor availability, from real parsed values
    def has(cols):
        return all(c in df2.columns and pd.to_numeric(df2[c], errors='coerce').notna().any()
                   for c in cols)

    r['has_acc'] = has(['acc_x', 'acc_y', 'acc_z'])
    r['has_gyro'] = has(['gyro_x', 'gyro_y', 'gyro_z'])
    r['has_gravity'] = has(['gravity_x', 'gravity_y', 'gravity_z'])
    r['has_mag'] = has(['mag_x', 'mag_y', 'mag_z'])
    r['has_orientation'] = has(['ori_azimuth_deg', 'ori_pitch_deg', 'ori_roll_deg'])
    r['has_gps'] = has(['gps_latitude', 'gps_longitude']) or has(['v_latitude', 'v_longitude'])
    r['has_gps_accuracy'] = has(['gps_accuracy_m'])
    r['has_vehicle_fields'] = (e['kind'] == 'V')

    if e['kind'] == 'S':
        sa, st_ = parse_sats(df2['gps_sats_raw'] if 'gps_sats_raw' in df2 else pd.Series([''] * len(df)))
        r['has_gps_satellites'] = bool(sa.notna().any())
        r['sats_mean'] = round(float(sa.mean()), 2) if sa.notna().any() else ''
        lat = pd.to_numeric(df2.get('gps_latitude'), errors='coerce')
        lon = pd.to_numeric(df2.get('gps_longitude'), errors='coerce')
        spd = pd.to_numeric(df2.get('gps_speed_kmh'), errors='coerce')
        acc = pd.to_numeric(df2.get('gps_accuracy_m'), errors='coerce')
    else:
        sa = pd.to_numeric(df2.get('v_gps_sats'), errors='coerce')
        r['has_gps_satellites'] = bool(sa.notna().any())
        r['sats_mean'] = round(float(sa.mean()), 2) if sa.notna().any() else ''
        lat = pd.to_numeric(df2.get('v_latitude'), errors='coerce')
        lon = pd.to_numeric(df2.get('v_longitude'), errors='coerce')
        spd = pd.to_numeric(df2.get('v_velocity_kmh'), errors='coerce')
        acc = pd.Series(np.nan, index=df2.index)

    # ---- GPS behaviour: detect ACTUAL fix instants via value changes
    if lat is not None and lat.notna().any():
        chg = (lat.diff().abs() > 0) | (lon.diff().abs() > 0)
        idx = np.flatnonzero(chg.to_numpy())
        tv = t.to_numpy(dtype='float64')
        if len(idx) > 2:
            gi = np.diff(tv[idx])
            gi = gi[np.isfinite(gi)]
            if len(gi):
                r['gps_update_median_s'] = round(float(np.median(gi)), 4)
                r['gps_update_max_s'] = round(float(np.max(gi)), 3)
                r['gps_outages_gt5s'] = int((gi > 5).sum())
        r['gps_fix_count'] = int(len(idx))
        r['gps_hold_ratio'] = round(1 - len(idx) / max(1, len(df)), 4)
        r['gps_acc_mean'] = round(float(acc.mean()), 3) if acc.notna().any() else ''
        r['gps_acc_max'] = round(float(acc.max()), 3) if acc.notna().any() else ''
        r['lat_min'] = round(float(lat.min()), 6)
        r['lat_max'] = round(float(lat.max()), 6)
        r['lon_min'] = round(float(lon.min()), 6)
        r['lon_max'] = round(float(lon.max()), 6)
        r['lat_lon_zero_rows'] = int(((lat == 0) & (lon == 0)).sum())

    # ---- motion / stationarity, measured
    if spd is not None and spd.notna().any():
        r['speed_max_kmh'] = round(float(spd.max()), 3)
        r['speed_mean_kmh'] = round(float(spd.mean()), 3)
    if r['has_gyro']:
        gm = np.sqrt(sum(pd.to_numeric(df2[c], errors='coerce') ** 2
                         for c in ['gyro_x', 'gyro_y', 'gyro_z']))
        am = np.sqrt(sum(pd.to_numeric(df2[c], errors='coerce') ** 2
                         for c in ['acc_x', 'acc_y', 'acc_z']))
        r['gyro_mag_mean'] = round(float(gm.mean()), 5)
        r['gyro_mag_std'] = round(float(gm.std()), 5)
        r['acc_mag_mean'] = round(float(am.mean()), 4)
        r['acc_mag_std'] = round(float(am.std()), 4)
    rows.append(r)
    print('.', end='', flush=True)

inv = pd.DataFrame(rows)
inv.to_csv(os.path.join(OUT, 'raw_inventory.csv'), index=False)
print("\nwrote raw_inventory.csv", inv.shape)
print(inv.groupby(['kind', 'variant']).size())
