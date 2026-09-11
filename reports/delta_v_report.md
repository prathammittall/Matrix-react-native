# MATRIX — Δv velocity-target experiment

**Question:** is the baseline's dead-reckoning error caused by the velocity *target
formulation* rather than by architecture or features?

**Answer: partly — and the result is horizon-dependent.** Δv clearly wins for short GNSS
outages (≤30 s) and clearly loses for long ones (≥60 s). The mechanism is identified below.

Baseline untouched. Split, inputs, architecture, seed and methodology identical.
Experiment B (11 features) and medium-confidence data were **not** run.

---

## 1. Why absolute velocity is weakly observable from a short IMU window

An accelerometer measures specific force, not speed. In steady cruise the IMU signature at
5 m/s and at 25 m/s is essentially the same, so a 5 s window contains almost no direct
evidence of absolute speed — the network can only infer it indirectly from vibration
amplitude and road-noise spectrum, which vary by road surface, vehicle and phone mounting.

Δv is different: `v[t] − v[t−k]` is the integral of longitudinal acceleration over the
window, and acceleration **is** directly measured. The target moves from
weakly-observable to directly-observable.

The baseline's numbers show the symptom: `v_forward` R² 0.575 with a **+1.04 m/s systematic
bias**, versus `yaw_rate` R² 0.933 — and gyroscopes measure yaw rate directly.

---

## 2. Δv formulations investigated

| | Horizon | Definition |
|---|---|---|
| **A** | k=1 | `v[t] − v[t−1]` (0.1 s) |
| **B** | k=5 | `v[t] − v[t−5]` (0.5 s) |
| **C** | k=10 | `v[t] − v[t−10]` (1.0 s) |

### Data defect found and handled

The VBOX GPS velocity **drops to 0 for a single sample and recovers** — e.g. in `S-S1_s00`:
26.065 → **0.000** → 1.174 → 3.675 m/s, while yaw rate stays smooth at −0.11 rad/s, so the
car was plainly still moving. 11 such events in 313,585 steps (0.0035%). Unfiltered, each
becomes a ±26 m/s Δv target that would dominate any squared loss.

Validity therefore requires both endpoints high-confidence, the span contiguous in time, and
|acceleration| ≤ **15 m/s² (1.53 g)** — justified because p99.9 of the observed distribution
is 7.9 m/s² and a road car cannot exceed ~1.2 g. This removes 0.017% of samples and keeps
every genuine hard brake. Windows dropped: train 8, validation 0, test 0.

### Is the target noise-dominated?

| k | Δv std (m/s) | Implied accel std (m/s²) | Lag-1 autocorr | r vs VBOX accelerometer |
|---|---|---|---|---|
| 1 | 0.134 | **1.344** | **0.147** | 0.358 |
| 5 | 0.422 | **0.843** | 0.931 | 0.594 |
| 10 | 0.786 | 0.786 | 0.979 | 0.651 |

Reference: the VBOX's own longitudinal accelerometer has std **0.868 m/s²**.

**k=1 is noise-dominated.** Its lag-1 autocorrelation of 0.147 is nearly white, and its
implied acceleration std (1.344) is 55% above the true value — that excess is
differentiation noise, not vehicle dynamics. k=5 matches the true magnitude best (0.843 vs
0.868); k=10 slightly over-smooths (0.786).

---

## 3. Validation comparison

### Predictive quality (Huber, validation only)

| k | Best epoch | Val nRMSE | **R² Δv** | R² yaw |
|---|---|---|---|---|
| 1 | 9 | 0.63867 | **0.083** | 0.914 |
| 5 | 16 | 0.48795 | **0.385** | 0.910 |
| 10 | 20 | 0.48131 | **0.416** | 0.911 |

k=1 is barely predictable (R² 0.083), exactly as the noise analysis predicted.

### Downstream anchored dead reckoning (validation) — median final position error (m)

