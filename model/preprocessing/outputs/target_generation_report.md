# MATRIX — synchronisation, frame validation and target generation

**Stage:** pre-training validation. **No model trained. No windows created. No normalisation applied.**

---

## 1. What was already applied (verified, not assumed)

Re-checked directly against the raw CSVs before doing anything, so nothing is applied twice.

| Transformation | Status in `smartphone_core/` | Evidence |
|---|---|---|
| Gravity subtraction | **APPLIED** | `max｜linear_acc − (acc − gravity)｜ = 0.0` exactly, all axes |
| Accelerometer bias | **NOT applied** | `acc_*` bit-identical to raw CSV; bias stored separately |
| Gyroscope bias | **NOT applied** | `gyro_*` bit-identical to raw CSV |
| Coordinate transform | **NOT applied** | raw phone axes retained |
| GPS cleaning | **FLAGS ONLY** | 0 rows dropped, no forward-fill, holds preserved |
| Timestamp correction | **Session split only** | `timestamp_s == t_ms/1000` exactly; `wall_time_local` is LOCAL, unshifted |

Bias correction is therefore applied for the **first** time in pass 10/11. Gravity is **not** re-subtracted.

---

## 2. Synchronisation (`synchronization_report.csv`)

81 sessions from 72 S/V pairs. Two distinct quantities are separated, because conflating
them is the main trap here:

- **`time_offset_seconds`** — absolute wall-clock difference (phone LOCAL vs VBOX UTC), containing the BST/GMT term.
- **`estimated_lag_seconds`** — residual lag remaining *after* the authors' row-index alignment, from cross-correlating phone gyroscope against VBOX yaw rate (±60 s search, 1 s smoothing).

**Offsets cluster exactly where physics says they should:** 49 sessions at ≈0 s (GMT) and 12 at ≈3600 s (BST). Nothing in between.

### The key result: row alignment is *approximate*, timestamps are *accurate*

The two estimates are independent, yet for strong-correlation sessions they agree:

| | value |
|---|---|
| High-confidence sessions agreeing within 1 s | **24 / 28** |
| Median ｜lag − clock prediction｜ (high conf.) | **0.4 s** |

Since `estimated_lag ≈ −(wall-clock residual after removing whole hours)`, the two device
clocks are mutually **consistent**, and the authors' row trimming is off by exactly that
residual. Where the correlation is weak the cross-correlation peak is unreliable, so the
wall clock is preferred. This is encoded in `alignment_method`:

| method | n | meaning |
|---|---|---|
| `xcorr+wallclock_agree` | 26 | both agree → high confidence |
| `wallclock_confirmed_by_weak_xcorr` | 19 | clock used, weakly corroborated |
| `wallclock_preferred_xcorr_weak` | 22 | xcorr peak not trusted |
| `xcorr_only_wallclock_disagrees` | 2 | flagged for review |
| `none` | 3 | no motion / too short |

**`usable_for_vbox_supervision` = 45 sessions** (26 high + 19 medium).
`gyro_y` was the best-correlating channel in 54 of 81 sessions. Residual lag after correction:
median −0.9 s, range −9.6 s to +20.2 s.

`S-Vw7` / `S-Vw8` remain special: a genuine ~165 s phone-vs-VBOX clock offset with correct
row alignment — the one case where clock and rows disagree and the rows win.

---

## 3. Frame transformation (`frame_transformations.json`)

**No universal rotation is assumed or applied.** Per session, least squares against the only
channels that actually observe the vehicle frame:

```
v_acc_long ~ r_fwd · linear_acc     v_acc_lat ~ r_lat · linear_acc     v_yaw_rate ~ r_yaw · gyro
```
Vertical accelerometer row derived as `r_fwd × r_lat` (**not** independently validated).

Accelerometer and gyroscope are fitted with **separate** matrices, deliberately: they are not
in a consistent axis convention (established earlier — accel/gravity say vertical is +Z while
gyro and orientation say the phone is mounted upright). Forcing one matrix on both would be wrong.

### Validation — before vs after (step 5)

"Before" = naive assumption (phone X=forward, Y=lateral, Z=yaw) with no lag correction.

| Channel | ｜r｜ before → after | RMSE before → after | Improved |
|---|---|---|---|
| **Yaw rate** | 0.054 → **0.934** | 0.1311 → **0.0325** rad/s | **45 / 45** |
| Longitudinal acc | 0.148 → **0.488** | 1.1436 → **0.6926** m/s² | 42 / 45 |
| Lateral acc | 0.222 → **0.467** | 1.1538 → **0.6311** m/s² | 41 / 45 |

