# MATRIX — transformation status audit

Verified programmatically against the raw IO-VNBD CSVs immediately before building the
ML dataset, so that nothing is applied twice. Raw dataset re-hashed: **564/564 CSVs unchanged.**

## Status of every transformation

| # | Transformation | Status in `smartphone_core/` | How verified |
|---|---|---|---|
| 1 | **Gravity subtraction** | ✅ **APPLIED** | `max｜linear_acc_a − (acc_a − gravity_a)｜ = 0.0` exactly, all 3 axes, on `S-Vw4`, `S-A5`, `S-T2`, `S-M` |
| 2 | **Accelerometer bias** | ❌ **NOT APPLIED** | `acc_x/y/z` bit-identical to the raw CSV (`np.allclose`, atol 1e-12) |
| 3 | **Gyroscope bias** | ❌ **NOT APPLIED** | `gyro_x/y/z` bit-identical to the raw CSV |
| 4 | **Coordinate transformation** | ❌ **NOT APPLIED** | raw phone axes retained; rotations exist only as per-session coefficients in `frame_transformations.json` |
| 5 | **GPS cleaning** | ⚠️ **FLAGS ONLY** | 0 rows dropped, no forward-fill; `gps_is_fix` / `gps_valid` / `gps_quality` mark rows |
| 6 | **Timestamp correction** | ⚠️ **SESSION SPLIT ONLY** | `timestamp_s == t_ms/1000` exactly; `wall_time_local` is LOCAL and unshifted; sessions cut at backward jumps and >5 s gaps |

## Consequences for this build

1. **Gravity is NOT re-subtracted.** `linear_acc_*` is consumed as-is where used; `acc_*` remains the raw (gravity-inclusive) specific force.
2. **Bias correction is applied here for the FIRST time**, and only to `acc_*` and `gyro_*`.
   - Per-session estimates exist for **27 of the 45** VBOX sessions (those containing ≥50 stationary samples).
   - The remaining **18 sessions have no stationary segment**, so no bias can be estimated. They receive **zero bias**, and every window records `bias_applied` so the asymmetry stays visible and auditable.
   - A phone-level median was deliberately *not* substituted: earlier analysis showed accelerometer bias varies more between sessions than between phones, so a borrowed median would be a fabricated correction.
   - Magnitudes are small relative to signal: gyro bias ≲0.005 rad/s vs signal σ ≈0.1 rad/s; accel bias ≈0.04 m/s² vs σ ≈1 m/s².
3. **No rotation is applied.** As instructed, the low-confidence per-session accelerometer rotation is *not* used. Only 17/45 sessions reached `transform_quality = good`, and accelerometer fit quality was only r≈0.49, so pre-rotating would inject more error than it removes. The model consumes raw phone-frame IMU.
4. **GPS is never a model input.** Latitude, longitude, speed, orientation, accuracy and satellite count are used solely for target generation and evaluation.
5. **Sampling rate verified, not assumed.** All 45 VBOX sessions measure `dt_median = 0.1000 s` exactly → **10.0 Hz**, so a 5 s window is exactly 50 samples. (Note: the 2 Hz Blackberry and irregular Motorola sessions are GPS-supervised only and are excluded from this baseline.)

## Applied in THIS build (pass 12) — first and only application

| Step | Applied to | Note |
|---|---|---|
| Accelerometer bias subtraction | 27/45 sessions | zero elsewhere, flagged |
| Gyroscope bias subtraction | 27/45 sessions | zero elsewhere, flagged |
| Feature scaling | train statistics only | scaler saved; val/test never contribute |

**Not applied anywhere:** coordinate rotation, GPS forward-fill, resampling, `target_v_lateral`.
