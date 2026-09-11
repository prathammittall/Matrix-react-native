# MATRIX — IO-VNBD preprocessing report

**Dataset:** IO-VNBD (Inertial and Odometry Vehicle Navigation Benchmark Dataset)
**Scope:** inventory, compatibility analysis and canonical-schema preparation for dead-reckoning model training.
**Status:** no model has been trained; no train/test split has been created; **no raw file was modified, moved or deleted.**

Every claim below was derived by parsing the actual CSV data. Where the published README/PDF
disagrees with the data, the data is treated as authoritative and the disagreement is called out.

---

## 0. Headline findings (the things that would have broken a naive pipeline)

| # | Finding | Consequence |
|---|---|---|
| 1 | The 564 CSVs on disk are **not** 564 datasets. They are **187 unique datasets** stored in two redundant views (`Categorised` / `Uncategorised`) across two trees. | Blind concatenation would have duplicated most trips **2–4×**. |
| 2 | The same smartphone data ships under **two different header namings** (`GYROSCOPE X/Y/Z` vs `GYROSCOPE Yaw/Pitch/Roll`). The files were verified numerically identical. | Naive header-matching silently creates two incompatible schemas out of one. |
| 3 | Prefix collision: `GYROSCOPE YAW` matches the shorter key `GYROSCOPE Y`. | Mis-assigns the yaw channel to the Y axis. Mapping must be **longest-prefix-first**. |
| 4 | **GPS updates roughly every 9 s, not at 1 Hz** as the README states (measured on every dataset). | Ground truth is ~90× sparser than assumed; forward-filling would fabricate ~99% of GPS rows. |
| 5 | Not every phone samples at 10 Hz. The **Blackberry Priv (Driver H) records at 2 Hz**. | A fixed `dt = 0.1 s` assumption is wrong for 13 datasets / 382,957 rows. |
| 6 | The `GRAVITY` channel has **exactly constant magnitude 9.80660** and mean direction exactly `(0,0,1)`. It is a *derived* channel, not a raw body-frame measurement. | It cannot be used to infer phone mounting tilt. |
| 7 | The **accelerometer/gravity pair and the gyroscope are not in a consistent axis convention** (§9). | An assumed rotation matrix would be wrong. Per-session alignment is required. |
| 8 | The "Synchronised" folder pairs are aligned **by row index**, not by timestamp, and residual lag reaches **8.5 s**. | Using V as ground truth without lag correction injects multi-second errors. |
| 9 | S wall-clock is **local time**; V time-of-day is **UTC**. 8 pairs need a **+3600 s (BST)** shift. | Time-based S/V joins silently fail for those pairs. |
| 10 | `S-A4` is not corrupt — it has **one spurious empty field per row**, shifting all columns right by one. | Recovered rather than discarded (repair verified: `gravity_z` → 9.8065). |

---

## 1. Inventory (Task 1)

`outputs/raw_inventory.csv` — one row per unique dataset-variant (259 rows), with row/column
counts, exact column names and dtypes, timestamp column, dt min/max/mean/std/median, sampling
rate, gaps, duplicate rows, duplicate timestamps, NaN/Inf counts, per-column missing counts,
per-sensor availability, GPS accuracy/satellite availability and GPS cadence.

**File census**

| | Count |
|---|---|
| CSV files on disk | 564 |
| Unique by SHA-256 | 329 |
| **Unique dataset IDs** | **187** (97 smartphone `S-*`, 90 vehicle `V-*`) |
| Inventory rows (id × variant) | 259 = 97 S + 90 V_full + 72 V_sync |

**Why 564 → 187.** Files are duplicated across `Categorised`/`Uncategorised` views and across the
`Synchronised`/`Unsynchronised` trees. Byte hashes disagree (float repr and header naming differ),
so copies were compared **by value**: all S copies are numerically identical, and 60 V datasets
exist in two genuinely different lengths (see §4).

**Sensor availability — measured, not read from the README**

