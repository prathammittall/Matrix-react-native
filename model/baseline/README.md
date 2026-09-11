# MATRIX baseline (Phase 1)

Conv1D → Conv1D → GRU → Dense → 2, trained on the strict high-confidence VBOX-supervised
dataset. **No Phase 2 experiment has been run.**

| | |
|---|---|
| Dataset | `matrix-core-v1-vbox-high-confidence` |
| X / y | `(N, 50, 6)` / `(N, 2)` |
| Train / val / test | 51,299 / 1,110 / 2,117 windows |
| Drivers | train+val A, E · test **B (unseen)** |
| Parameters | 150,914 |
| Selected loss | Huber (validation nRMSE 0.4491) |
| Best epoch | 13 |
| Test R² | `yaw_rate` **0.933** · `v_forward` **0.575** |
| DR final error | 19 m @10 s · 127 m @60 s · 918 m @300 s (median) |

## Headline finding

Yaw rate is learned well; **forward velocity is the bottleneck**. Error attribution:
short outages (≤60 s) are dominated by velocity bias, long outages (≥120 s) by yaw drift.
Removing the velocity bias alone cuts 10 s error from 19.0 m to 3.1 m (oracle diagnostic).

Absolute speed is not directly observable from a 5 s IMU window — a constant-velocity
accelerometer reading cannot distinguish 5 m/s from 25 m/s. Yaw rate is measured directly
by the gyroscope, which is why it reaches R² 0.93.

## Reproduce

```bash
python model/baseline/train_baseline.py      # seed 1337, deterministic; never reads test/
python model/baseline/evaluate_baseline.py   # first and only use of the test split
```

## Test integrity

`train_baseline.py` never opens `test/`. Loss selection, early stopping and checkpointing use
validation only (`loss_comparison.json` → `test_used_for_selection: false`).

See `../../reports/baseline_training_report.md` for the full report.
