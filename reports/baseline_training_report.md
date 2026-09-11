# MATRIX Phase 1 — baseline training report

**Status:** baseline complete. Phase 2 experiments **prepared but not run**.
Preprocessing pipeline and raw IO-VNBD untouched (564/564 CSVs re-verified unchanged).

---

## 1. Dataset version

| | |
|---|---|
| Dataset version | `matrix-core-v1-vbox-high-confidence` |
| Location | `model/preprocessing/training_dataset/core/` |
| Supervision | **VBOX only, high-confidence targets only** |
| Excluded | GPS-supervised sessions, 20 medium-confidence VBOX sessions, Drivers F/G/H (reserved for OOD) |
| Sampling rate | **10.0 Hz, verified** (`dt_median = 0.1000 s` on every session) |
| Window | 50 samples = 5.0 s, causal, target at last sample |

### Sample counts

| Split | Windows | Sessions | Drivers | Stride | Overlap |
|---|---|---|---|---|---|
| **train** | **51,299** | 18 | A, E | 5 | 90% |
| **validation** | **1,110** | 5 | A, E | 50 | 0% |
| **test** | **2,117** | 2 | **B (unseen)** | 50 | 0% |

**Input shape:** `(N, 50, 6)` · **Target shape:** `(N, 2)`

Features: `acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z` (bias-corrected).
Targets: `target_v_forward` (m/s), `target_yaw_rate` (rad/s).
GPS, magnetometer, orientation, VBOX channels and `target_v_lateral` are **never** model inputs.

---

## 2. Architecture

`Conv1D → Conv1D → GRU → Dense → 2`

| Layer | Configuration |
|---|---|
| Conv1d | 6 → 64, kernel 5, padding 2 |
| BatchNorm1d + ReLU + Dropout | 64, p = 0.2 |
| Conv1d | 64 → 128, kernel 5, padding 2 |
| BatchNorm1d + ReLU + Dropout | 128, p = 0.2 |
| GRU | 128 → 128, 1 layer, batch-first |
| Take last timestep | causal — target at t |
| Linear + ReLU + Dropout | 128 → 64, p = 0.2 |
| Linear | 64 → 2 |

**Parameter count: 150,914.** Activation ReLU, dropout 0.2 throughout.

---

## 3. Training

Adam (lr 1e-3), batch 256, max 80 epochs, `ReduceLROnPlateau` (factor 0.5, patience 4),
early stopping patience 12, grad-clip 5.0, seed **1337**, `cudnn.deterministic = True`.

Targets are standardised with the train-only scaler so the loss is not dominated by
`v_forward` (σ 6.4) over `yaw_rate` (σ 0.13). Metrics below are in **physical units**.

### Loss comparison — selected on validation only

| Loss | Best epoch | Epochs run | Best val loss | **Val nRMSE** (selection metric) |
|---|---|---|---|---|
| MSE | 6 | 18 | 0.24496 | 0.45384 |
| MAE | 14 | 26 | 0.31369 | 0.46130 |
| **Huber (δ=1.0)** | **13** | 25 | **0.11397** | **0.44908** ← selected |

Raw loss values are not comparable across loss functions, so selection used a
loss-independent metric: mean normalised RMSE on validation. Differences are small
(0.449 vs 0.461); Huber wins modestly.

**Best epoch: 13. Best validation loss (Huber): 0.11397. Total epochs trained: 69 across all three runs.**

---

## 4. Test metrics — test split used ONCE, after selection

| Target | MAE | RMSE | R² | Mean error | Std error |
|---|---|---|---|---|---|
| `v_forward` (m/s) | 2.5387 | 3.6985 | **0.575** | **+1.0416** | 3.5488 |
| `yaw_rate` (rad/s) | 0.0187 | 0.0395 | **0.933** | −0.0020 | 0.0394 |

Validation, for reference: `v_forward` R² 0.533, `yaw_rate` R² 0.912 — so test is not
anomalously better or worse, and the unseen driver did not collapse performance.

**The headline result: yaw rate is learned well (R² 0.93); forward velocity is not (R² 0.58,
with a systematic +1.04 m/s bias).**

### Regime breakdown (test)

| Regime | n | v_forward MAE | v_forward R² | v bias | yaw MAE | yaw R² |
|---|---|---|---|---|---|---|
| speed low (<5 m/s) | 390 | 1.226 | −1.990 | +1.019 | 0.0119 | +0.970 |
| speed medium (5–15) | 1350 | 2.608 | −1.084 | +1.551 | 0.0225 | +0.929 |
| speed high (≥15) | 377 | 3.649 | −2.638 | −0.761 | 0.0122 | +0.720 |
| yaw low (<0.05 rad/s) | 1547 | 2.784 | +0.577 | +1.341 | 0.0110 | −0.858 |
| yaw high (≥0.05) | 570 | 1.872 | +0.526 | +0.230 | 0.0395 | +0.948 |

Negative R² **within** a narrow regime is expected and not a contradiction of the overall
R² = 0.575: conditioning on a speed band removes most of the variance, so a modest bias
exceeds the remaining within-band variance. The same applies to yaw in the low-yaw band
(near-straight driving).

---

## 5. Dead reckoning (the part that matters)

At each evaluation start the true position and heading are taken as given; predicted
`v_forward` and `yaw_rate` are then integrated (midpoint rule, dt = 0.1 s) into `x, y, heading`
and compared against the trajectory obtained by integrating the ground-truth targets over the
same interval. Dense stride-1 predictions were generated over the two test sessions
(105,876 windows) — same held-out sessions, evaluated more finely; no new data, no leakage.

