# MATRIX — RUN.md

Operating manual for the **frozen** MATRIX dead-reckoning system.

> **Documentation only.** Every command below was executed against this repository and
> corresponds to a real script. Where a capability does not exist it is marked
> **NOT CURRENTLY IMPLEMENTED** rather than invented.

**The final system is two frozen models plus a filter — not one model:**

| Component | Artifact | Role |
|---|---|---|
| Δv model | `model/experiments/delta_v/checkpoints/best_k5_huber.pt` | predicts Δv (k=5) + yaw_rate |
| absolute-v model | `model/baseline/checkpoints/best_huber.pt` | low-frequency velocity anchor for the filter |
| complementary filter | τ=20 s, k=5, dt=0.1, velocity floor 0 | fuses the two velocity estimates |

Both checkpoints are required. The filter has no weights; it is code plus
`model/experiments/complementary_fusion/frozen_fusion_config.json`.

---

## 0. Quick start

```powershell
# 1. environment
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype"
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt          # ~2.5 GB (CUDA torch wheel) — allow time

# 2. verify GPU
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"

# 3. verify dataset (see Section 3 for the full check)
python -c "import numpy as np; a=np.load(r'model\preprocessing\training_dataset\core\train\X_train.npy',mmap_mode='r'); print(a.shape, a.dtype)"

# 4. train (absolute-v model, then Δv model)
cd model\baseline;                   python train_baseline.py
cd ..\experiments\delta_v;           python build_dv_targets.py; python train_delta_v.py --stage loss --k 5

# 5. dense predictions from both frozen models
cd ..\complementary_fusion;          python generate_dense.py

# 6. validation + freeze fusion
python phase2_4_fusion_select.py

# 7. test (once, after freezing)
python phase5_test.py
```

Total training time on an RTX 3050 6 GB: **~8 minutes** (6 short runs).

---

## 1. Project structure

```
Pre ppt round prototype/
├── requirements.txt                         pinned dependencies (see Section 2)
├── mobile/                                  Expo/React-Native app ("matrix") — UI scaffold only,
│                                            NO model integration (see Section 13)
├── reports/                                 experiment reports (read these for context)
│   ├── baseline_training_report.md
│   ├── delta_v_report.md
│   ├── complementary_fusion_report.md
│   └── feature_ablation_report.md
└── model/
    ├── RUN.md                               this file
    ├── dataset/                             RAW IO-VNBD, 2.1 GB, READ-ONLY. Never modified.
    │   ├── Synchronised V abd S datasets/
    │   ├── Unsynchronised V and S Dataset/
    │   └── README.md, README_1.pdf
    ├── preprocessing/                       pass1..pass12 pipeline + derived data
    │   ├── common.py                        shared loaders, column mapping
    │   ├── pass1_scan.py ... pass12_build_training.py
    │   ├── an1..an5.py                      ad-hoc analysis helpers (not part of the pipeline)
    │   ├── outputs/                         inventory, reports, manifests, calibration
    │   ├── smartphone_core/                 90 sessions, canonical core schema (parquet)
    │   ├── smartphone_enhanced/             88 sessions incl. mag/orientation (NOT used by the model)
    │   ├── vehicle_reference/               162 VBOX files — supervision only, never model input
    │   ├── calibration/                     3 stationary sessions + sensor_bias_estimates.csv
    │   ├── targets/                         103 per-session target files (v_forward, yaw_rate, flags)
    │   └── training_dataset/core/           THE ML DATASET (see Section 3)
    ├── baseline/                            absolute-v model (FROZEN — part of the final system)
    │   ├── train_baseline.py, evaluate_baseline.py, config.yaml, README.md
    │   └── checkpoints/best_{mse,mae,huber}.pt
    └── experiments/
        ├── experiments.yaml                 Phase-2 ablation definitions
        ├── delta_v/                         Δv model (FROZEN — part of the final system)
        │   ├── build_dv_targets.py, train_delta_v.py, dv_common.py,
        │   │   select_formulation.py, evaluate_delta_v.py, config.yaml
        │   ├── targets/dv_targets_{train,val,test}.parquet
        │   └── checkpoints/best_k{1,5,10}_huber.pt, best_k5_{mse,mae}.pt
        ├── complementary_fusion/            THE FINAL PIPELINE (FROZEN)
        │   ├── generate_dense.py, phase1_characterize.py,
        │   │   phase2_4_fusion_select.py, phase5_test.py, config.yaml
        │   ├── frozen_fusion_config.json    τ=20 s — the frozen selection
        │   ├── predictions/dense/{train,validation,test}/<session>.parquet
        │   ├── validation_results/, test_results/, plots/
        └── feature_ablation/                Experiment F — concluded "keep 6 features"
```

