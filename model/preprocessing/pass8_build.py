"""Pass 8 (Tasks 3, 5, 6, 7, 8, 10, 11, 12, 13): build the canonical output datasets.

Writes, WITHOUT modifying any raw file:
    smartphone_core/      core schema, every usable smartphone dataset
    smartphone_enhanced/  core + magnetometer + orientation, where present
    vehicle_reference/    V/VBOX datasets, kept strictly separate
    calibration/          stationary recordings + per-session bias estimates
    outputs/outlier_report.csv
"""
import os, json, re
import numpy as np
import pandas as pd
from common import ROOT, OUT, load_raw, map_cols, parse_s_date, parse_sats

BASE = os.path.dirname(OUT)
DIRS = {k: os.path.join(BASE, k) for k in
        ['smartphone_core', 'smartphone_enhanced', 'vehicle_reference', 'calibration']}
for d in DIRS.values():
    os.makedirs(d, exist_ok=True)

inv = pd.read_csv(os.path.join(OUT, 'raw_inventory.csv'))
cm = pd.read_csv(os.path.join(OUT, 'compatibility_matrix.csv'))
calb = pd.read_csv(os.path.join(OUT, 'calibration_bias.csv'))

CORE = ['timestamp_s', 'acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z',
        'gravity_x', 'gravity_y', 'gravity_z', 'linear_acc_x', 'linear_acc_y', 'linear_acc_z',
        'gps_latitude', 'gps_longitude', 'gps_speed_kmh', 'gps_accuracy_m',
        'gps_satellites_used', 'gps_satellites_visible', 'gps_is_fix', 'gps_valid',
        'gps_quality', 'wall_time_local', 'dataset_id', 'driver_id', 'vehicle_id',
        'phone_id', 'session_id', 'row_index_original']
ENH = ['mag_x', 'mag_y', 'mag_z', 'ori_azimuth_deg', 'ori_pitch_deg', 'ori_roll_deg']

GAP_SPLIT_S = 5.0        # a jump this large means the recording paused -> new session
MAX_PLAUSIBLE_KMH = 250  # Ford Fiesta / Volvo on public roads


def prep(r):
    """Canonical frame for one dataset. Applies the S-A4 column-shift repair."""
    if str(r.dataset_id).upper() == 'S-A4':
        names = [c for c in load_raw(r.canonical_path).columns if c.strip() != '']
        raw = pd.read_csv(os.path.join(ROOT, r.canonical_path), encoding='latin-1',
                          header=None, skiprows=1, low_memory=False)
        if raw.shape[1] == 25 and raw[6].isna().all():
            raw = raw.drop(columns=[6])
            raw.columns = names[:raw.shape[1]]
            d = raw
        else:
            d = load_raw(r.canonical_path)
    else:
        d = load_raw(r.canonical_path)
    d = d.loc[:, [c for c in d.columns if str(c).strip() != '']]
    m = map_cols(list(d.columns), r.kind)
    d = d.rename(columns={c: v for c, v in m.items() if v})
    return d.loc[:, ~d.columns.duplicated(keep='first')]


