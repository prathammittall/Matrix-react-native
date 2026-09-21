# MATRIX — AI dead reckoning for GNSS-denied vehicle navigation

When the satellites go away, the phone keeps navigating.

MATRIX is an Android application that holds a vehicle's position through a GNSS
outage — a tunnel, an underpass, a multi-storey car park, an urban canyon, a
jammed or spoofed area — using nothing but the phone's own inertial sensors and
a pair of neural networks trained on real driving data. No wheel-speed tap, no
external hardware, no network connection.

```
GNSS good                     GNSS lost                      GNSS back
────────────┬──────────────────────────────────────────────┬────────────
 satellites │  accelerometer + gyroscope @ 10 Hz           │ satellites
            │        ↓                                     │
            │  Δv model ──┐                                │
            │             ├→ complementary filter (τ=20 s) │
            │  |v| model ─┘        ↓                       │
            │              velocity + heading              │
            │                      ↓                       │
            │           dead reckoning → lat/lon           │
────────────┴──────────────────────────────────────────────┴────────────
   position from a fix          position from the model        fix again
```

---

## Contents

| | |
|---|---|
| [What problem this solves](#what-problem-this-solves) | the problem statement, and why the obvious answers fail |
| [How it works](#how-it-works) | the two models and the filter |
| [Repository layout](#repository-layout) | what lives where |
| [The dataset](#the-dataset) | IO-VNBD, and what cleaning it actually took |
| [Running it](#running-it) | app, backend, APK |
| [State of the project](#state-of-the-project) | what is done, what is not |
| [What it does not claim](#what-it-does-not-claim) | the honest limits |
| [Research background](RESEARCH.md) | the literature this is built on, and what to take next |

---

## What problem this solves

Every satellite navigation system shares one failure mode: it needs to see the
sky. Lose line of sight and the receiver either stops reporting or, worse,
reports a position derived from reflections that can be tens or hundreds of
metres wrong. For a driver this is an inconvenience. For a fleet operator, an
emergency responder, an autonomous system, or a soldier in a contested
environment with GNSS jamming, it is a safety and mission problem.

The classical answer is an inertial navigation system: integrate acceleration
twice to get position. On automotive-grade MEMS sensors — which is what a phone
has — this fails within seconds. Accelerometer bias integrates into a velocity
error that grows linearly, and then into a position error that grows
quadratically. A 0.05 m/s² bias, which is unremarkable for a phone, is 22 m of
position error after 30 seconds and 225 m after 100. Double integration is not a
solution; it is the problem.

**The insight this project is built on is that you should not integrate
acceleration at all.** Instead you learn the mapping from a short window of raw
IMU signal directly to the quantity that actually matters — how the vehicle's
forward speed changed over that window — and you reconstruct the trajectory from
speed and heading. A learned model sees the same bias in training that it sees
in deployment, so the bias stops being an error source and becomes part of the
signal. This is the approach behind Onyekpe et al.'s work on the IO-VNBD corpus,
and it is what MATRIX implements.

### Why not just use the phone's own fused location?

Android's fused provider already falls back to cell towers and Wi-Fi. That is
useful in a city and useless in a tunnel, which is exactly the case the product
exists for. It also tells you nothing about *why* it degraded. MATRIX
distinguishes "acquiring", "weak", "lost" and "estimated by the model" and says
which one it is, always.

---

## How it works

### The frozen system: two models and a filter

| Component | What it predicts | Artifact |
|---|---|---|
| Δv model | change in forward speed over k=5 samples, plus yaw rate | `model/experiments/delta_v/checkpoints/best_k5_huber.pt` |
| absolute-v model | forward speed directly — a low-frequency anchor | `model/baseline/checkpoints/best_huber.pt` |
| complementary filter | fuses the two, τ = 20 s | `model/experiments/complementary_fusion/frozen_fusion_config.json` |

Two models rather than one, because they fail differently. Integrating Δv gives
an excellent short-term track but accumulates a slow drift. The absolute-v model
has no drift but is noisy sample to sample. A complementary filter takes the
high-frequency content from the first and the low-frequency content from the
second: `v = lowpass(v_abs, τ) + highpass(∫Δv, τ)`. τ = 20 s was selected on the
validation split and then frozen.

Heading comes from integrating the model's predicted yaw rate, anchored to the
bearing of the last GNSS fix. Position is then plain dead reckoning at 10 Hz.

### The input contract — this is not negotiable

```
50 samples × 6 channels @ exactly 10 Hz
order: acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z
acceleration in m/s² with gravity RETAINED
normalisation: scaler.json[:6], train split only
```

The model was trained on fixed-rate 10 Hz logs. A window whose span is more than
10 % off nominal is **dropped, not resampled** — feeding the model out-of-spec
data would produce a confident wrong answer, which is worse than no answer.

This contract is also, historically, where the app broke. See
[the sampling grid](#the-sampling-grid) below.

### The app's state machine

Three states are tracked separately and never conflated:

| | |
|---|---|
| `GnssState` | what the **receiver** is doing — ACQUIRING / ACTIVE / WEAK / OUTAGE / UNAVAILABLE |
| `InferenceState` | what the **model** is doing — IDLE / WARMING / READY / ERROR / OFFLINE |
| `NavigationMode` | what the **app is navigating by** — IDLE / ACQUIRING / GNSS / DEAD_RECKONING / DEGRADED |

```
no fix yet                          → ACQUIRING        (a search, not a loss)
GNSS ACTIVE or WEAK                 → GNSS
GNSS lost + anchor + model ready    → DEAD_RECKONING
GNSS lost, anything else missing    → DEGRADED         (last position, held and labelled)
```

Two rules keep this honest, and both are about **time**:

1. **Every transition must hold for a wall-clock interval before it is
   adopted** — 3 s to enter an outage, 1.5 s to leave one. Receivers produce
   spurious readings constantly; a confirmation measured in seconds is immune to
   them in a way that a count of samples is not.
2. **A heartbeat re-evaluates at 2 Hz.** Staleness is a property of the clock,
   not of the arrival of the next fix — and during an outage the next fix never
   arrives.

Accuracy thresholds have separate enter and clear values (hysteresis), so a
receiver sitting on a boundary cannot oscillate the mode.

### The sampling grid

The frozen model assumes exact 10 Hz. A JavaScript `setInterval(100)` is not a
clock: under load React Native fires it every 105–130 ms, and the drift
accumulates. Over the 49 intervals of one window, a mean period of 110 ms gives
a 5.39 s span against a nominal 4.90 s — outside the 10 % tolerance. Every
window was rejected, `windows_inferred` stayed at zero, and the app displayed
*AI DEAD RECKONING ACTIVE — 00:00 · 0 m* while the vehicle drove away.

The emitter now owns a grid: sample *n* is stamped `t = n × 0.1` exactly and is
due at `t₀ + n × 100 ms`. A timer running faster than the grid emits every point
that has come due, so jitter changes *when* a sample is written, never the
timeline it is written onto. A genuine stall (backgrounding, sensor pause)
exceeds the catch-up limit and resynchronises the grid, leaving a visible
discontinuity in the timestamps — so the straddling windows are correctly
rejected rather than silently stitched across motion that was never measured.

---

## Repository layout

```
├── model/          FROZEN ML system — never modified
│   ├── dataset/          raw IO-VNBD (2.1 GB, gitignored, read-only)
│   ├── preprocessing/    pass1..pass12 pipeline + derived data
│   ├── baseline/         absolute-v model
│   └── experiments/      Δv model, complementary fusion, ablations
├── backend/        FastAPI inference service + ONNX export tools
├── mobile/         Expo / React Native app (the product)
├── reports/        frozen experiment write-ups
├── RESEARCH.md     literature survey and roadmap
├── FRONTEND_RUN.md full operating manual for the app
└── HANDOFF.md      session-to-session engineering notes
```

### `model/` is frozen

Nothing under `model/` may be modified: weights, architecture, preprocessing,
scaler, feature order, Δv formulation, yaw target, τ, dead-reckoning maths,
dataset, splits, configs. Verify at any time:

```bash
python backend/tools/verify_ml_integrity.py
```

Expected: `UNCHANGED - every frozen artifact present here matches the baseline`,
alongside a count of derived files that are absent because .gitignore excludes
them. A clone has 151 of the manifest's 638 files; the other 487 are parquet and
npy outputs of `pass1..pass12`, regenerable and deliberately not committed.

Everything this project adds — the sampling grid, the state machine, the
hysteresis, the UI — lives *outside* that boundary and consumes the model
through a fixed contract.

---

## The dataset

**IO-VNBD** — Inertial and Odometry Vehicle Navigation Benchmark Dataset
([paper](https://arxiv.org/abs/2005.01701),
[repo](https://github.com/onyekpeu/IO-VNBD.git)). ~2.1 GB of real driving in the
UK, Nigeria and France: smartphone IMU at 10 Hz alongside a VBOX reference and
vehicle ECU channels.

It is an excellent corpus and it is **not** ready to train on. The full audit is
in [`model/preprocessing/outputs/preprocessing_report.md`](model/preprocessing/outputs/preprocessing_report.md);
these are the findings that would have broken a naive pipeline:

| # | Finding | What it would have cost |
|---|---|---|
| 1 | The 564 CSVs are **187 unique datasets** in two redundant views across two trees | blind concatenation duplicates most trips 2–4× |
| 2 | The same data ships under two header namings (`GYROSCOPE X/Y/Z` vs `Yaw/Pitch/Roll`), verified numerically identical | header-matching invents two incompatible schemas from one |
| 3 | Prefix collision: `GYROSCOPE YAW` matches the shorter key `GYROSCOPE Y` | yaw silently assigned to the Y axis — mapping must be longest-prefix-first |
| 4 | **GPS updates roughly every 9 s, not at 1 Hz** as the README states | ground truth is ~90× sparser than assumed; forward-filling fabricates ~99 % of rows |
| 5 | Not every phone samples at 10 Hz — the Blackberry Priv records at **2 Hz** | a fixed `dt=0.1` assumption is wrong for 13 datasets / 382,957 rows |
| 6 | `GRAVITY` has exactly constant magnitude 9.80660 and mean direction (0,0,1) | it is a *derived* channel; it cannot be used to infer mounting tilt |
| 7 | Accelerometer/gravity and gyroscope are **not in a consistent axis convention** | any assumed rotation matrix is wrong; per-session alignment is required |
| 8 | "Synchronised" pairs are aligned **by row index**, not timestamp; residual lag reaches **8.5 s** | multi-second errors injected straight into the supervision signal |
| 9 | Smartphone wall-clock is local time, VBOX time-of-day is UTC | 8 pairs need a +3600 s (BST) shift or the join silently fails |
| 10 | `S-A4` has one spurious empty field per row, shifting every column right by one | looks corrupt; is recoverable (repair verified: `gravity_z` → 9.8065) |

Where the published README/PDF disagrees with the data, **the data wins** — and
the disagreement is recorded rather than quietly resolved. The PDF's Table A7
omits `S-T7`, for instance; the file itself is plainly an 18-column export.

After cleaning: **90 usable smartphone sessions, 1,815,592 rows** on a canonical
core schema, three stationary calibration sessions, and 162 VBOX variants used
for supervision only — never as model input.

Splits are by **driver**, not by random window. The test split is one driver the
model has never seen, because a random split over a 10 Hz time series leaks
neighbouring samples across the boundary and inflates every number you report.

---

## Running it

### The app

```bash
cd mobile
npm install
npx expo run:android
```

Expo Go will not work: MapLibre and ONNX Runtime are native modules that do not
exist in it. Use a development build or the release APK.

```bash
npm test          # 168 tests
npm run typecheck
```

### The inference service (optional)

Navigation runs entirely on-device. The service is for diagnostics, session
upload and desktop evaluation.

```bash
python -m uvicorn matrix_service.api:app --app-dir backend --host 0.0.0.0 --port 8000
```

### Release APK

```bash
cd mobile/android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Build it from a **short path** (`C:\mx`) on Windows — CMake's object-path limit
and the spaces in a long project path break the native phase. See
[`HANDOFF.md`](HANDOFF.md) §7 for the full list of build-environment traps.

---

## State of the project

### Working and verified

- Two frozen models exported to ONNX and running on-device. Verified against
  PyTorch on 256 real test windows: **max |onnx − torch| = 1.9 × 10⁻⁶**.
- The complementary filter ported to TypeScript and pinned to the Python
  original by golden vectors.
- Yaw-sign convention validated against real GNSS: `YAW_SIGN = +1` (15.8 m
  residual against 131.4 m for −1).
- Streaming inference proven identical to the offline pipeline (0.25 mm).
- Fixed 10 Hz sampling grid, so windows are actually accepted.
- Time-based outage confirmation with hysteresis — no spurious GNSS loss.
- Engine heartbeat — clocks and staleness no longer depend on a fix arriving.
- **ZUPT and yaw-bias removal** on the frozen pipeline's output: the vehicle
  stops accumulating distance while it is provably stationary, and the yaw-rate
  bias measured during those moments is removed from the whole outage. Switchable
  off, which reproduces the frozen behaviour exactly.
- Nine screens, on-device inference, MapLibre basemap with no API key and no
  billing, full offline navigation.
- 184 frontend tests, 43 backend tests, clean typecheck. (One backend test,
  `test_onnx_graphs_match_pytorch_within_tolerance`, needs the gitignored test
  split on disk and is skipped in practice on a fresh clone — the parity it
  checks was verified when the graphs were exported.)
- Release APK verified on a real device (vivo V2153, Android 15).

### Not yet done

- **A real drive with a real tunnel.** Everything so far has been verified
  stationary, indoors, or against replayed data. On-road outage entry and exit
  against a real fix is the one thing that has not been exercised — and the ZUPT
  thresholds in particular are reasoned, not yet measured against the VBOX
  reference.
- An uncertainty estimate — the map shows a point, and it looks as confident at
  300 s as at 3 s. See [RESEARCH.md](RESEARCH.md) §4.2.
- Per-device IMU calibration and recalibration for a new vehicle.
- Signed release builds (currently signed with the debug keystore).

---

## What it does not claim

Stated plainly, and stated in the app's About screen too:

- **Dead reckoning drifts.** Metres at 10 s, hundreds of metres at 300 s.
  Beyond roughly 300 s, yaw drift dominates and the estimate should not be
  trusted for navigation.
- **It was trained on one phone in one vehicle.** Huawei P20 Pro, Ford Fiesta,
  three drivers; the test split is one unseen driver. Generalisation to other
  phones, mounting positions and vehicles is unproven.
- **It needs a velocity anchor at outage start.** Production uses the last GNSS
  fix, so that fix's error propagates into everything after it.
- **Out-of-spec windows are dropped, not resampled.** If the phone cannot
  sustain 10 Hz, the model does not run.
- **Benchmark figures are research results on one dataset**, not a real-world
  guarantee.

---

## Licence and attribution

IO-VNBD is the work of Onyekpe, Palade, Kanarachos and Szkolnik. If you use this
work, cite their dataset paper. The literature this system is built on is listed
in [RESEARCH.md](RESEARCH.md).