`dv_common.py` (in `delta_v/`) is the shared inference library: session loading, dense
windowing, prediction, velocity reconstruction and dead reckoning. `phase2_4_fusion_select.py`
holds the filter implementation (`complementary`, `v_delta_stride`, `v_abs_anchored`,
`dead_reckon`), imported by the later scripts.

---

## 2. Environment setup

Versions **read from the machine this was built and verified on**:

| Component | Version |
|---|---|
| OS | Windows 11 (10.0.26200), AMD64 |
| Python | **3.13.12** |
| PyTorch | **2.10.0+cu126** |
| CUDA (torch build) | **12.6** |
| cuDNN | 91002 |
| GPU | NVIDIA GeForce RTX 3050 6 GB Laptop |
| numpy / pandas | 2.1.2 / 2.2.3 |
| scipy | 1.16.2 |
| pyarrow / matplotlib | 25.0.1 / 3.9.2 |

**Dependencies are pinned in `requirements.txt` at the project root.** MATRIX imports exactly
five third-party packages — `torch`, `numpy`, `pandas`, `scipy`, `matplotlib` — plus `pyarrow`
as the parquet engine pandas uses under the hood. `pyyaml` and `scikit-learn` are **not**
imported by any script (the `*.yaml` files are frozen configuration records read by humans,
not parsed by code), and `torchvision`/`torchaudio` are not used.

```powershell
pip install -r requirements.txt
```

`requirements.txt` carries `--extra-index-url https://download.pytorch.org/whl/cu126` because
`torch==2.10.0+cu126` is a CUDA build published by PyTorch, not on PyPI. For a CPU-only
machine, drop that line and the `+cu126` suffix.

### Virtual environment — PowerShell

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype"
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
```
If activation is blocked: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

### Virtual environment — CMD

```cmd
cd /d "D:\Projects\Dead Reaconking system\Pre ppt round prototype"
py -3.13 -m venv .venv
.venv\Scripts\activate.bat
```

### Verification command

```powershell
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
```
Expected on the reference machine:
```
2.10.0+cu126
True
NVIDIA GeForce RTX 3050 6GB Laptop GPU
```

Full check:
```powershell
python -c "import sys,torch,numpy,pandas,scipy,pyarrow,matplotlib; print('python',sys.version.split()[0]); print('torch',torch.__version__,'cuda',torch.version.cuda,'avail',torch.cuda.is_available()); print('numpy',numpy.__version__,'pandas',pandas.__version__,'scipy',scipy.__version__); print('pyarrow',pyarrow.__version__,'matplotlib',matplotlib.__version__)"
```

CPU-only works (everything falls back automatically) but training is several times slower.

---

## 3. Dataset verification

### The ML dataset

Location: `model/preprocessing/training_dataset/core/`

| File | Shape | dtype |
|---|---|---|
| `train/X_train.npy` | **(51299, 50, 6)** | float32 |
| `train/X_ext_train.npy` | (51299, 50, 11) | float32 (ablation only; **not** used by the final model) |
| `train/y_train.npy` | (51299, 2) | float32 |
| `validation/X_val.npy` | **(1110, 50, 6)** | float32 |
| `validation/y_val.npy` | (1110, 2) | float32 |
| `test/X_test.npy` | **(2117, 50, 6)** | float32 |
| `test/y_test.npy` | (2117, 2) | float32 |

- **Window:** 50 samples = 5.0 s, causal, target at the last sample.
- **Sampling frequency: exactly 10.0 Hz** (`dt_median = 0.1000 s` on all 45 VBOX sessions — measured, not assumed).
- **Feature order (fixed):** `acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z`, bias-corrected, gravity **not** removed from `acc`.
- **`y_*.npy` holds `[target_v_forward (m/s), target_yaw_rate (rad/s)]`.** The final model does **not** train on column 0 of this file — it trains on Δv from `experiments/delta_v/targets/dv_targets_*.parquet`, which carries `dv5` plus `yaw_rate`.

### Supporting files

| File | Purpose |
|---|---|
| `core/scaler/scaler.json` / `.npz` | train-only scaler, **11** feature means/stds (use `[:6]` for the final model) |
| `core/split_manifest.csv` | 25 sessions with split assignment (18 train / 5 val / 2 test) |
| `core/metadata/metadata_{train,val,test}.parquet` | per-window session, driver, timestamps, original row indices |
| `preprocessing/outputs/feature_schema.json` | canonical channel order and feature-set index map |
| `experiments/delta_v/targets/dv_targets_*.parquet` | Δv targets + validity masks |

### Verification command

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype\model"
python -c "import numpy as np,pandas as pd,json,os; D=r'preprocessing\training_dataset\core'; [print(f'{s}/{n}', np.load(os.path.join(D,s,n),mmap_mode='r').shape, np.load(os.path.join(D,s,n),mmap_mode='r').dtype) for s,n in [('train','X_train.npy'),('train','y_train.npy'),('validation','X_val.npy'),('validation','y_val.npy'),('test','X_test.npy'),('test','y_test.npy')]]; sc=json.load(open(os.path.join(D,'scaler','scaler.json'))); print('scaler fitted_on:',sc['fitted_on'],'n_feat:',len(sc['feature_mean'])); m=pd.read_csv(os.path.join(D,'split_manifest.csv')); print('sessions per split:',m.groupby('split').size().to_dict())"
```