def haversine(la1, lo1, la2, lo2):
    R = 6371000.0
    p1, p2 = np.radians(la1), np.radians(la2)
    dp, dl = p2 - p1, np.radians(lo2 - lo1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


outliers, built = [], []
S_use = cm[(cm.kind == 'S') & (cm.group.isin(['B', 'C', 'E']))]

for _, c in S_use.iterrows():
    r = inv[(inv.dataset_id == c.dataset_id) & (inv.kind == 'S')].iloc[0]
    d = prep(r)
    n = len(d)
    out = pd.DataFrame(index=range(n))
    out['row_index_original'] = np.arange(n)

    # ---- time: preserve the original device clock, never re-synthesise it
    t = pd.to_numeric(d['t_ms'], errors='coerce') / 1000.0
    out['timestamp_s'] = t.values
    ts, ok = parse_s_date(d['date_raw']) if 'date_raw' in d else (pd.Series(np.nan, index=d.index), pd.Series(False, index=d.index))
    out['wall_time_local'] = pd.to_datetime(ts, unit='s').values

    for a in 'xyz':
        out[f'acc_{a}'] = pd.to_numeric(d[f'acc_{a}'], errors='coerce').values
        out[f'gyro_{a}'] = pd.to_numeric(d[f'gyro_{a}'], errors='coerce').values
        out[f'gravity_{a}'] = pd.to_numeric(d[f'gravity_{a}'], errors='coerce').values
        # validated on stationary samples: accelerometer INCLUDES gravity, same sign
        out[f'linear_acc_{a}'] = out[f'acc_{a}'] - out[f'gravity_{a}']

    out['gps_latitude'] = pd.to_numeric(d.get('gps_latitude'), errors='coerce').values
    out['gps_longitude'] = pd.to_numeric(d.get('gps_longitude'), errors='coerce').values
    out['gps_speed_kmh'] = pd.to_numeric(d.get('gps_speed_kmh'), errors='coerce').values
    out['gps_accuracy_m'] = pd.to_numeric(d.get('gps_accuracy_m'), errors='coerce').values
    if 'gps_sats_raw' in d:
        used, vis = parse_sats(d['gps_sats_raw'])
        out['gps_satellites_used'] = used.values
        out['gps_satellites_visible'] = vis.values
    else:
        out['gps_satellites_used'] = np.nan
        out['gps_satellites_visible'] = np.nan

    for e in ENH:
        out[e] = pd.to_numeric(d[e], errors='coerce').values if e in d else np.nan

    # ---- session segmentation.
    # A handful of datasets (S-M, S-S2, S-S3b, S-S4, S-Y1) contain one or more BACKWARD
    # time jumps: the device clock reset, or two recordings were concatenated. Globally
    # sorting by timestamp would interleave those independent segments and destroy the
    # GPS hold structure, so sessions are cut at backward jumps and at long forward gaps
    # in ORIGINAL row order, and each session is sorted only within itself.
    dt = out.timestamp_s.diff()
    cut = (dt < 0) | (dt > GAP_SPLIT_S)
    out['session_id'] = (c.dataset_id + '_s' +
                         cut.cumsum().astype(int).astype(str).str.zfill(2))
    out = (out.sort_values(['session_id', 'timestamp_s', 'row_index_original'],
                           kind='mergesort').reset_index(drop=True))

    # ---- GPS: a real fix is only where the reported position CHANGED (Task 6)
    lat, lon = out.gps_latitude, out.gps_longitude
    g = out.session_id
    is_fix = ((lat.groupby(g).diff().abs() > 0) | (lon.groupby(g).diff().abs() > 0))
    # the first row of each session is a fix if it carries a position at all
    first = ~g.duplicated()
    is_fix = is_fix.fillna(False) | (first & lat.notna())
    out['gps_is_fix'] = is_fix.values

    fx = out[out.gps_is_fix]
    fx = fx.assign(session_id=out.loc[fx.index,'session_id'])
    q = pd.Series('ok', index=out.index, dtype=object)
    valid = pd.Series(True, index=out.index)
    # 1. absent / null island
    bad_null = lat.isna() | lon.isna() | ((lat == 0) & (lon == 0))
    q[bad_null] = 'no_fix'; valid[bad_null] = False
    # 2. poor reported accuracy
    bad_acc = out.gps_accuracy_m > 20
    q[bad_acc & ~bad_null] = 'poor_accuracy'; valid[bad_acc] = False
    # 3. too few satellites
    bad_sat = out.gps_satellites_used < 4
    q[bad_sat & ~bad_null & ~bad_acc] = 'few_satellites'; valid[bad_sat] = False
    # 4. physically impossible jump between consecutive real fixes
    n_jump = 0
    all_dtf = []
    for _, fs in fx.groupby(fx.session_id):      # never compare fixes across sessions
        if len(fs) < 2:
            continue
        dd = haversine(fs.gps_latitude.values[:-1], fs.gps_longitude.values[:-1],
                       fs.gps_latitude.values[1:], fs.gps_longitude.values[1:])
        dtf = np.diff(fs.timestamp_s.values)
        all_dtf.append(dtf)
        with np.errstate(divide='ignore', invalid='ignore'):
            implied = np.where(dtf > 0, dd / dtf * 3.6, np.nan)
        jump_idx = fs.index[1:][np.nan_to_num(implied) > MAX_PLAUSIBLE_KMH]
        n_jump += len(jump_idx)
        q[jump_idx] = 'impossible_jump'
        valid[jump_idx] = False
    if all_dtf:
        cat = np.concatenate(all_dtf)
        med = float(np.median(cat)) if len(cat) else np.nan
        if np.isfinite(med) and med > 0:
            for _, fs in fx.groupby(fx.session_id):
                if len(fs) < 2:
                    continue
                dtf = np.diff(fs.timestamp_s.values)
                out_idx = fs.index[1:][dtf > max(5 * med, 30)]
                q[out_idx] = 'post_outage'
                valid[out_idx] = False
    out['gps_quality'] = q.values
    out['gps_valid'] = valid.values

    out['dataset_id'] = c.dataset_id
    out['driver_id'] = c.driver_id
    out['vehicle_id'] = c.vehicle_id
    out['phone_id'] = c.phone_id

    # ---- outlier report (Task 11): flag, never delete
    lin = out[['linear_acc_x', 'linear_acc_y', 'linear_acc_z']].to_numpy(float)
    gyr = out[['gyro_x', 'gyro_y', 'gyro_z']].to_numpy(float)
    lmag, gmag = np.linalg.norm(lin, axis=1), np.linalg.norm(gyr, axis=1)
    outliers.append(dict(
        dataset_id=c.dataset_id, group=c.group, driver_id=c.driver_id, phone_id=c.phone_id,
        n_rows=n, sessions=out.session_id.nunique(),
        lin_acc_p999=round(float(np.nanpercentile(lmag, 99.9)), 3),
        lin_acc_max=round(float(np.nanmax(lmag)), 3),
        n_lin_acc_gt_20=int((lmag > 20).sum()),
        n_lin_acc_gt_78=int((lmag > 78.4).sum()),
        gyro_p999=round(float(np.nanpercentile(gmag, 99.9)), 4),
        gyro_max=round(float(np.nanmax(gmag)), 4),
        n_gyro_gt_5=int((gmag > 5).sum()),
        n_gps_invalid=int((~out.gps_valid).sum()),
        pct_gps_invalid=round(100 * float((~out.gps_valid).mean()), 2),
        n_gps_jump=n_jump, n_gps_fix=int(out.gps_is_fix.sum()),
        gps_hold_pct=round(100 * (1 - float(out.gps_is_fix.mean())), 2)))

    dest = DIRS['calibration'] if c.group == 'E' else DIRS['smartphone_core']
    out[CORE].to_parquet(os.path.join(dest, f'{c.dataset_id}.parquet'), index=False)
    if c.group in ('B', 'E') and out[ENH].notna().any().any():
        out[CORE + ENH].to_parquet(
            os.path.join(DIRS['smartphone_enhanced'], f'{c.dataset_id}.parquet'), index=False)
    built.append((c.dataset_id, c.group, n))
    print('.', end='', flush=True)

# ---- vehicle reference, kept separate (Task 4)
for _, r in inv[inv.kind == 'V'].iterrows():
    d = prep(r)
    d = d.apply(pd.to_numeric, errors='coerce')
    d['dataset_id'] = r.dataset_id
    d['variant'] = r.variant
    d['driver_id'] = r.driver_id
    d['vehicle_id'] = r.vehicle_id
    d.to_parquet(os.path.join(DIRS['vehicle_reference'],
                              f'{r.dataset_id}__{r.variant}.parquet'), index=False)

pd.DataFrame(outliers).to_csv(os.path.join(OUT, 'outlier_report.csv'), index=False)
calb.to_csv(os.path.join(DIRS['calibration'], 'sensor_bias_estimates.csv'), index=False)
print(f"\nbuilt {len(built)} smartphone datasets; "
      f"core={sum(1 for b in built if b[1] != 'E')} calibration={sum(1 for b in built if b[1] == 'E')}")
print("vehicle_reference files:", len(os.listdir(DIRS['vehicle_reference'])))
print("enhanced files:", len(os.listdir(DIRS['smartphone_enhanced'])))
