# MATRIX — ML-ready training dataset (v1, VBOX-supervised baseline)

**No model has been trained.** Dataset built, validated and frozen for review.
Raw IO-VNBD re-hashed after the build: **564/564 CSVs unchanged.**

---

## 1. Transformation audit

Full detail in `outputs/transformation_status.md`. Summary of what was already applied
versus what this build applies, so nothing is double-applied:

| Transformation | Before this build | This build |
|---|---|---|
| Gravity subtraction | ✅ applied (verified exact, residual 0.0) | **not reapplied** |
| Accelerometer bias | ❌ not applied | ✅ **applied here** (27/45 sessions have estimates) |
| Gyroscope bias | ❌ not applied | ✅ **applied here** (27/45 sessions) |
| Coordinate rotation | ❌ not applied | **deliberately not applied** (low confidence) |
| GPS cleaning | flags only, no ffill | GPS never used as input |
| Timestamps | raw + session split | verified 10.0 Hz, used for window validity |
| Normalisation | — | scaler fitted on **train only**, stored separately |

18 of 45 sessions have no stationary segment, so no bias can be estimated. They receive
**zero bias** rather than a borrowed phone-level median (which would be a fabricated
correction), and every window records `bias_applied` so the asymmetry is auditable.

---

## 2. Why this baseline is VBOX-only, high-confidence-only

- **VBOX targets only.** GPS-supervised sessions are excluded entirely. GPS targets are ~90× sparser (median 1.06% of rows vs 100%), so mixing them unweighted would let one regime dominate the loss. They remain available in `targets/` for a later experiment.
- **High-confidence only.** 25 of 45 VBOX sessions. The 20 medium-confidence sessions (275,453 target rows) are *not* mixed in; they are listed in `vbox_session_distribution.csv` as a documented extension set.

**Cost of that choice, stated plainly:** restricting to high confidence cuts Driver E from
339,167 to 63,714 target rows. Driver E is the *aggressive* driver with the most diverse
manoeuvres, so the baseline is deliberately conservative on target quality at the expense of
manoeuvre diversity. Adding the medium set is the single highest-value ablation.

---

## 3. Session distribution (45 VBOX sessions)

| Driver | Sessions | Target rows | Hours | Distance |
|---|---|---|---|---|
| A | 8 | 249,118 | 6.93 | 214.5 km |
| B | 2 | 105,936 | 2.94 | 105.1 km |
| E | 35 | 339,167 | 9.45 | 480.3 km |

**All 45 are the same phone (Huawei P20 Pro) and same vehicle (Ford Fiesta Titanium)** — the
VBOX only ever existed in the research vehicle. There is therefore **no phone or vehicle
diversity available under VBOX supervision**, and only 3 drivers. This is a hard property of
IO-VNBD, not a preprocessing choice, and it bounds what the baseline can demonstrate.

---

## 4. Split (leakage-free, session level)

Whole sessions only; no window crosses a session or split boundary.

| Split | Sessions | Windows | Target rows | Drivers | Share |
|---|---|---|---|---|---|
| **train** | 18 | 51,299 | 257,227 | A, E | 61.4% |
| **validation** | 5 | 1,110 | 55,605 | A, E | 13.3% |
| **test** | 2 | 2,117 | 105,936 | **B (unseen)** | 25.3% |

- **Test is an entirely unseen driver (B).** With only 3 drivers, holding one out costs 25.3% of the data — a deliberate trade for a genuine generalisation test.
- **Validation is unseen *sessions* from seen drivers**, which measures a different and weaker kind of generalisation. With 3 drivers we cannot have unseen drivers in both val and test without removing a driver from training entirely.
- `train` window count is larger despite similar row counts because train uses 90% overlap while val/test use none.

```
test  : S-M_s00, S-M_s01
val   : S-S3a_s00, S-Vta16_s00, S-Vta2_s00, S-Vw11_s00, S-Vw3_s00
train : S-S1_s00, S-S2_s00, S-S2_s01, S-S3b_s00, S-S3b_s01, S-S3c_s00, S-S4_s00,
        S-Vta11_s00, S-Vta1a_s00, S-Vta24_s00, S-Vta25_s00, S-Vta3_s00, S-Vta5_s00,
        S-Vta7_s00, S-Vtb12_s00, S-Vw5_s00, S-Vw6_s00, S-Vw9_s00
```

---

## 5. Windows

Sampling rate **verified, not assumed**: every one of the 45 sessions measures
`dt_median = 0.1000 s` exactly → **10.0 Hz**. So 5 s = exactly 50 samples.

Causal construction, target at the **last** sample:  `IMU[t-49 : t] → y(t)`

| W (samples) | Seconds | train | validation | test |
|---|---|---|---|---|
| 10 | 1.0 | 25,715 | 5,559 | 10,591 |
| 20 | 2.0 | 12,857 | 2,778 | 5,294 |
| **50** | **5.0** | **51,299** | **1,110** | **2,117** |
| 100 | 10.0 | 2,564 | 554 | 1,058 |

(For W≠50 the study used stride=W for comparability; the built W=50 set uses stride 5 on train.)