NaN/Inf and split-integrity check:
```powershell
python -c "import numpy as np,pandas as pd,os; D=r'preprocessing\training_dataset\core'; [print(t,'finite X:',bool(np.isfinite(np.load(os.path.join(D,s,f'X_{t}.npy'))).all()),'finite y:',bool(np.isfinite(np.load(os.path.join(D,s,f'y_{t}.npy'))).all())) for t,s in [('train','train'),('val','validation'),('test','test')]]; M={t:pd.read_parquet(os.path.join(D,'metadata',f'metadata_{t}.parquet')) for t in ['train','val','test']}; S={k:set(v.session_id) for k,v in M.items()}; print('session overlap train/val:',S['train']&S['val'],'train/test:',S['train']&S['test'],'val/test:',S['val']&S['test']); print('test drivers:',sorted(set(M['test'].driver_id)),'train drivers:',sorted(set(M['train'].driver_id)))"
```
Expected: all `True`, all overlaps empty (`set()`), test driver `['B']` disjoint from train `['A','E']`.

### Raw dataset integrity (optional, ~2 min)

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype"
python -c "import json,os,hashlib; ROOT=r'model\dataset'; rows=json.load(open(r'model\preprocessing\outputs\pass1_files.json',encoding='utf-8'))
def s(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda: f.read(1<<20), b''): h.update(b)
    return h.hexdigest()
bad=[r['rel_path'] for r in rows if s(os.path.join(ROOT,r['rel_path']))!=r['sha256']]
print(len(rows),'CSVs ->','ALL UNCHANGED' if not bad else bad[:3])"
```

### Failure behaviour (honest assessment)

The training scripts **do not have explicit pre-flight validation**. They fail as follows:

| Condition | Behaviour |
|---|---|
| Missing `.npy` | `FileNotFoundError` — clear |
| Missing `scaler.json` | `FileNotFoundError` — clear |
| Wrong feature count | `RuntimeError: Given groups=1, weight of size [64, 6, 5], expected input[...]` — clear once you know to read the channel dim |
| NaN/Inf in X | **Silent** — loss becomes `nan`. Run the NaN check above first. |
| Inconsistent split manifest | **Silent** in training; caught by the overlap check above |

> **NOT CURRENTLY IMPLEMENTED — a pre-flight QC script.** The 36-check QC used when the
> dataset was built was an ad-hoc inline script and was not saved. The two verification
> commands above reproduce its most important checks.

---

## 4. Final training

The final system needs **two** models trained in this order.

### TRAIN COMMAND

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\baseline"
python train_baseline.py

cd "..\experiments\delta_v"
python build_dv_targets.py
python train_delta_v.py --stage loss --k 5
```

| Step | Writes | Time (RTX 3050) |
|---|---|---|
| `train_baseline.py` | `baseline/checkpoints/best_{mse,mae,huber}.pt`, `training_history.csv`, `loss_comparison.json` | ~4.3 min |
| `build_dv_targets.py` | `delta_v/targets/dv_targets_{train,val,test}.parquet`, `dv_target_summary.csv`, `dv_target_config.json` | <1 min |
| `train_delta_v.py --stage loss --k 5` | `delta_v/checkpoints/best_k5_{mse,mae,huber}.pt`, `training_history.csv`, `loss_comparison.json` | ~6.3 min |

**Both scripts train all three losses (MSE, MAE, Huber) in one run.** There is no flag to
train Huber alone; the loss comparison is part of the methodology. Huber is selected
automatically and recorded in `loss_comparison.json`.

- **Checkpoints:** written on every validation improvement to `checkpoints/best_<name>.pt`. The final model is `best_k5_huber.pt`.
- **Logs:** stdout only — **no log file is written.** Redirect if you want one: `python train_delta_v.py --stage loss --k 5 | Tee-Object train.log`
- **History:** `training_history.csv` — per-epoch `train_loss`, `val_loss`, `val_nrmse`, `val_r2_dv`, `val_r2_yaw`, `lr`.
- **Best-checkpoint rule:** lowest **validation loss** (`vl < best - 1e-5`). The *loss function* is then chosen across runs by lowest **validation mean normalised RMSE** (loss-independent, so MSE/MAE/Huber are comparable).
- **Early stopping:** patience **12** epochs without validation improvement, max **80** epochs.
- **Scheduler:** `ReduceLROnPlateau(factor=0.5, patience=4, min_lr=1e-6)` on validation loss.
- The test split is **never opened** by either training script.

