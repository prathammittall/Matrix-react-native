"""Pass 7 (Tasks 2, 3, 13): compatibility matrix, canonical column mapping and
rejected-dataset list. Classification is driven by measured inventory facts.
"""
import os, json, re
import numpy as np
import pandas as pd
from common import OUT, CANON, V_CANON, load_raw, map_cols, norm

inv = pd.read_csv(os.path.join(OUT, 'raw_inventory.csv'))
cal = pd.read_csv(os.path.join(OUT, 'calibration_bias.csv')).set_index('dataset_id')
syn = pd.read_csv(os.path.join(OUT, 'sv_synchronisation_final.csv'))

STATIONARY = set(cal[cal.is_stationary_dataset].index)
# >25% exact duplicate rows AND a collapsed (~1 ms) median sampling interval
BROKEN = set(inv[(inv.kind == 'S') & (inv.duplicate_rows / inv.n_rows > 0.25)
                 & (inv.dt_median < 0.01)].dataset_id)
REPAIR = {'S-A4': 'one spurious empty field per data row shifts all columns right by 1; '
                  'dropping it restores gravity_z=9.8065 and a clean monotonic 10 Hz clock'}

rows, rejected = [], []
for _, r in inv.iterrows():
    e = dict(dataset_id=r.dataset_id, variant=r.variant, kind=r.kind,
             driver_id=r.driver_id, vehicle_id=r.vehicle_id, phone_id=r.phone_id,
             n_rows=r.n_rows, n_cols=r.n_cols, duration_s=r.duration_s,
             acc_xyz=bool(r.has_acc), gyro_xyz=bool(r.has_gyro),
             gravity_xyz=bool(r.has_gravity), magnetometer_xyz=bool(r.has_mag),
             orientation_xyz=bool(r.has_orientation), gps=bool(r.has_gps),
             gps_accuracy=bool(r.has_gps_accuracy), gps_satellites=bool(r.has_gps_satellites),
             timestamp=bool(pd.notna(r.dt_median)), vbox_vehicle=bool(r.has_vehicle_fields),
             sample_rate_hz=r.rate_hz, duplicate_rows=r.duplicate_rows,
             duplicate_timestamps=r.duplicate_timestamps, t_monotonic=r.t_monotonic,
             max_gap_s=r.dt_max, repair_required=r.dataset_id in REPAIR,
             repair_note=REPAIR.get(r.dataset_id, ''))

    if r.kind == 'V':
        e['group'] = 'D'
        e['group_reason'] = ('vehicle/VBOX/ECU schema (29 ECU channels, no smartphone IMU); '
                             'must never be row-concatenated with smartphone data')
        e['core_eligible'] = False
    elif r.dataset_id in STATIONARY:
        e['group'] = 'E'
        e['group_reason'] = (f"stationary recording (GPS speed max "
                             f"{r.speed_max_kmh} km/h, "
                             f"{cal.loc[r.dataset_id, 'stationary_frac']:.1%} of samples "
                             f"stationary): use for sensor-bias estimation, not motion training")
        e['core_eligible'] = False
    elif r.dataset_id in BROKEN:
        e['group'] = 'F'
        e['group_reason'] = (f"{r.duplicate_rows} exact duplicate rows "
                             f"({r.duplicate_rows / r.n_rows:.0%}) and a collapsed timebase "
                             f"(median dt {r.dt_median}s, {r.duplicate_timestamps} duplicate "
                             f"timestamps): sample times are not recoverable without assumptions")
        e['core_eligible'] = False
        rejected.append(dict(dataset_id=r.dataset_id, driver_id=r.driver_id,
                             phone_id=r.phone_id, n_rows=r.n_rows,
                             reason=e['group_reason'],
                             potentially_recoverable=True,
                             recovery_note='drop exact duplicates then re-bin to a fixed 10 Hz '
                                           'grid; must be validated against a clean dataset '
                                           'before use'))
    elif not (r.has_mag and r.has_orientation):
        e['group'] = 'C'
        e['group_reason'] = ('smartphone core IMU present but magnetometer and 3-axis '
                             'orientation absent (18-column export, Driver F / Motorola '
                             'moto G7 power): valid for the core schema')
        e['core_eligible'] = True
    else:
        e['group'] = 'B'
        e['group_reason'] = ('full smartphone schema: core IMU plus magnetometer and '
                             '3-axis orientation')
        e['core_eligible'] = True
    rows.append(e)

cm = pd.DataFrame(rows)
cm.to_csv(os.path.join(OUT, 'compatibility_matrix.csv'), index=False)
pd.DataFrame(rejected).to_csv(os.path.join(OUT, 'rejected_datasets.csv'), index=False)