**Overlap:** train stride 5 → **90% overlap**; validation/test stride 50 → **0% overlap**, so
evaluation samples are independent. Overlap was applied strictly *after* split assignment.

---

## 6. Features and targets

**Baseline feature set A (6 channels):** `acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z` — bias-corrected.

`X_ext_*.npy` additionally stores `linear_acc_x/y/z`, `acc_mag`, `gyro_mag` (11 channels) so
sets B/C/D can be sliced by index without rebuilding. `feature_schema.json` holds the indices.

| Set | Channels | Description |
|---|---|---|
| A | 6 | acc XYZ + gyro XYZ (**baseline**) |
| B | 9 | A + linear_acc XYZ |
| C | 8 | A + acc/gyro magnitudes |
| D | 11 | A + linear_acc + magnitudes |

**Never used as input:** GPS latitude, longitude, speed, orientation, accuracy, satellites.
**Targets:** `target_v_forward` (m/s), `target_yaw_rate` (rad/s). **`target_v_lateral` is excluded** — established earlier to be unobservable.

Note `acc_z` has mean ≈ 9.80: feature set A retains gravity in the accelerometer (it is raw
specific force). Set B is the natural ablation against that.

### Distributions

| Split | v_forward mean±std (m/s) | range | yaw_rate mean±std (rad/s) | range |
|---|---|---|---|---|
| train | 9.15 ± 6.40 | 0.00 – 32.51 | −0.0023 ± 0.1287 | −0.897 – 0.826 |
| validation | 11.01 ± 6.19 | 0.01 – 26.91 | −0.0083 ± 0.1026 | −0.639 – 0.511 |
| test | 9.94 ± 5.67 | 0.00 – 27.76 | −0.0210 ± 0.1527 | −1.086 – 0.773 |

Test has the widest yaw-rate spread — consistent with an unseen driver and appropriate for a
generalisation test.

---

## 7. Normalisation

**Arrays on disk are RAW (unscaled).** The scaler is fitted on the **train split only** and
stored in `core/scaler/`. Verified: scaler mean matches train statistics and does **not** match
validation statistics (proving val/test never contributed).

```python
import numpy as np, json
sc = json.load(open('training_dataset/core/scaler/scaler.json'))
mu, sd = np.array(sc['feature_mean'])[:6], np.array(sc['feature_std'])[:6]
X = (np.load('training_dataset/core/train/X_train.npy') - mu) / sd
```

Raw storage is deliberate: it keeps the B/C/D ablations correct, since each feature subset
needs its own consistent scaling.

---

## 8. Quality control — 36/36 checks passed

No NaN/Inf in X, X_ext or y (all splits) · no duplicate windows · every window spans exactly
49 sample intervals (4.89–4.91 s) and 49 original rows · no window crosses a session boundary ·
no session in more than one split · test driver unseen in train · manifest matches metadata ·
scaler fitted on train only.

### Discarded windows — 115 total

| Split | Reason | Count |
|---|---|---|
| train | target invalid (no VBOX target at window end) | 111 |
| train | target not from VBOX | 1 |
| validation | target invalid | 2 |
| test | internal time gap (window spans a discontinuity) | 1 |

Zero windows were discarded for non-finite features or targets.

---

## 9. Known limitations

1. **No phone or vehicle diversity** under VBOX supervision (all Huawei P20 Pro / Ford Fiesta). The model cannot be shown to generalise across devices from this split. Drivers F/G/H (Motorola, Blackberry; Renault, Volvo, Toyota) exist only as GPS-supervised data — the natural out-of-distribution test set later.
2. **Only 3 drivers**, forcing a 25.3% test split.
3. **Driver E under-represented** by the high-confidence filter (see §2).
4. **90% train overlap** means effective independent sample count is far below 51,299; do not read the window count as independent evidence.
5. **No rotation applied** — the model sees phone-frame IMU and must learn the mounting relationship implicitly.

---

## 10. Files

```
training_dataset/core/split_manifest.csv          25 sessions with split assignment
training_dataset/core/train/X_train.npy           (51299, 50, 6)  float32  61.6 MB
training_dataset/core/train/X_ext_train.npy       (51299, 50, 11) float32 112.9 MB
training_dataset/core/train/y_train.npy           (51299, 2)      float32
training_dataset/core/validation/X_val.npy        (1110, 50, 6)
training_dataset/core/validation/X_ext_val.npy    (1110, 50, 11)
training_dataset/core/validation/y_val.npy        (1110, 2)
training_dataset/core/test/X_test.npy             (2117, 50, 6)
training_dataset/core/test/X_ext_test.npy         (2117, 50, 11)
training_dataset/core/test/y_test.npy             (2117, 2)
training_dataset/core/scaler/scaler.json|.npz     train-only statistics
training_dataset/core/metadata/metadata_{train,val,test}.parquet
training_dataset/reports/                         this report + schema + statistics
```

Metadata columns: `session_id, dataset_id, driver_id, vehicle_id, phone_id,
start_timestamp, end_timestamp, start_row_original, end_row_original, bias_applied`.