Expected result (seed 1337, deterministic): `best_k5_huber.pt` at **epoch 16**,
val_loss **0.12635**, 150,914 parameters.

### Do NOT run these (experiment-only)

`train_delta_v.py --stage formulation` (horizon search, already concluded k=5) and
`feature_ablation/train_features.py` (already concluded: keep 6 features).

---

## 5. Resume training

> **NOT CURRENTLY IMPLEMENTED.**

There is no resume capability. Verified: no `--resume` argument exists in any script, and no
optimizer/scheduler state is saved — `torch.save` stores only
`{model, epoch, val_loss, val_nrmse, loss_fn, seed, n_params}` (plus `target_mean`/`target_std`
for the Δv model). If training is interrupted, **re-run the command from the start.**

This is acceptable because a full run is ~6 minutes. Adding resume would require saving
`optimizer.state_dict()`, `scheduler.state_dict()`, the epoch counter and the early-stopping
counter, plus a `--resume <ckpt>` argument.

---

## 6. Validation

### Δv model on validation

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\experiments\complementary_fusion"
python generate_dense.py
python phase2_4_fusion_select.py
```

`generate_dense.py` runs **both frozen models** over every session (train, validation, test)
at stride 1 and writes `predictions/dense/<split>/<session>.parquet` with columns
`timestamp_s, v_true, yaw_true, v_abs_pred, yaw_pred_base, dv_pred, yaw_pred_dv, ok`.
Test files are written but are not read until Section 7.

`phase2_4_fusion_select.py` evaluates the fusion grid (11 α values, 10 τ values) on
**validation only** and writes:

| Output | Meaning |
|---|---|
| `validation_results/phase3_validation_dr.csv` | every config × session × outage segment |
| `validation_results/phase3_{vel_rmse,traj_rmse,drift_per_min}.csv` | per-config medians |
| `frozen_fusion_config.json` | the selected configuration (**τ=20 s**) |

Selection rule: mean rank of median final position error across 10/30/60/120/300 s.

### Regression-metric characterisation (optional)

```powershell
python phase1_characterize.py
```
Writes `validation_results/phase1_{error_stats,error_growth}.csv`, `phase1_{acf,psd}.npz`,
`phase1_summary.json` — the autocorrelation/spectrum evidence for why fusion works.

---

## 7. Test evaluation

> **Run this ONLY after the model, checkpoint and fusion configuration are frozen.**
> The test split (2 sessions, Driver B) must never be used for training, hyperparameter
> choice, loss choice, early stopping, checkpoint selection or τ tuning. Every result in
> `reports/` was produced with the configuration frozen beforehand;
> `frozen_fusion_config.json` and each `metrics.json` record `test_used_for_selection: false`.

### TEST COMMAND

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\experiments\complementary_fusion"
python phase5_test.py
```

Reads `frozen_fusion_config.json`, asserts the selected config is a `cf_tau*` filter, and
evaluates eight variants (baseline as frozen, Δv as frozen, controlled comparisons, and the
Phase-6 attribution variants).

Writes:

| Output | Meaning |
|---|---|
| `test_results/test_dead_reckoning.csv` | every variant × session × outage segment |
| `test_results/test_summary.csv` | aggregated medians/p90 per variant × outage |
| `test_results/metrics.json` | yaw metrics, % changes, frozen config echo |
| `plots/drift_comparison_test.png` | drift curves |
| `plots/test_traj_S-M_s0{0,1}_{60,300}s.png` | trajectory, error growth, velocity |

Expected frozen result (median final position error, m):

| Outage | Baseline | Δv | **FUSED** |
|---|---|---|---|
| 10 s | 19.01 | 8.73 | **8.79** |
| 30 s | 58.39 | 46.88 | **42.71** |
| 60 s | 127.17 | 137.09 | **108.07** |
| 120 s | 286.23 | 387.02 | **248.04** |
| 300 s | 917.70 | 1217.91 | **740.58** |

---

## 8. Inference

### A. Existing preprocessed session — SUPPORTED