| Outage | Segments | Median final err | Mean final err | P90 | Median traj RMSE | Median max err | Median heading err | Median drift/min | Median distance | **Err % of distance** |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 s | 353 | **19.0 m** | 23.2 | 48.4 | 10.9 | 19.1 | 3.3° | 114.1 m/min | 98 m | **21.0%** |
| 30 s | 351 | **58.4 m** | 70.7 | 141.9 | 34.7 | 59.5 | 7.5° | 116.8 | 296 m | 21.4% |
| 60 s | 348 | **127.2 m** | 148.9 | 270.8 | 72.9 | 130.8 | 12.2° | 127.2 | 574 m | 22.5% |
| 120 s | 342 | **286.2 m** | 326.9 | 605.1 | 164.6 | 298.6 | 22.0° | 143.1 | 1145 m | 25.7% |
| 300 s | 324 | **917.7 m** | 1036.5 | 1904.5 | 512.3 | 964.2 | 54.3° | 183.5 | 2916 m | 32.5% |

This is **not** competitive dead reckoning. It is an honest first baseline, and the error
attribution below says exactly why.

### Error attribution — median final position error (m)

| Outage | Both predicted | Predicted v, **true** yaw | **True** v, predicted yaw | Bias-removed v (oracle) |
|---|---|---|---|---|
| 10 s | 19.01 | 16.70 | **2.72** | **3.07** |
| 30 s | 58.39 | 45.03 | **18.11** | 20.88 |
| 60 s | 127.17 | 88.24 | 53.69 | 62.51 |
| 120 s | 286.23 | **150.76** | 161.62 | 171.13 |
| 300 s | 917.71 | **259.45** | 730.48 | 759.62 |

Two clean conclusions:

1. **Short outages (≤60 s) are dominated by velocity error.** With true yaw the error is still 16.7 m at 10 s; with true velocity it is only 2.7 m. Removing the velocity *bias* alone (an oracle diagnostic, uses ground truth) cuts 10 s error from 19.0 m to 3.1 m — **an 84% reduction**.
2. **Long outages (≥120 s) are dominated by yaw drift.** A yaw bias of only −0.002 rad/s integrates to ~50° over 300 s, which rotates the whole path: 730 m error even with perfect velocity.

The trajectory plots show this directly — the predicted path reproduces the *shape* of the
turns (yaw is good) but overshoots along-track (velocity over-predicted).

### Why velocity is hard — and it is not a bug

Absolute forward speed is **not directly observable** from a 5 s IMU window. At constant
velocity an accelerometer reads nothing that distinguishes 5 m/s from 25 m/s; the IMU observes
*changes* in motion. The network can only infer speed indirectly from vibration amplitude and
road noise, which is device-, road- and vehicle-specific — and the test driver is unseen.
Yaw rate, by contrast, is measured *directly* by the gyroscope, which is exactly why it reaches
R² = 0.93 while velocity reaches 0.58.

---

## 6. Test-set integrity

**Verified: the test split was never used for model selection.**

- `train_baseline.py` never opens the `test/` directory — loss selection, early stopping and checkpointing read validation only.
- Loss choice (Huber) was made on validation nRMSE; recorded in `loss_comparison.json` with `test_used_for_selection: false`.
- The test split is first read in `evaluate_baseline.py`, after the checkpoint is frozen.
- No hyperparameter was tuned on test; no result below was used to revisit any earlier choice.

The bias-removed column in the attribution table uses ground truth and is explicitly labelled
an **oracle diagnostic** — it is not a result the model achieves.

---

## 7. Limitations

1. **Velocity head is the bottleneck** (R² 0.58, +1.04 m/s bias). Everything downstream inherits it.
2. **No phone or vehicle diversity.** All 45 VBOX sessions are one Huawei P20 Pro in one Ford Fiesta — VBOX only existed in the research vehicle. Cross-device generalisation is untestable here.
3. **Only 3 drivers**, so test is a single unseen driver (B) and 25.3% of the data. One driver is a thin basis for a generalisation claim.
4. **Driver E under-represented** by the high-confidence filter (63,714 of 339,167 target rows), removing much aggressive-manoeuvre diversity.
5. **90% train overlap** means 51,299 windows are far from 51,299 independent samples.
6. **No coordinate rotation applied**, so the model must learn the mounting relationship implicitly from a single mounting configuration.
7. **Early stopping fired early** (best epoch 13 of 80) — the model saturates quickly, consistent with a weakly-observable target rather than insufficient capacity. Adding capacity is unlikely to help; changing the target formulation is.
8. Metrics are regression metrics only. **No "accuracy %" is reported** — it would be meaningless here.

### What the evidence says to try next (not yet run)

- Predict **Δv** (acceleration) and integrate with anchoring, instead of absolute v — directly targets the observability problem.
- Experiment C/D (medium-confidence data) to restore Driver E diversity.
- Experiment B (11 features) — `linear_acc` removes the ~9.8 m/s² constant in `acc_z`.
- A velocity-bias correction term, or per-session calibration at outage start.

---

## 8. Artifacts

```
model/baseline/
  config.yaml                         frozen configuration
  train_baseline.py                   training (never reads test/)
  evaluate_baseline.py                evaluation + dead reckoning
  checkpoints/best_{mse,mae,huber}.pt
  training_history.csv                69 epochs, all three losses
  loss_comparison.json                selection record
  metrics.json                        all metrics
  predictions/  predictions_{val,test}.csv, dense_S-M_s0{0,1}.parquet,
                dead_reckoning_outages.csv, dead_reckoning_summary.csv,
                error_attribution.csv
  plots/        trajectory_S-M_s0{0,1}_{60,300}s.png, predictions_test.png,
                training_curves.png
  README.md

model/experiments/experiments.yaml    Phase 2 A/B/C/D — PREPARED, NOT RUN
reports/baseline_training_report.md   this file
```