| Channel | Present |
|---|---|
| Accelerometer XYZ | 97/97 (96 before repairing `S-A4`) |
| Gyroscope XYZ | 97/97 |
| Gravity XYZ | 97/97 |
| GPS lat/lon | 97/97 |
| GPS accuracy | 97/97 |
| GPS satellites | 97/97 (96 before repair) |
| Magnetometer XYZ | **88/97** |
| Orientation XYZ | **88/97** |

The 9 datasets without magnetometer/orientation are `S-T1 … S-T9` (Driver F, Motorola moto G7
power, 18-column export). **The PDF's Table A7 lists only T1–T6, T8, T9** — it omits `S-T7`. The
actual data shows `S-T7` is also an 18-column export. The data wins.

**Distinct schemas.** 6 raw header signatures collapse to **3 real schemas**:
smartphone-full (24 cols), smartphone-reduced (18 cols), vehicle (29 cols).
The remaining differences are cosmetic: `Yaw/Pitch/Roll` vs `X/Y/Z` naming, `ORIENTATION (Azimuth)`
vs `(Yaw)`, a malformed header in `S-Vfa01` (missing `)`), and a trailing empty column in `S-A4`.

---

## 2. Compatibility matrix (Task 2)

`outputs/compatibility_matrix.csv` — every dataset classified, with the reason recorded per row.

| Group | Meaning | Count | Rows |
|---|---|---|---|
| **B** | Enhanced smartphone (core + magnetometer + orientation) | 85 | 1,444,235 |
| **C** | Smartphone missing optional sensors (no mag/orientation) | 5 | 371,357 |
| **E** | Stationary / calibration | 3 | 27,656 |
| **F** | Rejected — unsafe without repair | 4 | 232,068 |
| **D** | Vehicle / VBOX / ECU | 162 variants (90 unique) | 1,417,617 |

**Group A** is not a separate population: it is the *core capability* (timestamp + acc + gyro +
gravity). All 85 Group B and all 5 Group C datasets satisfy it — **90 datasets, 1,815,592 rows**.
Group B is a strict superset of Group A.

**Group C** = `S-T2, S-T3, S-T7, S-T8, S-T9`. These are **not rejected** — they carry the full core
IMU and are fully usable; they simply lack the optional magnetometer/orientation channels.

**Group E** = `S-Vw1`, `S-Vw15`, `S-I` — identified empirically (GPS speed max 0.00/0.00/0.76 km/h;
97.7–99.4% of samples stationary), corroborated by the PDF which describes V-Vw1 and V-Vw15 as
"Stationary (No Motion, sensor bias estimation)".

**Group F** = `S-T1, S-T4, S-T5, S-T6` — see §12.

**Group D** must never be row-concatenated with smartphone data: it is a disjoint 29-channel ECU
schema (wheel speeds, steering angle, gear, brake pressure, engine rpm …) with no IMU.

---

## 3. Canonical schema (Task 3)

`outputs/column_mapping.json` holds the explicit original → canonical mapping for **every** raw
header, plus the derived columns and the caveats. Core schema:

```
timestamp_s          device monotonic clock, seconds (from TIME SINCE START (ms))
wall_time_local      absolute local wall clock (from DATE) — LOCAL, not UTC
acc_x/y/z            m/s^2        gyro_x/y/z        rad/s
gravity_x/y/z        m/s^2        linear_acc_x/y/z  m/s^2  (= acc - gravity, validated §8)
gps_latitude         degrees      gps_longitude     degrees
gps_speed_kmh        km/h         gps_accuracy_m    m
gps_satellites_used  int          gps_satellites_visible int   (parsed from "22 / 23")
gps_is_fix           bool  — True ONLY where the position actually changed
gps_valid            bool  — quality flag (§6)
gps_quality          ok | no_fix | poor_accuracy | few_satellites | impossible_jump | post_outage
dataset_id  driver_id  vehicle_id  phone_id  session_id  row_index_original
```

Optional (enhanced only, **deliberately excluded from the core feature set**):
`mag_x/y/z` (µT), `ori_azimuth_deg`, `ori_pitch_deg`, `ori_roll_deg`.