# ---------------- column mapping ----------------
s_files = inv[inv.kind == 'S'].canonical_path.tolist()
v_files = inv[inv.variant == 'V_full'].canonical_path.tolist()
seen_s, seen_v = {}, {}
for p in s_files:
    for c, v in map_cols(list(load_raw(p).columns), 'S').items():
        seen_s.setdefault(c.strip(), set()).add(v)
for p in v_files[:5]:
    for c, v in map_cols(list(load_raw(p).columns), 'V').items():
        seen_v.setdefault(c.strip(), set()).add(v)

mapping = {
    "dataset": "IO-VNBD (Inertial and Odometry Vehicle Navigation Benchmark Dataset)",
    "purpose": "Original CSV header -> MATRIX canonical column name.",
    "notes": [
        "Header text in the raw files contains mojibake: 'm/s2' is stored as 'm/s\\ufffd'.",
        "Headers also carry leading/trailing spaces; all names are stripped before matching.",
        "Matching is longest-prefix-first: 'GYROSCOPE YAW' must be tested before 'GYROSCOPE Y', "
        "otherwise it is mis-assigned to the Y axis.",
        "Two naming variants of the SAME smartphone data exist: 'GYROSCOPE X/Y/Z' + "
        "'ORIENTATION (Azimuth)' versus 'GYROSCOPE Yaw/Pitch/Roll' + 'ORIENTATION (Yaw)'. "
        "The two copies were verified numerically identical, so they are mapped positionally: "
        "column 16->gyro_x, 17->gyro_y, 18->gyro_z. The Yaw/Pitch/Roll labels are NOT a reliable "
        "statement of rotation axis (see coordinate-frame findings in the report).",
        "'GPS SATELLITES IN RANGE' is text of the form '22 / 23' and is split into "
        "gps_satellites_used and gps_satellites_visible.",
        "'DATE' is 'YYYY-MM-DD HH:MM:SS:mmm' - a COLON precedes the milliseconds.",
        "S-A4 carries one extra empty field per data row; columns must be shifted left by one "
        "from the satellites column onward before this mapping applies.",
    ],
    "smartphone_S": {k: (sorted(v)[0] if len(v) == 1 and sorted(v)[0] else
                         (sorted(x for x in v if x)[0] if any(v) else None))
                     for k, v in sorted(seen_s.items())},
    "vehicle_V": {k: (sorted(v)[0] if len(v) == 1 and sorted(v)[0] else
                      (sorted(x for x in v if x)[0] if any(v) else None))
                  for k, v in sorted(seen_v.items())},
    "derived_columns": {
        "timestamp_s": "t_ms / 1000.0 (TIME SINCE START, the monotonic device clock)",
        "wall_time_utc": "parsed from DATE; LOCAL time - add +3600 s for BST dates to compare "
                         "with the V time-of-day clock",
        "gps_satellites_used": "first integer of 'N / M'",
        "gps_satellites_visible": "second integer of 'N / M'",
        "linear_acc_{x,y,z}": "acc_{x,y,z} - gravity_{x,y,z}  (validated on stationary samples)",
        "gps_valid": "quality flag, see report Task 6",
        "gps_is_fix": "True only on rows where the GPS position actually changed",
    },
    "core_schema": ["timestamp_s", "acc_x", "acc_y", "acc_z", "gyro_x", "gyro_y", "gyro_z",
                    "gravity_x", "gravity_y", "gravity_z", "gps_latitude", "gps_longitude",
                    "gps_speed_kmh", "gps_accuracy_m", "gps_satellites_used", "gps_is_fix",
                    "gps_valid", "dataset_id", "driver_id", "vehicle_id", "phone_id",
                    "session_id"],
    "optional_enhanced_schema": ["mag_x", "mag_y", "mag_z",
                                 "ori_azimuth_deg", "ori_pitch_deg", "ori_roll_deg"],
}
with open(os.path.join(OUT, 'column_mapping.json'), 'w', encoding='utf-8') as f:
    json.dump(mapping, f, indent=2, ensure_ascii=False)

print(cm.groupby(['kind', 'group']).size().to_string())
print("\ncore_eligible smartphone datasets:", int(cm[cm.kind == 'S'].core_eligible.sum()))
print("group B:", int((cm.group == 'B').sum()), " group C:", int((cm.group == 'C').sum()))
print("rejected:", len(rejected), [r['dataset_id'] for r in rejected])
print("stationary:", sorted(STATIONARY))
print("\nunmapped S headers:", [k for k, v in mapping['smartphone_S'].items() if not v])
print("unmapped V headers:", [k for k, v in mapping['vehicle_V'].items() if not v])