Any session already present in `preprocessing/smartphone_core/` and `preprocessing/targets/`.
The library call is the supported path; there is no single-session CLI.

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\experiments\complementary_fusion"
python -c "import sys,os,json,numpy as np,torch; sys.path[:0]=[r'..\..\baseline', r'..\delta_v', '.']; from train_baseline import MatrixBaseline, DEVICE; from dv_common import session_frame, dense, FMU, FSD, DS; from phase2_4_fusion_select import complementary, v_abs_anchored, dead_reckon; sc=json.load(open(os.path.join(DS,'scaler','scaler.json'))); b=torch.load(r'..\..\baseline\checkpoints\best_huber.pt',map_location=DEVICE,weights_only=False); d=torch.load(r'..\delta_v\checkpoints\best_k5_huber.pt',map_location=DEVICE,weights_only=False); mb=MatrixBaseline().to(DEVICE); mb.load_state_dict(b['model']); mb.eval(); md=MatrixBaseline().to(DEVICE); md.load_state_dict(d['model']); md.eval(); S=session_frame('S-M','S-M_s00'); X,ends,ok=dense(S); xb=torch.from_numpy(((X-FMU)/FSD).astype('float32')).to(DEVICE); import torch as T
with T.no_grad():
    Pb=mb(xb[:2000]).cpu().numpy()*np.array(sc['target_std'],'float32')+np.array(sc['target_mean'],'float32')
    Pd=md(xb[:2000]).cpu().numpy()*d['target_std']+d['target_mean']
print('windows:',X.shape,'valid:',int(ok.sum())); print('v_abs[0:3]',Pb[:3,0]); print('dv5[0:3]',Pd[:3,0]); print('yaw[0:3]',Pd[:3,1])"
```

For the full trajectory pipeline on a session, use the Section 9 command instead.

### B. A brand-new smartphone CSV — NOT CURRENTLY IMPLEMENTED

There is **no script that takes a raw AndroSensor CSV and returns a trajectory.** The
preprocessing pipeline is dataset-wide batch processing (`pass1`…`pass12`), driven by
manifests over the whole IO-VNBD corpus, not by a single file.

To run on a new CSV the following would be required — none of it exists as a callable path:

1. **Header normalisation** — `preprocessing/common.py::map_cols` handles the AndroSensor variants (longest-prefix matching, mojibake `m/s²`, `"22 / 23"` satellites, `YYYY-MM-DD HH:MM:SS:mmm` dates). Reusable as a library.
2. **Session segmentation** — cut at backward time jumps and >5 s gaps (logic inside `pass8_build.py`, not factored out).
3. **Bias correction** — requires a stationary segment in the same recording; `pass5_calibration.py` estimates it per dataset. With no stationary segment, bias is zero (as for 18 of 45 training sessions).
4. **Windowing** — 50 causal samples at 10 Hz, contiguity-checked (`dv_common.py::dense` does exactly this and **is** reusable).
5. **A velocity anchor** — the filter needs an initial `v0`. In evaluation this is ground-truth VBOX velocity; in production it must come from the last GNSS fix.
6. **Resampling** — the model assumes exactly 10 Hz. A phone recording at 2 Hz (e.g. Blackberry Priv in this dataset) or an irregular rate is **out of specification**.

`dv_common.py::session_frame` reads the *preprocessed* parquet, not a raw CSV, so steps 1–3
are the genuine gap. See Section 17.

---

## 9. Dead reckoning — the complete pipeline

```
smartphone IMU (10 Hz)
   ↓  preprocessing  (pass1..pass12 → smartphone_core/, targets/)
   ↓  windowing      (dv_common.dense: 50 causal samples, stride 1)
   ├─→ Δv model      (best_k5_huber.pt)     → dv5, yaw_rate
   └─→ absolute-v    (best_huber.pt)        → v_absolute
   ↓  v_abs_anchored(v_abs, v0)             anchor at outage start
   ↓  complementary(dv, v_abs_anchored, v0, tau=20)
   ↓  heading  h[t] = Σ yaw·dt      (midpoint rule)
   ↓  position x,y  = Σ v·cos/sin(h)·dt
```

Filter (`phase2_4_fusion_select.py::complementary`), exactly as frozen:
```python
inc = dv / k                       # k = 5, per-step velocity increment
g   = dt / tau                     # dt = 0.1, tau = 20.0
v[0] = v0                          # ground-truth anchor
v[t] = (1 - g) * (v[t-1] + inc[t]) + g * v_abs_anchored[t]
v    = max(v, 0.0)                 # velocity floor
```

### Commands to execute the whole pipeline

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\experiments\complementary_fusion"
python generate_dense.py            # 1. both models over every session, stride 1
python phase2_4_fusion_select.py    # 2. validation fusion grid → frozen_fusion_config.json
python phase5_test.py               # 3. test DR + attribution + trajectory plots
```

Prerequisite: both checkpoints exist (Section 4). `generate_dense.py` takes ~3 min for all 25
sessions.

---

## 10. GNSS outage simulation

Supported durations: **10, 30, 60, 120, 300 s**.

> These are **hard-coded**, not CLI arguments. There is no `--outage` flag.

| Script | Constant | Line |
|---|---|---|
| `phase2_4_fusion_select.py` | `OUTAGES = [10, 30, 60, 120, 300]` | 18 |
| `phase5_test.py` | imports `OUTAGES` from `phase2_4_fusion_select` | 15 |
| `delta_v/evaluate_delta_v.py` | `OUTAGES = [10, 30, 60, 120, 300]` | — |
| `baseline/evaluate_baseline.py` | inline `for T in [10, 30, 60, 120, 300]` | — |