Missing optional fields are **left out**, never imputed. `row_index_original` preserves
traceability back to the raw row.

**Units (Task 14).** Verified against the data, not just the README: accelerometer and gravity
m/s² (|gravity| ≡ 9.80660), gyroscope rad/s, magnetic field µT, GPS degrees, GPS speed km/h.
**No unit conversion was required between smartphone datasets** — all three phones export the same
units. The only conversions applied are on the vehicle side when comparing against V
(g → m/s², deg/s → rad/s), and those are applied in analysis code only.

---

## 4. S/V synchronisation (Task 4)

**No S and V rows were merged.** V is kept in `vehicle_reference/` as reference/ground-truth only.

Filename matching was **not** trusted. Three independent tests were used, results in
`outputs/sv_synchronisation_final.csv`:

1. **Row alignment.** The authors' "manual synchronisation" is row-index alignment: `V_sync` is the
   V recording trimmed to the S row count at 10 Hz. 63/72 pairs match exactly, 69/72 within ±2 rows.
   This was discovered by finding that the Synchronised copy of a V file is always *shorter* than
   the Unsynchronised copy, while S files are byte-identical in both trees.
2. **Wall-clock overlap.** S `DATE` → seconds since local midnight, compared with V
   `Time Since Start of Day`. **S is local time, V is UTC**: 8 pairs (September 2019, British
   Summer Time) need +3600 s, confirmed by overlap jumping from ~0.00 to ~0.999.
3. **Spatial agreement.** Bounding-box IoU and median nearest-neighbour distance between the two
   GPS tracks.

| Verdict | Count |
|---|---|
| `SYNC_ROW_ALIGNED` | 67 |
| `SYNC_ROW_ALIGNED_SPATIAL_UNVERIFIED` | 2 |
| `SYNC_CLAIMED_NOT_TRIMMED` | 3 |
| `NO_COUNTERPART` | 43 |

- **`SYNC_CLAIMED_NOT_TRIMMED`** — `Vfa01`, `Vfa02`, `Vw15`. These sit in the Synchronised folder but
  `V_sync` is byte-identical to the untrimmed `V_full` and the row counts differ by +49/+232/+11.
  They were never actually trimmed; treat their alignment as unverified.
- **`SYNC_ROW_ALIGNED_SPATIAL_UNVERIFIED`** — `Vta9`, `Vtb10`. Both are very short (156/196 rows,
  ~16–20 s) so the bounding-box test degenerates; row alignment and time overlap (0.99/0.97) are
  both good. These are most likely fine.
- **`V-Vw7` / `V-Vw8`** deserve a specific note. Their S and V windows **do not overlap in time at
  all** (~165 s apart), yet their GPS bounding boxes are *identical* and their rows align. They are
  the same trip with a **~165 s phone-vs-VBOX clock offset** — a case where trusting the folder name
  and the timestamps would have given opposite, both-wrong answers.

**Residual lag.** Even among confirmed pairs, cross-correlating phone gyro against ECU yaw rate
shows best-fit lags from **−0.5 s to −8.5 s** (e.g. `S-S2` reaches r = **+0.988** at −8.5 s, vs
+0.02 at zero lag). **Row alignment is approximate.** Any use of V as ground truth must first
estimate a per-pair lag by cross-correlation.

**43 datasets have no counterpart** — 25 S-only (all of Driver F/G/H: `S-A*`, `S-T*`, `S-I`) and
18 V-only (`V-St*`, `V-Vfb*`, `V-Vta18`, `V-Vtb13`, `V-Y2`).

---

## 5. Timestamp analysis (Task 5)

Timestamps were parsed, sorted **within session**, and dt computed per dataset — never assumed to
be 0.1 s. Per-dataset statistics are in `raw_inventory.csv`.

- **Actual rates:** 10 Hz for 81 datasets, **2 Hz for the 12 Blackberry datasets**, and irregular
  for the 4 Group F datasets. `S-M` measures ~19.6 Hz.