The yaw result is excellent and universal. The accelerometer result is **mediocre by
comparison and that is a real finding**, not a fitting failure: the phone accelerometer is
dominated by vibration, suspension motion and mount compliance, so it explains only ~24% of
the variance of vehicle longitudinal acceleration.

### Quality gating

Least-squares rows are a valid rotation **only where the fit is strong** — row norm correlates
0.76–0.81 with fit quality, the classic errors-in-variables signature. So transforms are gated:

| `transform_quality` | n | meaning |
|---|---|---|
| `good` | 17 | gyro ｜r｜≥0.80 **and** accel ｜r｜≥0.50 |
| `yaw_only` | 18 | gyro usable, accelerometer not |
| `unusable` | 10 | neither |

**The mapping is genuinely per-session.** Among gyro-usable sessions the dominant yaw axis is
`z` in 25 sessions but `y` in 10 — mounting varied between sessions. A universal matrix would
have been wrong for at least a third of them.

Only **8 sessions** (`S-M_s00/s01`, `S-S1_s00`, `S-S2_s01`, `S-S3a_s00`, `S-S3b_s01`,
`S-S3c_s00`, `S-S4_s00` — all Drivers A/B) produce a **true rotation row**: ｜r｜≥0.95 with norm
1.017 ± 0.031 and yaw row ≈ `[0, 1, 0]`, independently confirmed by
`std(vbox_yaw)/std(gyro_y)` = 0.96–0.99. For sessions in the 0.8–0.99 band the row norm is
1.6–1.8, i.e. **the phone under-reads yaw by ~40%** — physical mount compliance. A learned
model can absorb that scale; hand-written physical integration cannot.

---

## 4. Target generation (`targets/`, `target_summary.csv`)

### Strategy A — VBOX-supervised (preferred)

Dense 10 Hz targets from lag-corrected, row-aligned VBOX channels.
**45 sessions, 694,221 target rows.**

| Target | Source | Quality |
|---|---|---|
| `target_v_forward` | VBOX velocity (km/h → m/s) | directly observed ✅ |
| `target_yaw_rate` | VBOX yaw rate (deg/s → rad/s) | directly observed, r=0.934 ✅ |
| `target_v_lateral` | **not observable — emitted as 0.0** | see below ⚠️ |

### `target_v_lateral` is not observable, and is not fabricated

You asked for it, so it is present — but as an explicit zero with
`target_v_lateral_observable = False`, because the data will not support anything else:

- `corr(a_lat, yaw_rate × v_forward) = 0.907` — lateral acceleration is almost entirely the centripetal term.
- The residual `a_lat − yaw·v_fwd` has std 0.327 m/s² and is noise-dominated.
- Leaky-integrating that residual (τ=2 s) gives ｜v_lat｜ up to 1.73 m/s, versus a physical bound of **0.26 m/s** for 2° sideslip at that session's mean speed — **~7× too large**.

A non-holonomic ground vehicle has v_lateral ≈ 0 in the body frame. Emitting an integrated
noise signal would have poisoned training with a plausible-looking but fictitious target.
The centripetal term is retained as `aux_centripetal_acc` (diagnostic, not a target).

**My first implementation got this wrong** — it divided by yaw rate and saturated at the ±5 m/s clip. It was replaced.

### Strategy B — GPS-supervised (fallback)

**Sparse by construction.** Targets exist **only** between consecutive `gps_is_fix & gps_valid`
rows; every other row is `target_valid = False` with NaN targets. GPS is never forward-filled
and repeated GPS values are never treated as new measurements (verified: all invalid rows have
NaN `v_forward`).

| Target | Definition |
|---|---|
| `target_displacement_m` | haversine between consecutive valid fixes |
| `target_dt_s` | elapsed time between those fixes (median **9.0 s**) |
| `target_v_forward` | displacement / dt (mean speed over the interval) |
| `target_delta_heading_deg` | wrapped bearing change |
| `target_yaw_rate` | Δheading / dt — **very coarse**, ~0.11 Hz |
| `target_v_lateral` | 0 by construction (velocity is along travel direction) |

**51 sessions, 40,217 targets — a median of just 1.06% of rows.** That is the direct consequence
of the ~9 s GPS cadence and is the single biggest constraint on GPS-supervised training.

### Quality flags (step 8)

Every row carries `target_source` (`vbox` / `gps` / `none`), `target_valid`, `target_confidence`.