To evaluate other durations, edit `OUTAGES` in `phase2_4_fusion_select.py` and re-run. A new
outage starts every `STEP_S = 30` seconds; a segment is used only if every window in it is
valid, so long outages yield fewer segments (324 at 300 s vs 353 at 10 s on test).

Per-segment metrics recorded: `final_err`, `traj_rmse`, `mean_err`, `max_err`,
`heading_err_deg`, `drift_per_min`, `vel_rmse`.

---

## 11. Outputs

| Output | Location | Meaning |
|---|---|---|
| **Δv checkpoint (final)** | `experiments/delta_v/checkpoints/best_k5_huber.pt` | the model — weights, epoch, val_loss, target scaler |
| **absolute-v checkpoint (final)** | `baseline/checkpoints/best_huber.pt` | fusion anchor model |
| Other checkpoints | `*/checkpoints/best_*_{mse,mae}.pt` | loss-comparison runs, not used |
| **Frozen fusion config** | `experiments/complementary_fusion/frozen_fusion_config.json` | τ=20 s + selection record |
| Scaler | `preprocessing/training_dataset/core/scaler/scaler.json` / `.npz` | train-only means/stds (11 ch; use `[:6]`) |
| Feature schema | `preprocessing/outputs/feature_schema.json` | channel order, feature-set index map |
| Split manifest | `preprocessing/training_dataset/core/split_manifest.csv` | 25 sessions → train/val/test |
| Window metadata | `preprocessing/training_dataset/core/metadata/*.parquet` | per-window session, driver, timestamps |
| Training history | `baseline/training_history.csv`, `experiments/delta_v/training_history.csv` | per-epoch losses |
| Loss selection | `*/loss_comparison.json` | which loss won and why |
| Dense predictions | `experiments/complementary_fusion/predictions/dense/<split>/<session>.parquet` | stride-1 predictions from both models |
| Validation DR | `experiments/complementary_fusion/validation_results/phase3_validation_dr.csv` | fusion grid results |
| **Test DR** | `experiments/complementary_fusion/test_results/test_dead_reckoning.csv` | per-segment test results |
| Test summary | `experiments/complementary_fusion/test_results/test_summary.csv` | aggregated medians |
| Test metrics | `experiments/complementary_fusion/test_results/metrics.json` | yaw metrics, % changes |
| **Trajectory plots** | `experiments/complementary_fusion/plots/test_traj_*.png` | trajectory, error growth, velocity |
| Drift plot | `experiments/complementary_fusion/plots/drift_comparison_test.png` | drift vs outage duration |
| Configs | `baseline/config.yaml`, `experiments/*/config.yaml` | frozen configuration records |
| Reports | `reports/*.md` | full experiment write-ups |
| Preprocessing reports | `preprocessing/outputs/*.md` | inventory, targets, transformation status |
| **Logs** | — | **none; stdout only** |

Trajectories are **not** written as standalone files. `x`, `y`, `heading` are computed inside
`phase5_test.py` and rendered to plots; only the error metrics are persisted. To export
trajectory coordinates you would add a `to_csv` after the `dead_reckon` call — see Section 17.

---

## 12. API / endpoints

> **API endpoint is not currently implemented.**

Verified: no Flask, FastAPI, uvicorn, `@app.route` or `http.server` anywhere in the
repository. There is no server, no REST endpoint and no gRPC interface. The model is only
reachable by importing `MatrixBaseline` and loading a checkpoint in Python (Section 8A).

Building one would require: the raw-CSV preprocessing path from Section 8B, a defined request
schema (IMU window or session + anchor velocity), model loading at startup, and a response
schema (Δv, yaw_rate, or an integrated trajectory).

---

## 13. Deployment

### A. Development machine — WORKS TODAY

Sections 2–4 plus Section 9. Windows 11 + RTX 3050 6 GB verified. CPU-only works (slower).
Disk: ~2.1 GB raw dataset + ~180 MB ML dataset + ~470 MB derived parquet.

### B. Production server — NOT CURRENTLY IMPLEMENTED

Only the checkpoints (~600 KB each) and the scaler are needed at runtime — the raw dataset is
not. Missing for production: the raw-CSV preprocessing path (8B), a serving interface (12),
model export (no ONNX/TorchScript export exists), batching/concurrency, and monitoring.
The model itself is small (150,914 params) and CPU inference is entirely practical.

### C. Mobile / backend integration — NOT CURRENTLY IMPLEMENTED

`mobile/` is an Expo React-Native app named `matrix` (`expo start`, `expo start --android`,
`expo start --ios`, `expo start --web`). It contains only template screens
(`src/app/index.tsx`, `src/app/explore.tsx`) with **no reference to the model, no ONNX/TFLite
asset and no inference code**. Its only tie to this project is the name.