- **Backward time jumps.** `S-M`, `S-S2`, `S-S3b`, `S-S4`, `S-Y1` contain 1–3 *negative* dt values
  (as large as −5578 s): the device clock reset, or two recordings were concatenated.
  **Globally sorting these by timestamp is wrong** — it interleaves independent segments and
  destroys the GPS hold structure. Sessions are therefore cut at backward jumps **in original row
  order**, and sorting is applied only *within* a session.
- **Large forward gaps.** `S-S3b` has a single 2026 s gap, `S-Vtb1` 661 s, `S-I` 285 s. Sessions are
  also cut at gaps > 5 s.
- Result: **103 sessions** across 93 datasets; 7 datasets split (`S-Y1` → 4, `S-S4` → 3).
- The original timestamp is preserved verbatim in `timestamp_s`, alongside `row_index_original`.

---

## 6. GPS analysis (Task 6)

**GPS was not forward-filled.** The raw files already carry the last fix repeated across
subsequent IMU rows; `gps_is_fix` marks only the rows where the position genuinely changed.

- Across 1,843,248 smartphone rows there are only **57,467 real GPS fixes — 96.9% of rows are
  repeats of a previous fix.**
- **Measured update interval ≈ 9 s** (median across datasets), not the documented 1 Hz. On `S-S1`:
  51,746 rows over 5,174 s with 532 distinct fixes, interval median exactly 9.0 s.
  The Blackberry datasets are the exception — `S-A9`/`S-A10` update at ~1 Hz.

`gps_quality` / `gps_valid` flag (nothing is deleted):

| Flag | Criterion |
|---|---|
| `no_fix` | lat/lon missing, or (0,0) null-island |
| `poor_accuracy` | reported accuracy > 20 m |
| `few_satellites` | satellites used < 4 |
| `impossible_jump` | implied speed between consecutive in-session fixes > 250 km/h |
| `post_outage` | fix gap > max(5 × dataset median, 30 s) |

Outcome: median 0% invalid; mean 4.8%. Worst are `S-A10` (66%) and `S-A9` (60%), both Blackberry.
Only 11 datasets contain genuine impossible jumps, 1–4 occurrences each.

---

## 7. Stationary data and sensor bias (Task 7)

Three stationary recordings (`S-Vw1` 2047 s, `S-I` 580 s, `S-Vw15` 138 s) — ~46 min total,
consistent with the PDF's "more than 20 minutes".

Detection thresholds were **calibrated from the data**, not guessed. An initial gyro threshold of
0.01 rad/s wrongly rejected `S-Vw1`/`S-Vw15`, because with the engine running vibration gives a
rolling gyro σ ≈ 0.02 and |acc| σ ≈ 0.09. With the engine off (`S-I`) gyro σ ≈ 0.002. Final
criterion: GPS speed < 0.5 km/h **and** rolling gyro σ < 0.03 **and** rolling |acc| σ < 0.20.

Bias is estimated **per dataset/session**, never globally — `calibration/sensor_bias_estimates.csv`
covers the **53 datasets with ≥ 50 stationary samples**. This matters: accelerometer bias varies far
more between sessions than between phones (Huawei acc-bias σ ≈ 0.14–0.20 m/s² *across sessions*),
so a single global bias would be actively harmful. Gyro bias is small and stable
(|bias| ≲ 0.005 rad/s). Raw files are untouched; calibrated values are derived columns.

---

## 8. Gravity correction (Task 8)

`linear_acc = accelerometer − gravity` was **validated, not assumed**, on stationary samples from
**53 datasets**:

| Quantity | Measured |
|---|---|
| mean \|accelerometer\| | 9.838 m/s² |
| mean \|gravity\| | 9.80660 m/s² (σ ≈ 2e-5) |
| **mean \|acc − gravity\|** | **0.336 m/s²** |
| mean \|acc + gravity\| | 19.640 m/s² |
| mean cos∠(acc, gravity) | **+0.9990** |

The accelerometer **includes** gravity and points the **same** direction as the gravity channel, so
subtraction is correct and addition is wrong by ~2 g. The 0.336 m/s² residual is bias + noise,
which is exactly what §7 estimates.