- VBOX: `high` if sync confidence high **and** gyro transform usable; else `medium`.
- GPS: `high` if accuracy ≤10 m, ≥6 satellites and dt ≤12 s; else `medium`.
- Totals: **high 438,553 · medium 295,885 · low 0** (`low` is empty because `gps_valid` already excludes accuracy >20 m).

---

## 5. Recommended final target schema

```
PRIMARY   target_v_forward      m/s      VBOX velocity, or GPS displacement/dt
          target_yaw_rate       rad/s    VBOX yaw rate (dense) or Δheading/dt (sparse)
SECONDARY target_displacement_m m        GPS strategy only
          target_delta_heading_deg deg   GPS strategy only
METADATA  target_source {vbox|gps|none}   target_valid (bool)
          target_confidence {high|medium|low|none}
          target_dt_s    target_v_lateral_observable (bool)
KEYS      session_id dataset_id driver_id vehicle_id phone_id
          row_index_original timestamp_s
EXCLUDED  target_v_lateral — present but identically 0 and flagged unobservable;
                             do NOT use as a regression target
```

**Recommendation: train on `target_v_forward` and `target_yaw_rate` only.** These are the two
quantities this dataset actually observes well, and together they are sufficient for
2-D dead reckoning (speed + heading rate integrate to a trajectory).

---

## 6. Session lists

### VBOX-supervised — 45 sessions (694,221 rows)

**Grade 1 — high sync confidence + usable gyro transform (25 sessions), recommended core training set:**
`S-M_s00, S-M_s01, S-S1_s00, S-S2_s00, S-S2_s01, S-S3a_s00, S-S3b_s00, S-S3b_s01, S-S3c_s00, S-S4_s00, S-Vta11_s00, S-Vta16_s00, S-Vta1a_s00, S-Vta24_s00, S-Vta25_s00, S-Vta2_s00, S-Vta3_s00, S-Vta5_s00, S-Vta7_s00, S-Vtb12_s00, S-Vw11_s00, S-Vw3_s00, S-Vw5_s00, S-Vw6_s00, S-Vw9_s00`

**Grade 2 — medium (20 sessions):** the remaining `A_vbox` rows in `target_summary.csv`. Usable, but verify per-session lag before relying on them.

### GPS-supervised only — 51 sessions (40,217 sparse targets)

All of Drivers F/G/H (no VBOX counterpart exists) plus VBOX sessions that failed sync:
`S-A2, S-A4…S-A13` (Blackberry, 2 Hz), `S-T2, S-T3, S-T7…S-T11` (Motorola), `S-I_s01`,
`S-S4_s01/s02`, and the low-confidence `S-Vta*/S-Vtb*/S-Vw*` sessions. Full list in
`target_summary.csv` (`strategy == 'B_gps'`).

### Exclude — 7 sessions

| Session | Reason |
|---|---|
| `S-Vw1_s00`, `S-Vw15_s00` | stationary calibration — no motion to supervise (use for bias only) |
| `S-I_s00` | stationary segment of the parked-vehicle recording |
| `S-A1_s00`, `S-A3_s00` | too few valid GPS fixes to form any target pair |
| `S-Y1_s00`, `S-Y1_s01` | 302 and 36 rows — too short |

Still excluded from earlier stage: `S-T1/T4/T5/T6` (Group F, collapsed timebase).

---

## 7. Caveats before training

1. **Two target regimes are not interchangeable.** VBOX targets are dense 10 Hz; GPS targets are ~0.11 Hz. Mixing them in one loss without weighting would let 45 sessions dominate 51.
2. **Sampling rate varies** — 2 Hz Blackberry sessions sit alongside 10 Hz. Do not interpolate to a common rate for an inertial model.
3. **`S-A4` targets rely on the column-shift repair.** Verified, but it is a repaired dataset.
4. **Accelerometer→vehicle mapping is weak (r≈0.49).** Prefer letting the model learn from raw 6-channel IMU rather than pre-rotating accelerometer data with a low-confidence matrix.
5. **Driver E dominates** (62 of 90 usable datasets). Split by driver, not just session.

---

## 8. Files

```
outputs/synchronization_report.csv     81 sessions: lag, offset, method, confidence
outputs/frame_validation.csv           45 sessions: before/after r and RMSE
outputs/frame_transformations.json     per-session rotations + quality gating
outputs/target_summary.csv             103 sessions: strategy, counts, confidence
outputs/target_generation_report.md    this file
targets/<session_id>.parquet           103 files, per-session targets + flags
```