| Outage | k=1 | k=5 | k=10 |
|---|---|---|---|
| 10 s | 10.90 | 9.86 | **9.10** |
| 30 s | 70.60 | 64.90 | **61.05** |
| 60 s | 215.51 | **173.34** | 201.58 |
| 120 s | 540.74 | **482.41** | 513.11 |
| 300 s | 2120.93 | **1884.18** | 1884.60 |

(stride reconstruction; mean rank across horizons: k=5 **1.4**, k=10 1.6, k=1 3.0)

### Clipping

Clip bounds from the train distribution (p0.1/p99.9) produced **identical** median, p90 and
max error at k=5. Predictions simply never leave the training range, so clipping is
unjustified and **was not applied**. No other correction factor was introduced.

---

## 4. Selected formulation: **k = 5 (0.5 s)**

Not chosen on raw loss — k=10 has marginally better R² (0.416 vs 0.385). Chosen because:

1. **Physical fidelity:** k=5's implied acceleration std (0.843 m/s²) matches the VBOX accelerometer (0.868) most closely; k=10 over-smooths to 0.786.
2. **Best at the operationally relevant horizons** — wins at 60 s and 120 s, the durations that matter for tunnels and urban canyons.
3. **Best mean rank** (1.4) under the stride reconstruction that uses each prediction exactly once.
4. **Twice the velocity update rate** (2 Hz vs 1 Hz), so half the reconstruction lag.

**Honest caveat:** k=5 and k=10 are statistically close, and k=10 wins at 10 s and 30 s. This
choice is a judgement on physical suitability, not a decisive empirical separation.

Loss comparison at k=5 (validation only): MSE nRMSE 0.49927 · MAE 0.48902 · **Huber 0.48795 ← selected** (best epoch 16).

---

## 5. Test metrics (test opened once, after all selection)

| Target | MAE | RMSE | R² | Mean error |
|---|---|---|---|---|
| `dv5` (m/s per 0.5 s) | 0.1667 | 0.2781 | 0.467 | −0.0563 |
| `yaw_rate` (rad/s) | 0.0185 | 0.0408 | **0.928** | **+0.00024** |

**Effect on the yaw task (requirement 6):** changing the velocity target left yaw R²
essentially unchanged (0.928 vs baseline 0.933) but reduced the **yaw bias 8×**
(+0.00024 vs −0.0020 rad/s). That matters downstream: median heading error at 300 s falls
from **54.3° to 29.6°**. Changing the velocity target *helped* the yaw head.

---

## 6. Dead-reckoning comparison (test, unseen Driver B)

Median final position error (m), 324–353 segments per horizon:

| Outage | A baseline raw | A2 baseline **+ same anchor** | **B Δv anchored** | C oracle v + pred yaw | D pred v + oracle yaw |
|---|---|---|---|---|---|
| 10 s | 19.01 | 13.52 | **8.73** | 2.31 | 6.85 |
| 30 s | 58.39 | 51.53 | **46.88** | 14.70 | 38.15 |
| 60 s | 127.17 | **118.28** | 137.09 | 45.24 | 118.07 |
| 120 s | 286.23 | **279.34** | 387.02 | 131.37 | 318.58 |
| 300 s | 917.71 | **934.66** | 1217.91 | 480.30 | 1158.64 |

**A2 is the fair comparison.** The Δv model is handed the true velocity at outage start, so
the baseline is given the same anchor as a constant offset correction. Even against A2, Δv
wins at 10 s (8.73 vs 13.52, **−35%**) and 30 s (46.88 vs 51.53, **−9%**).

As a fraction of distance travelled, the 10 s error drops from 21.9% (baseline raw) to
**10.0%** (Δv).

---

## 7. Error attribution — why the crossover happens

Median velocity RMSE during the outage (m/s):

| Outage | Baseline raw | Baseline anchored | **Δv anchored** |
|---|---|---|---|
| 10 s | 2.433 | 1.945 | **0.957** |
| 30 s | 2.941 | 2.582 | **2.004** |
| 60 s | 3.133 | 2.980 | 3.374 |
| 120 s | 3.471 | 3.387 | 5.453 |
| 300 s | 3.621 | 3.645 | **8.408** |

This is the whole story:

- The **absolute-v model has a bounded error** — a roughly constant bias that saturates near 3.6 m/s no matter how long the outage runs.
- The **Δv model is an open-loop integrator** — its velocity error is a random walk that starts 2.5× smaller but grows without limit, reaching 8.4 m/s at 300 s.
- They cross between **30 s and 60 s**, which is exactly where the position-error ranking flips.

Yaw is *not* the limiting factor for either model at short range: with oracle velocity
(variant C) the 300 s error is still 480 m, versus 918 m for the baseline — so velocity
remains dominant even at 300 s.

---

## 8. Does Δv actually improve trajectory drift?

**Yes for outages ≤30 s; no beyond that.**

| | Verdict |
|---|---|
| 10 s | **−54% vs baseline raw, −35% vs anchored baseline** |
| 30 s | −20% raw, −9% anchored |
| 60 s | +8% worse than anchored baseline |
| 120 s | +39% worse |
| 300 s | +30% worse |

Plus an unconditional win: the yaw head's bias dropped 8×, halving heading drift at 300 s.

The hypothesis that motivated this experiment — that the velocity *target formulation*, not
the architecture, was the bottleneck — is **confirmed for short horizons and refuted as a
complete fix**. Removing the bias (what Δv achieves) is not the same as bounding the error
(what the absolute target achieves).

**The evidence points to a fusion, not a choice:** the two velocity estimators have
complementary error structures — Δv is unbiased but drifts, absolute-v is biased but
bounded. A complementary filter (Δv at high frequency, absolute-v as the low-frequency
anchor) should beat both at every horizon. Its time constant is a hyperparameter and must be
tuned on validation. **I did not implement it**, since it is a new method beyond this
experiment's scope and the instruction was to stop after the Δv results.

---

## 9. Limitations

1. **Anchor is idealised.** Both B and A2 receive the true velocity at outage start. In deployment that anchor comes from the last GNSS fix and carries its own error, which this evaluation does not model.
2. **k=5 vs k=10 is not decisively separated** — selection leaned on physical reasoning.
3. **Δv R² is only 0.467 on test.** Better than absolute-v in structure, but the target is still far from fully predicted.
4. **One unseen driver, one phone, one vehicle** (Driver B, Huawei P20 Pro, Ford Fiesta) — every baseline limitation carries over.
5. **Velocity floored at 0**; no other correction applied. Clipping was tested and rejected as unjustified.
6. **Reconstruction is open-loop by construction** — no GNSS updates within an outage, which is the point of the test but also the cause of the long-horizon drift.
7. Evaluation uses the ground-truth-integrated trajectory as reference, so it isolates model error and excludes VBOX's own positioning error.

---

## 10. Artifacts

```
model/experiments/delta_v/
  config.yaml                       frozen configuration
  build_dv_targets.py               dv targets + physical validity bound
  train_delta_v.py                  stage 1 horizons, stage 2 losses (never opens test/)
  dv_common.py                      dense prediction + anchored reconstruction
  select_formulation.py             horizon selection on VALIDATION only
  evaluate_delta_v.py               first and only use of the test split
  checkpoints/  best_k{1,5,10}_huber.pt, best_k5_{mse,mae}.pt
  dv_target_summary.csv  dv_target_config.json
  history_formulation.csv  formulation_comparison.json
  formulation_validation_dr.csv  formulation_selection.json
  training_history.csv  loss_comparison.json  metrics.json
  predictions/  predictions_test.csv, dense_S-M_s0{0,1}.parquet,
                dead_reckoning_outages.csv, dead_reckoning_summary.csv
  plots/        trajectory_S-M_s0{0,1}_{60,300}s.png, drift_comparison.png

reports/delta_v_report.md           this file
```

**Test-set integrity:** `build_dv_targets.py` writes test targets but never inspects them for
any decision; `train_delta_v.py` and `select_formulation.py` read only train and validation.
The horizon (k=5) and the loss (Huber) were fixed before `evaluate_delta_v.py` ran.
`metrics.json` records `test_used_for_selection: false`.