**Caveat.** |gravity| is *exactly* constant at 9.80660 with only 2–8 distinct values per file, and
its mean direction is exactly (0,0,1) for the Huawei datasets (tilt 0.003°). This is a **derived**
channel (from the orientation solution), not a raw body-frame reading, so it carries **no usable
information about how the phone was mounted**.

---

## 9. Coordinate system (Task 9)

**No rotation matrix has been invented.** The raw frame was analysed and the required
transformation documented.

The experiment: for row-aligned S/V pairs, correlate phone linear-acceleration and gyro axes
against ECU longitudinal/lateral acceleration and yaw rate, scanning lag and smoothing.

**Result — the channels are mutually inconsistent:**

- **Accelerometer + gravity** say vertical is **+Z**: stationary mean acc ≈ (0, 0, +9.85), gravity
  ≡ (0, 0, 9.8066).
- **Gyroscope** says the vertical (yaw) axis is the **second** gyro column: `gyro_y` ↔ ECU yaw rate,
  positive sign, **r = +0.988** (`S-S2`), +0.93 (`S-M`), +0.69 (`S-Vw4`). `gyro_z` correlates
  *negatively* (−0.80, −0.55).
- **Orientation** agrees with the gyroscope, not the accelerometer: pitch ≈ −87.6°, i.e. the phone
  is mounted **upright** in a windscreen holder — for which the vertical axis is the device Y axis,
  exactly as the gyro correlation shows.

If accelerometer and gyroscope shared a frame, yaw would appear on `gyro_z`. It does not.
The accelerometer/gravity pair appears **gravity-aligned (already levelled)**, while the gyroscope
and orientation are in the **raw device body frame**.

**Therefore:** the phone axes are *not* aligned with the vehicle, the two IMU channels are not even
aligned with each other, and the README's own warning about vibration-affected axis alignment is
an understatement. Required transformation, to be derived **per session** before any physical
dead-reckoning integration:

1. Estimate the gravity/vertical direction per session from the accelerometer while stationary.
2. Estimate the yaw axis per session from the gyroscope, using the ECU yaw rate where a
   synchronised V pair exists, otherwise from the dominant rotation axis during turns.
3. Build forward/lateral/vertical from those two, resolving forward sign against GPS heading.

Correlations for `S-S2`/`S-Y1` are near zero at zero lag and strong at the correct lag, so **lag
estimation must precede rotation estimation.** Until this is done, treat the axes as an unlabelled
6-channel signal — which is legitimate for a learned model, but not for hand-written integration.

---

## 10. GPS → local coordinates (Task 10)

As instructed, final target generation is **not implemented yet** — it depends on the lag and
rotation work in §4 and §9. What is established:

- Raw lat/lon are preserved but must **not** be used as training targets.
- Targets should be `delta_forward` / `delta_lateral` (or the corresponding velocities) in a local
  ENU frame anchored per session, with the anchor stored in metadata.
- The binding constraint is §6: with a real fix only every ~9 s, displacement targets are only
  defensible **between consecutive valid fixes** (`gps_is_fix & gps_valid`), not per 0.1 s row.
  A 10 Hz target series derived from 0.11 Hz GPS would be ~99% interpolation.

---

## 11. Outliers (Task 11)

`outputs/outlier_report.csv` — reported, **nothing removed**.

The extremes are consistent with the documented manoeuvres (hard braking, roundabouts, potholes,
skid) rather than sensor failure: |linear acc| p99.9 ≈ 9.4 m/s², max 74.2 m/s²; |gyro| p99.9 ≈ 1.24
rad/s, max 23.4 rad/s. **No dataset has any sample beyond 8 g**, so there is no evidence of
accelerometer saturation, and large values should be kept as legitimate physics.

Sensor corruption is distinguished by *structural* evidence — duplicate rows, collapsed timebases,
column shift, backward clocks — not by magnitude.

---

## 12. Rejected datasets (Task 12 / 13)

