# MATRIX Experiment F — 11-feature ablation

**Conclusion: keep the 6-feature model.** The extra channels produce no reliable
dead-reckoning improvement. Validation and test disagree in *sign*, and a paired per-session
analysis shows the effect is indistinguishable from session-to-session noise.

Baseline, Δv and complementary-fusion experiments untouched; dataset, split and windows
unchanged; τ = 20 s frozen and not retuned.

---

## 1. Exact feature list (verified before training)

`X_ext` channel order, read from the frozen `feature_schema.json`:

| idx | channel | idx | channel |
|---|---|---|---|
| 0 | `acc_x` | 6 | `linear_acc_x` |
| 1 | `acc_y` | 7 | `linear_acc_y` |
| 2 | `acc_z` | 8 | `linear_acc_z` |
| 3 | `gyro_x` | 9 | `acc_mag` |
| 4 | `gyro_y` | 10 | `gyro_mag` |
| 5 | `gyro_z` | | |

### Magnetometer and orientation are NOT in X_ext

The requested ablation groups **D (+magnetometer)** and **E (+orientation)** could not be
run. `X_ext` contains no `mag_*`, no `ori_*` and no raw `gravity_*` channels — those exist
only in `smartphone_enhanced/` and were never windowed into the training dataset. Adding them
would require re-windowing, which the rules forbid ("do not window differently", "do NOT
create arbitrary new preprocessing"). I did not invent them. The runnable groups are:

| Set | n | Channels |
|---|---|---|
| **A_imu6** | 6 | control |
| **B_imu_linacc** | 9 | A + `linear_acc_{x,y,z}` (this *is* the gravity group — see below) |
| **C_imu_mag** | 8 | A + `acc_mag`, `gyro_mag` |
| **D_all11** | 11 | everything |

Group "B (+gravity)" and "C (+linear acceleration)" from the requested list collapse into one
group here: since `linear_acc = acc − gravity` and `acc` is already present, adding
`linear_acc` supplies exactly the gravity information. Raw gravity would be linearly
redundant given the other two.

### Pre-registered structural finding (before any training)

| Pair | correlation | difference |
|---|---|---|
| `acc_x` vs `linear_acc_x` | **+0.999658** | mean −0.0001, std 0.034 |
| `acc_y` vs `linear_acc_y` | **+0.999659** | mean −0.00004, std 0.035 |
| `acc_z` vs `linear_acc_z` | **+0.999970** | mean **+9.80647**, std 0.005 |

The gravity channel is essentially the constant (0, 0, 9.80660) — established during
preprocessing — so `linear_acc` is `acc` minus a **constant**. After standardisation these
are affine duplicates. The standardised 11-channel space has **effective rank 8** (three
singular values are exactly zero).

**So "11 features" is really 6 IMU + 2 genuinely new nonlinear channels (`acc_mag`,
`gyro_mag`) + 3 redundant ones.** I recorded the prediction before training that at best a
marginal effect was plausible. That is what happened.

No transformation was duplicated: `acc`/`gyro` arrive bias-corrected from the dataset build,
`linear_acc` is reconstructed as `acc_corrected − gravity`, and the result was **verified
bit-for-bit identical to the frozen `X_ext` arrays** (max absolute difference 0.000e+00).

---

## 2. Validation results

Loss comparison for the 11-feature set (validation only): MSE nRMSE 0.49084 · MAE 0.49918 ·
**Huber 0.48270 ← selected** — the same loss selected in both previous experiments.

### Regression metrics (validation)

| Set | n feat | params | val nRMSE | **R² Δv** | **R² yaw** |
|---|---|---|---|---|---|
| A_imu6 | 6 | 150,914 | 0.48795 | 0.3848 | **0.9095** |
| B_imu_linacc | 9 | 151,874 | 0.48857 | 0.4080 | 0.8977 |
| C_imu_mag | 8 | 151,554 | 0.50276 | 0.3394 | 0.9073 |
| **D_all11** | 11 | 152,514 | **0.48270** | **0.4120** | 0.9050 |

**Reproducibility check passed:** retraining `A_imu6` here reproduced the frozen Δv model
exactly — val_loss 0.12635, nRMSE 0.48795, R² identical — confirming determinism and that
the X_ext index path is equivalent to the original 6-channel arrays.

Parameter counts differ only because the input convolution widens (+1,600 for 11 vs 6,
+1.1%). No other dimension changed.

### Dead reckoning with the frozen fusion (validation), % vs the 6-feature control

| Set | 10 s | 30 s | 60 s | 120 s | 300 s |
|---|---|---|---|---|---|
| B_imu_linacc | +0.1 | +11.0 | +15.4 | +13.7 | **+46.1** |
| C_imu_mag | +2.4 | +3.9 | +13.9 | +10.5 | +33.0 |
| D_all11 | +0.0 | +7.3 | +10.4 | +20.0 | +33.4 |

Positive = worse. **On validation the 6-feature control wins 14 of 15 comparisons.**

### The paradox, and its cause

On validation, `D_all11` had **better** regression metrics *and* **better** fused velocity
RMSE (1.137/2.307/2.941/3.438/3.793 vs the control's 1.106/2.323/3.030/3.584/3.990 m/s at
10/30/60/120/300 s) — yet **worse position error**. The cause is heading:

| Set | median \|heading error\| change vs control, 10 → 300 s |
|---|---|
| B_imu_linacc | +13.7% → **+83.4%** |
| C_imu_mag | −3.7% → +42.4% |
| D_all11 | +6.3% → **+71.1%** |

Aggregate yaw MAE/RMSE/R² were slightly *better* for D, but the **per-session yaw bias** grew
(e.g. S-Vw3: +0.00654 for A vs +0.01021 for D). Heading drift is driven by the low-frequency
component of yaw error, not its RMS — the same lesson Experiment E established for velocity.

---

## 3. Test (run once, after the decision was frozen)

The decision to keep 6 features was written to `frozen_decision.json` **before** any test
access. The test run confirms the comparison; it did not inform the choice.

### Fused (τ=20) median final position error, m

| Set | 10 s | 30 s | 60 s | 120 s | 300 s |
|---|---|---|---|---|---|
| **A_imu6 (frozen Exp E)** | 8.79 | 42.71 | 108.07 | 248.04 | 740.58 |
| B_imu_linacc | 7.57 | 38.99 | 102.20 | 256.60 | 739.51 |
| C_imu_mag | 8.02 | 41.15 | 105.03 | 255.67 | 680.39 |
| D_all11 | 8.07 | 42.92 | 96.32 | 254.10 | 684.75 |

% vs control: B **−13.9 / −8.7 / −5.4 / +3.5 / −0.1**, C −8.8 / −3.7 / −2.8 / +3.1 / −8.1,
D −8.2 / +0.5 / −10.9 / +2.4 / −7.5.

**The test reverses the validation result.** On validation the extra features were clearly
worse; on test they are mildly better.

### Secondary metrics (test)

Fused velocity RMSE (m/s): A 1.002/1.708/2.338/3.067/3.615 · D 0.912/1.795/2.408/3.145/3.551 —
mixed, no consistent winner.

Yaw (dense test, weighted): A MAE 0.01850 RMSE 0.04031 R² 0.91069 bias +0.00165 ·
D MAE 0.01816 RMSE 0.04052 R² 0.90927 bias +0.00137 — indistinguishable.

---

## 4. Is the effect real? A paired per-session test

Percentage change (11-feature vs 6-feature, fused) per session and horizon:

| split | session | 10 s | 30 s | 60 s | 120 s | 300 s |
|---|---|---|---|---|---|---|
| test | S-M_s00 | −3.6 | −5.2 | +1.2 | +8.2 | +3.2 |
| test | S-M_s01 | −7.8 | −6.2 | −6.9 | −1.1 | −11.8 |
| val | S-S3a_s00 | −4.3 | +1.1 | +24.1 | +32.4 | +43.0 |
| val | S-Vta16_s00 | −5.9 | −9.8 | −4.0 | +13.3 | −12.8 |
| val | S-Vta2_s00 | +0.5 | −9.8 | −24.1 | −2.5 | +23.8 |
| val | S-Vw11_s00 | −15.1 | +16.6 | −13.7 | +53.7 | +44.0 |
| val | S-Vw3_s00 | +21.6 | +13.5 | +32.7 | +21.7 | −5.9 |

| Statistic | Value |
|---|---|
| Cells where 11 features win | **18 of 35** |
| Cells where 6 features win | **17 of 35** |
| Mean change | +5.8% |
| Median change | **−1.1%** |
| Std across cells | **18.9%** |
| Validation mean / test mean | **+9.4% / −3.0%** (opposite signs) |

**The sign is a coin flip and the spread is three times the mean effect.** Per-session means
range from −6.8% to +19.2%. With 5 validation sessions from 2 drivers and 2 test sessions
from 1 driver, a 5–15% difference in median DR error is not resolvable — it is session
selection, not a feature effect.

This matches the pre-registered structural analysis exactly: with three affine-duplicate
channels and an effective rank of 8, there was never enough new information to expect a
robust gain.

---

## 5. Comparison with frozen Experiment E

The frozen Experiment-E system (6 features + Δv + fusion τ=20) remains the reference and is
unchanged: **8.79 / 42.71 / 108.07 / 248.04 / 740.58 m** at 10/30/60/120/300 s. No feature
variant beat it consistently across both splits, so Experiment E stands as the current best
configuration.

---

## 6. Conclusion

1. **The 11-feature set does not reliably improve dead reckoning.** It looked worse on validation (up to +46%), better on test (up to −14%), and a paired analysis puts the effect within noise.
2. **Regression metrics were misleading again.** `D_all11` improved val nRMSE and R²(Δv) and even velocity RMSE, while *degrading* validation trajectory error — because per-session yaw bias, which those metrics do not capture, grew. Third experiment in a row where window-level metrics failed to predict drift.
3. **The structural reason is clear.** 3 of the 5 extra channels are affine duplicates of channels already present (r > 0.9996); the standardised feature space has effective rank 8, not 11.
4. **Per the experiment rules, the 6-feature model is kept** — it is simpler, already frozen, and there is no evidence of a robust improvement.
5. **Magnetometer and orientation remain genuinely untested.** They are absent from `X_ext`. This is the one part of the original question that is still open, and answering it would require a dataset rebuild.

---

## 7. Limitations

1. **The intended magnetometer/orientation ablation was not possible** — those channels were never windowed. Note that 9 of 97 smartphone datasets lack them entirely (Driver F), so a rebuild would also shrink the usable set.
2. **Very low statistical power.** 5 validation sessions (2 drivers) and 2 test sessions (1 driver). Session-level variance dominates; this experiment can only detect large effects, and none was present.
3. **Single seed.** Every run used seed 1337 for comparability, so run-to-run variance is not separated from feature effects. With the observed 18.9% cell-to-cell spread, a seed sweep would likely swamp the feature difference.
4. **τ was frozen at 20 s**, as instructed. A feature set that changes the Δv error spectrum might pair better with a different τ; this was deliberately not explored.
5. The absolute-v side of the fusion always came from the frozen 6-feature baseline, so only the Δv head's features varied.

---

## 8. Recommendation for the next experiment

**Do not pursue features further.** Four experiments now agree that architecture and input
representation are not the limiting factors — target formulation (Δv), error structure
(fusion) and supervision quality are.

**Primary recommendation: Experiment C — add the medium-confidence VBOX sessions.** This is
now the highest-value open experiment, and the reason is visible in this report: the dominant
source of uncertainty here was *session-level variance* with only 18 training sessions. The
medium-confidence set adds 20 sessions and 275,453 target rows, roughly quadrupling Driver E's
contribution (63,714 → 339,167 rows) and restoring the aggressive-manoeuvre diversity the
strict filter removed. More sessions is the direct fix for the statistical power problem that
made this experiment inconclusive.

**Second: an uncertainty-weighted adaptive filter** (carried over from Experiment E) — set the
fusion gain from predicted variances rather than a fixed τ.

**Third, and cheap: a seed sweep.** Three or five seeds on the frozen 6-feature configuration
would quantify run-to-run variance, which this experiment shows is needed to interpret any
future comparison of this size.

I would not attempt the magnetometer/orientation rebuild until the above are done — it costs a
dataset rebuild and loses Driver F's 9 datasets.

---

## 9. Artifacts

```
model/experiments/feature_ablation/
  config.yaml                     frozen configuration
  frozen_decision.json            decision recorded BEFORE test access
  train_features.py               loss comparison + group ablation (never opens test)
  eval_features.py                DR evaluation; --split test run once
  checkpoints/best_{A_imu6,B_imu_linacc,C_imu_mag,D_all11}_huber.pt
  checkpoints/best_D_all11_{mse,mae}.pt
  history_loss.csv  history_ablation.csv
  loss_comparison.json  ablation_comparison.json
  validation_results/  dr_validation.csv, yaw_validation.csv
  test_results/        dr_test.csv, yaw_test.csv
  plots/               feature_ablation_dr.png, per_session_effect.png

reports/feature_ablation_report.md   this file
```

**Test-set integrity:** `train_features.py` reads only train and validation. The feature
decision, the loss (Huber), the ablation conclusions and the fusion configuration (τ = 20 s)
were all fixed and written to `frozen_decision.json` before `eval_features.py --split test`
was executed, and the decision was not revised afterwards despite the test result pointing the
other way.