On-device inference would additionally need export to ONNX/TFLite/ExecuTorch, an on-device
10 Hz IMU sampling path matching the training distribution, on-device bias estimation, and a
GNSS-derived velocity anchor.

---

## 14. Troubleshooting

**CUDA unavailable / running on CPU**
```powershell
python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
nvidia-smi
```
If `torch.version.cuda` is `None`, a CPU-only wheel is installed. Reinstall with the cu126
index URL from Section 0. Scripts fall back to CPU automatically (`DEVICE` in
`train_baseline.py`), so this is a speed issue, not a failure.

**`Torch not compiled with CUDA enabled`** — CPU wheel; reinstall as above.

**`FileNotFoundError: ...X_train.npy`** — wrong working directory, or preprocessing never run.
```powershell
Get-Location
Test-Path "D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\preprocessing\training_dataset\core\train\X_train.npy"
```
Run each script from its own directory as shown in every command above.

**`RuntimeError: Given groups=1, weight of size [64, 6, 5], expected input[...] to have 6 channels`**
— feature-count mismatch: an 11-channel array fed to the 6-channel model. The final model uses
`X_train.npy` (6), **not** `X_ext_train.npy` (11).
```powershell
python -c "import numpy as np; print(np.load(r'preprocessing\training_dataset\core\train\X_train.npy',mmap_mode='r').shape)"
```

**Scaler mismatch / predictions wildly wrong** — `scaler.json` holds **11** entries. The
6-feature model must use `feature_mean[:6]` and `feature_std[:6]`. The Δv model's target
scaler lives **inside its checkpoint** (`target_mean`/`target_std`); the baseline model's
target scaler comes from `scaler.json`. Mixing them produces plausible-looking but wrong
velocities.
```powershell
python -c "import json,torch; print('scaler n:',len(json.load(open(r'preprocessing\training_dataset\core\scaler\scaler.json'))['feature_mean'])); ck=torch.load(r'experiments\delta_v\checkpoints\best_k5_huber.pt',map_location='cpu',weights_only=False); print('dv target_mean',ck['target_mean'],'target_std',ck['target_std'])"
```

**Checkpoint missing** — training was never run or was interrupted (no resume, Section 5).
```powershell
Get-ChildItem -Recurse -Filter "best_*.pt" | Select-Object FullName, Length
```

**`Missing key(s) in state_dict` / size mismatch on load** — the checkpoint's feature count
differs from the constructed model. Construct with `MatrixBaseline(n_feat=len(ck['feature_idx']))`
for ablation checkpoints; the two final checkpoints are both 6-channel (`MatrixBaseline()`).

**CPU/GPU tensor mismatch (`Expected all tensors on the same device`)** — always load with
`map_location=DEVICE` and move inputs with `.to(DEVICE)`, as the existing scripts do.

**Loss becomes `nan`** — NaN/Inf in the inputs. Run the NaN check in Section 3. The shipped
dataset is verified finite, so this indicates a regenerated dataset.

**`torch.load` weights-only error** — these checkpoints contain numpy arrays, so
`weights_only=False` is required (as every script already does). Only load checkpoints you trust.

**Windows path issues** — the project path contains spaces (`Pre ppt round prototype`) and the
dataset folders contain spaces and a typo (`Synchronised V abd S datasets`). Always quote
paths. Use raw strings (`r'...'`) in Python. Long-path errors: enable
`HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`.

**`ModuleNotFoundError: train_baseline` / `dv_common`** — run the script from its own
directory; the scripts rely on `sys.path` inserts relative to their own file location.

**Out of memory (6 GB GPU)** — training peaks well under 6 GB at batch 256. If you hit OOM,
lower `BATCH` in the training script (this changes results and breaks comparability with the
frozen numbers).

---

## 15. Reproducibility

| Item | Value |
|---|---|
| **Seed** | `1337`, set via `set_seed()` for `random`, `numpy`, `torch`, `torch.cuda` |
| **Determinism** | `torch.backends.cudnn.deterministic = True`, `benchmark = False`; DataLoader seeded with `torch.Generator().manual_seed(1337)` |
| **Architecture** | `Conv1d(6→64,k5,p2)` → BN → ReLU → Dropout(0.2) → `Conv1d(64→128,k5,p2)` → BN → ReLU → Dropout(0.2) → `GRU(128→128, 1 layer)` → last timestep → `Linear(128→64)` → ReLU → Dropout(0.2) → `Linear(64→2)`; **150,914 parameters** |
| **Feature order** | `acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z` — fixed, bias-corrected, gravity retained in `acc` |
| **Targets** | output 1 = `dv5 = v[t] − v[t−5]` (m/s over 0.5 s); output 2 = `yaw_rate` (rad/s). `target_v_lateral` is **excluded** (established unobservable) |
| **Target validity** | both endpoints high-confidence VBOX, contiguous in time, implied \|acceleration\| ≤ 15 m/s² |
| **Scaler policy** | fitted on the **train split only**; arrays on disk are raw; applied at load time. Validation/test never contribute |
| **Split** | by session, never by row. train 18 / validation 5 / **test 2 (Driver B, unseen)**. Frozen in `split_manifest.csv` |
| **Checkpoint rule** | lowest validation loss; loss function chosen across runs by validation mean normalised RMSE |
| **Fusion** | complementary filter, **τ = 20 s**, k = 5, dt = 0.1, velocity floor 0 — frozen in `frozen_fusion_config.json` |