`outputs/rejected_datasets.csv` — **4 datasets**, all Driver F / Motorola:

| Dataset | Rows | Exact duplicate rows | Reason |
|---|---|---|---|
| `S-T1` | 25,759 | 10,319 (40%) | collapsed timebase, median dt 0.001 s, 10,362 duplicate timestamps |
| `S-T4` | 73,482 | 20,841 (28%) | as above, 20,914 duplicate timestamps |
| `S-T5` | 46,387 | 14,200 (31%) | as above, 14,249 duplicate timestamps |
| `S-T6` | 86,440 | 34,593 (40%) | as above, 34,722 duplicate timestamps |

These four were written at an effective ~20 Hz as 1 ms-separated duplicate pairs. After dropping
exact duplicates the timebase is still bimodal (1 ms and 100 ms), so sample times are **not
recoverable without an assumption**. They are marked `potentially_recoverable = True` with a
documented recovery route (dedup, then re-bin to a fixed 10 Hz grid, validated against a clean
dataset) — **quarantined, not thrown away**. `S-T2`, `S-T3`, `S-T7`, `S-T8`, `S-T9` from the same
driver/phone are clean 10 Hz and are retained.

**`S-A4` was explicitly NOT rejected.** Its 25th column and shifted data initially looked corrupt;
inspection showed one spurious empty field per row. Dropping it restores `gravity_z` = 9.8065
± 0.0005, a monotonic 10 Hz clock and zero duplicate timestamps. The repair is applied in the
pipeline, flagged in `compatibility_matrix.csv` (`repair_required`), and the raw file is untouched.

---

## 13. Outputs

```
model/preprocessing/
  common.py  pass1_scan.py  pass3_inventory.py  pass4_sync.py
  pass4b_sync_final.py  pass5_calibration.py  pass6_frame.py
  pass7_classify.py  pass8_build.py
  outputs/
    raw_inventory.csv                 259 dataset-variants, full statistics
    compatibility_matrix.csv          group + reason for every dataset
    column_mapping.json               original -> canonical, with caveats
    rejected_datasets.csv             4 datasets + exact reasons + recovery route
    sv_synchronisation.csv            timestamp-overlap evidence
    sv_synchronisation_final.csv      combined 3-test verdicts
    calibration_bias.csv              per-dataset bias / gravity / tilt
    outlier_report.csv                motion extremes + GPS quality per dataset
    axis_correlation.csv              phone-vs-vehicle axis correlations
    preprocessing_report.md           this file
  smartphone_core/        90 parquet files, core schema      (1,815,592 rows)
  smartphone_enhanced/    88 parquet files, core + mag/orientation
  vehicle_reference/     162 parquet files (90 V_full + 72 V_sync), kept separate
  calibration/             3 stationary datasets + sensor_bias_estimates.csv
```

The raw dataset under `model/dataset/` is unchanged — verified read-only throughout.

---

## 14. Merging rules applied (Task 14)

Smartphone datasets are merged only where: sensor semantics are equivalent (verified — identical
units and identical value ranges across all three phones); timestamps are valid (irregular ones
quarantined, §12); core IMU fields are present; and the column mapping is unambiguous (the
Yaw/Pitch/Roll vs X/Y/Z ambiguity is resolved **positionally**, justified by the two copies being
numerically identical, and recorded in `column_mapping.json`).

**Merging is still not unconditional.** Sampling rate (10 Hz vs 2 Hz) and phone model differ, so
`phone_id` and the per-dataset `sample_rate_hz` must be carried as features/filters. The 2 Hz
Blackberry data should not be resampled to 10 Hz by interpolation for an inertial model.

## 15. No train/test split (Task 12)

None was created. `dataset_id`, `driver_id`, `vehicle_id`, `phone_id`, `session_id` and
`row_index_original` are preserved on every row so a leakage-free split can be made later by
**session or driver** — never by row, since adjacent 10 Hz samples are near-duplicates.
Note that Driver E alone is 62 of the 90 usable datasets, so a random session split would still
leave one driver dominating; a grouped or stratified split by driver is advisable.