**Known non-determinism:** cuDNN GRU kernels can introduce small run-to-run differences even
with deterministic flags. Experiment F measured 18.9% cell-to-cell spread in dead-reckoning
metrics across sessions, so treat differences below ~20% in DR error as within noise unless
confirmed across several seeds.

---

## 16. Full rebuild from raw data (reference only)

Not needed to use the frozen system — everything derived is committed. Actual order:

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype\model\preprocessing"
python pass1_scan.py            # enumerate + hash 564 CSVs
python pass2_fingerprint.py     # numeric fingerprints (dedup analysis)
python pass3_inventory.py       # raw_inventory.csv
python pass4_sync.py            # timestamp overlap
python pass4b_sync_final.py     # sv_synchronisation_final.csv
python pass5_calibration.py     # calibration_bias.csv (stationary bias, gravity check)
python pass6_frame.py           # axis_correlation.csv
python pass7_classify.py        # compatibility_matrix.csv, column_mapping.json
python pass8_build.py           # smartphone_core/, vehicle_reference/, calibration/
python pass9_sync_lag.py        # synchronization_report.csv
python pass10_frame_fit.py      # frame_transformations.json, frame_validation.csv
python pass11_targets.py        # targets/, target_summary.csv
python pass12_build_training.py # training_dataset/core/  ← see the BLOCKER below
```

> **BLOCKER — `pass12_build_training.py` reads
> `preprocessing/outputs/vbox_session_distribution.csv`, which NO script writes.**
> That file (45 rows; columns `driver, session_id, dataset_id, vehicle, phone, rows,
> duration_s, distance_km, target_rows, conf, source, sync_conf, gyro_tf, acc_tf, has_bias,
> lag_s`) was produced by an ad-hoc inline script during development that was never saved.
> The file **is** present in the repo, so a rebuild works as long as it is not deleted — but a
> from-scratch rebuild on a clean checkout without it will fail at pass12. See Section 17.

`an1.py`…`an5.py` are exploratory helpers, not pipeline steps.

---

## 17. Known gaps

| # | Gap | Impact | What is needed |
|---|---|---|---|
| 1 | ~~No `requirements.txt`~~ **RESOLVED** | — | `requirements.txt` added at the project root |
| 2 | **`vbox_session_distribution.csv` has no generator** | From-scratch rebuild fails at pass12 | A `pass11b` writing the 16 columns listed in Section 16 |
| 3 | **No raw-CSV inference path** | Cannot run on a new phone recording | Factor session segmentation + bias estimation out of `pass8`/`pass5` into a single-file function |
| 4 | **No inference API** | No service integration | See Section 12 |
| 5 | **No resume** | Interrupted runs restart (~6 min) | Save optimizer/scheduler/epoch state + `--resume` |
| 6 | **No trajectory export** | x/y/heading only reach plots | Add `to_csv` after `dead_reckon` in `phase5_test.py` |
| 7 | **No model export** (ONNX/TorchScript) | Python+PyTorch required at runtime | `torch.onnx.export` on the two checkpoints |
| 8 | **Outage durations hard-coded** | Editing source required | Add `--outages` to the evaluation scripts |
| 9 | **No pre-flight QC script** | Bad data fails late/silently | Save the Section 3 checks as a script |
| 10 | **Anchor is idealised** | Evaluation uses ground-truth `v0` | Production must supply `v0` from the last GNSS fix and model its error |

---

## 18. System limitations (carried from the reports)

- Trained and tested on **one phone (Huawei P20 Pro) in one vehicle (Ford Fiesta)** — VBOX existed only in the research vehicle. Cross-device generalisation is **untested**.
- **Three drivers** (A, E train/val; B test). Test is a single unseen driver.
- The model assumes **exactly 10 Hz**. The 2 Hz Blackberry and irregular Motorola sessions are out of specification.
- Dead reckoning needs a **velocity anchor** at outage start.
- Drivers **F/G/H remain held out** for a future OOD experiment and were never trained on.
- At 300 s, **yaw drift is the dominant error source** (65%); below 60 s it is velocity (72–80%).
