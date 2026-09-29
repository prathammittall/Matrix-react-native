<div align="center">

# MATRIX

### AI Dead Reckoning for GNSS-Denied Vehicle Navigation

*When the satellites go away — the phone keeps navigating.*

[![React Native](https://img.shields.io/badge/React_Native-0.86.3-61DAFB?style=flat-square&logo=react)](https://reactnative.dev)
[![Expo](https://img.shields.io/badge/Expo-57-000020?style=flat-square&logo=expo)](https://expo.dev)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-inference_service-009688?style=flat-square&logo=fastapi)](https://fastapi.tiangolo.com)
[![ONNX](https://img.shields.io/badge/ONNX-Runtime_1.24-005CED?style=flat-square&logo=onnx)](https://onnxruntime.ai)
[![PyTorch](https://img.shields.io/badge/PyTorch-frozen_model-EE4C2C?style=flat-square&logo=pytorch)](https://pytorch.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?style=flat-square&logo=typescript)](https://typescriptlang.org)
[![Platform](https://img.shields.io/badge/Platform-Android_7%2B-3DDC84?style=flat-square&logo=android)](https://developer.android.com)
[![Tests](https://img.shields.io/badge/Tests-184_frontend_%7C_43_backend-brightgreen?style=flat-square)](#test-coverage)

</div>

---

```
GNSS good                     GNSS lost                        GNSS restored
────────────┬────────────────────────────────────────────────┬──────────────
 satellites │  accelerometer + gyroscope  @  10 Hz           │  satellites
            │         ↓                                       │
            │   Δv model (TCN) ──┐                           │
            │                    ├→ complementary filter      │
            │   |v| model (LSTM) ┘       τ = 20 s            │
            │                    ↓                            │
            │          velocity + heading                     │
            │                    ↓                            │
            │         dead reckoning → lat / lon              │
────────────┴────────────────────────────────────────────────┴──────────────
  position from fix        position from model            fix again
```

MATRIX is an Android app that sustains vehicle positioning through GNSS outages — tunnels, underpasses, multi-storey car parks, urban canyons, jammed or spoofed areas — using **only the phone's built-in IMU**. No external hardware. No wheel-speed tap. No network connection. Everything runs on-device.

---

## Table of Contents

| Section | What you will find |
|---|---|
| [The Problem](#the-problem) | Why double integration fails; the key insight |
| [How It Works](#how-it-works) | Two models, a complementary filter, dead reckoning |
| [Algorithms and Solutions](#algorithms-and-solutions) | ZUPT, map-matching, outage detection, sampling grid |
| [Tech Stack](#tech-stack) | Every library, framework and tool |
| [Architecture](#architecture) | Component diagram, state machines, service layer |
| [The Dataset](#the-dataset) | IO-VNBD audit — ten findings that would have broken a naive pipeline |
| [Repository Layout](#repository-layout) | What lives where |
| [Running It](#running-it) | App, backend, APK build |
| [Test Coverage](#test-coverage) | 184 frontend + 43 backend tests |
| [Benchmarks](#benchmarks) | ONNX vs PyTorch parity, yaw validation |
| [Roadmap](#roadmap) | Ranked next steps |
| [Honest Limits](#honest-limits) | What this does not claim |
| [Research Background](RESEARCH.md) | Literature survey |

---

## The Problem

Every satellite navigation system shares one fatal failure mode: **it needs to see the sky.**

Lose line of sight and the receiver either stops reporting, or reports a position derived from reflections that can be tens to hundreds of metres wrong. For a driver this is an inconvenience. For a fleet operator, an emergency responder, an autonomous system, or a soldier in a contested environment with GNSS jamming — it is a safety and mission problem.

### Why classical INS fails on a phone

The obvious answer is dead reckoning via an inertial navigation system: integrate acceleration twice to get position. On the MEMS sensors inside a phone this fails within seconds.

| Source | Growth law | Effect at 30 s | Effect at 100 s |
|---|---|---|---|
| 0.05 m/s² accelerometer bias | position ~ t² | 22 m | 250 m |
| 0.01 °/s gyroscope bias | heading ~ t | 0.3° | 1° |

A 0.05 m/s² bias is **unremarkable** for a consumer phone. Double integration is not a solution; it is the problem.

### The key insight

> **Do not integrate acceleration at all.**

Instead, learn the mapping from a short window of raw IMU signal directly to the quantity that actually matters — how the vehicle's **forward speed changed** over that window — and reconstruct the trajectory from speed and heading. A learned model sees the same sensor bias in training that it sees in deployment, so the bias stops being an error source and becomes part of the signal. This is the approach behind Onyekpe et al.'s work on the IO-VNBD corpus, and it is what MATRIX implements.

---

## How It Works

### Two models and a complementary filter

MATRIX uses two frozen neural networks and a classical filter that fuses them:

| Component | Task | Architecture | Artifact |
|---|---|---|---|
| **Δv model** | Predict change in forward speed over k=5 samples, plus yaw rate | TCN / 1D-Conv | `model/experiments/delta_v/checkpoints/best_k5_huber.pt` |
| **Absolute-v model** | Predict forward speed directly (low-frequency anchor) | LSTM | `model/baseline/checkpoints/best_huber.pt` |
| **Complementary filter** | Fuse both to eliminate drift without sacrificing noise rejection | Fixed-τ (τ = 20 s) | `model/experiments/complementary_fusion/frozen_fusion_config.json` |

**Why two models instead of one?** They fail differently. Integrating Δv gives an excellent short-term track but accumulates slow drift. The absolute-v model has no drift but is noisy sample-to-sample. A complementary filter extracts the best of both:

```
v_fused = lowpass(v_abs, τ) + highpass(∫Δv, τ)
```

τ = 20 s was selected on the validation split and then **frozen**.

### Heading and position

Heading comes from integrating the Δv model's predicted yaw rate, anchored to the bearing of the last GNSS fix. The yaw sign was validated against a real GNSS track:

| Convention | Residual error |
|---|---|
| `YAW_SIGN = +1` | **15.8 m** ✅ |
| `YAW_SIGN = −1` | 131.4 m ❌ |

Position is plain dead reckoning at 10 Hz: `lat_new, lon_new = deadReckon(lat, lon, v_fused, heading, dt)`.

### The input contract

```
50 samples × 6 channels @ exactly 10 Hz
channels: acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z
acceleration: m/s² with gravity RETAINED
normalisation: scaler.json, first 6 of 11 entries, train split only
```

A window whose time span is more than ±10% off nominal is **dropped, not resampled**. Feeding the model out-of-spec data produces a confident wrong answer, which is worse than no answer.

---

## Algorithms and Solutions

### 1. Fixed 10 Hz Sampling Grid

**The problem:** React Native's `setInterval(100)` is not a clock. Under load it fires every 105–130 ms. Over the 49 intervals of one window, a mean period of 110 ms gives a 5.39 s span against a nominal 4.90 s — outside the ±10% tolerance. Every window was rejected, `windows_inferred` stayed at zero, and the app displayed *AI DEAD RECKONING ACTIVE — 00:00 · 0 m* while the vehicle drove away.

**The solution:** The emitter owns a **fixed grid**. Sample *n* is stamped `t = n × 0.1` exactly and is due at `t₀ + n × 100 ms`. A timer running faster than the grid emits every point that has come due, so jitter changes *when* a sample is written, never the timeline it is written onto. A genuine stall exceeds the catch-up limit and resynchronises the grid, leaving a visible discontinuity — so straddling windows are correctly rejected rather than silently stitched across motion that was never measured.

### 2. Time-Based Outage Detection with Hysteresis

**The problem:** GNSS receivers produce spurious readings constantly. A debounce counting consecutive agreeing samples was defeated by a GNSS fix and an inference reply arriving 50 ms apart — satisfying the threshold on noise.

**The solution:** `ConfirmationGate` — a wall-clock hold. A state transition must hold for a measured interval before it is adopted:

| Transition | Hold time |
|---|---|
| Enter OUTAGE | 3 s |
| Leave OUTAGE | 1.5 s |

Accuracy thresholds use hysteresis: separate enter and clear values (150 m / 120 m), so a receiver sitting on the boundary cannot oscillate the mode. Cell/Wi-Fi positioning typically reports 50–100 m accuracy — strong enough to be a position, not a loss.

### 3. Zero-Velocity Updates (ZUPT)

**What:** When the IMU's rolling variance over ~1 s falls below a threshold on all six channels, the vehicle is stationary. Velocity is clamped to 0 and position integration is paused.

**Why it matters:** Traffic lights, junctions and car parks are a large fraction of any urban outage. Every second spent stationary was previously a second of accumulating drift for no reason.

**Implementation:** `mobile/src/services/motion-constraints.ts` — applied to the frozen pipeline's *output*, not to the model. Switchable from Settings. With constraints disabled, the re-integrated track is bit-identical to the frozen one, so benchmark figures remain reproducible.

### 4. Yaw-Bias Removal During Stationary Periods

During ZUPT-confirmed stationary periods, the yaw rate measured by the gyroscope is drift, not rotation. MATRIX accumulates the mean yaw rate during these periods and removes it from the entire outage. This is the only form of in-flight gyro calibration applied, and it operates outside the frozen boundary.

### 5. Offline Map Matching

When navigating in dead-reckoning mode, the estimated position is snapped to the nearest road in a pre-built in-memory graph (`road-graph.ts`), using an HMM-style candidate selection scored by distance and heading agreement:

```
score = distance_weight × d(position, road_segment)
      + heading_weight × |heading − segment_bearing|
```

The map graph is built from OpenStreetMap data. This reduces lateral drift and keeps the position on the road during tunnels where the geometry is known.

### 6. Complementary Filter — TypeScript Port with Golden-Vector Parity

`mobile/src/services/frozen-fusion.ts` is a line-for-line port of the Python reference implementation. Its correctness is pinned by **golden vectors** exported from the Python pipeline and committed as test fixtures. Any divergence from the reference is caught by the test suite before it can affect navigation.

### 7. Three-Layer State Machine

Three states are tracked independently and never conflated:

| State | Values | Owner |
|---|---|---|
| `GnssState` | ACQUIRING / ACTIVE / WEAK / OUTAGE / UNAVAILABLE | receiver |
| `InferenceState` | IDLE / WARMING / READY / ERROR / OFFLINE | ML engine |
| `NavigationMode` | IDLE / ACQUIRING / GNSS / DEAD_RECKONING / DEGRADED | navigation engine |

```
No fix yet                          →  ACQUIRING        (a search, not a loss)
GNSS ACTIVE or WEAK                 →  GNSS
GNSS lost + anchor + model ready    →  DEAD_RECKONING
GNSS lost, anything else missing    →  DEGRADED         (last position, held and labelled)
```

A **2 Hz heartbeat** re-evaluates all state at the wall clock, independent of fix arrival. During an outage the next fix never arrives — the clock must not wait for it.

### 8. Turn-by-Turn Voice Guidance

`routing.ts` builds a route using an offline graph. `guidance.ts` monitors progress against the route and issues turn instructions with bearing and distance. `voice.ts` delivers output via `expo-speech`. All of this works with no network connection.

---

## Tech Stack

### Mobile (Android)

| Layer | Technology | Version |
|---|---|---|
| Framework | React Native | 0.86.3 |
| Build system | Expo / EAS | 57 |
| Language | TypeScript | 6.0 |
| Navigation | Expo Router (file-based) | 57 |
| Map | MapLibre GL React Native | 11.3.10 |
| Map tiles | OpenStreetMap raster — no API key, no billing | — |
| On-device inference | ONNX Runtime React Native | 1.24.3 |
| Sensors | Expo Sensors (accelerometer + gyroscope) | 57 |
| Location | Expo Location | 57 |
| Voice | Expo Speech | 57 |
| Storage | AsyncStorage | 2.2.0 |
| Animation | React Native Reanimated | 4.5.1 |
| Gestures | React Native Gesture Handler | 2.32.0 |
| SVG | React Native SVG | 15.15.4 |
| Testing | Jest + jest-expo | 29.7 |

### ML / Model

| Component | Technology |
|---|---|
| Training framework | PyTorch |
| Export format | ONNX opset 17 |
| Dataset | IO-VNBD (2.1 GB, Onyekpe et al.) |
| Preprocessing | 12-pass pipeline (pass1–pass12), Pandas + NumPy |
| Loss function | Huber loss |
| Optimiser | Adam |
| Normalisation | Custom scaler (train-split statistics only) |
| Integrity verification | SHA-256 manifest (`backend/ml_integrity_manifest.json`) |

### Backend (optional, diagnostics)

| Component | Technology |
|---|---|
| Framework | FastAPI |
| ASGI server | Uvicorn |
| Inference | PyTorch (reads the frozen `.pt` files directly) |
| ONNX export tools | `onnxruntime`, `torch.onnx` |
| Testing | pytest |

### Build and Tooling

| Tool | Purpose |
|---|---|
| `expo prebuild` | Generates the native Android project |
| Gradle + JDK 17/21 | Compiles and signs the APK |
| `patch-package` | Applies the ONNX Runtime bridgeless fix on `npm install` |
| `with-onnxruntime-package` plugin | Registers `OnnxruntimePackage()` after every prebuild |
| `with-legacy-packaging` plugin | Ensures `.so` libs are extracted at install on Android 15 |
| `with-release-signing` plugin | Signs with the fixed MATRIX keystore (CN=MATRIX) |
| `apksigner` | Verifies release keystore before distribution |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Mobile App                           │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Screens    │  │  Components  │  │  Theme / UI Kit  │   │
│  │  (9 views)  │  │  (shared)    │  │  (monochrome)    │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────────────┘   │
│         └────────────────┤                                   │
│  ┌───────────────────────▼───────────────────────────────┐  │
│  │               navigation-engine.ts                    │  │
│  │   GnssState × InferenceState → NavigationMode        │  │
│  │   ConfirmationGate  ·  2 Hz heartbeat  ·  hysteresis │  │
│  └──┬──────────┬──────────┬──────────────┬──────────────┘  │
│     │          │          │              │                   │
│  ┌──▼──┐  ┌───▼──┐  ┌────▼─────┐  ┌────▼──────────────┐   │
│  │gnss │  │senso │  │ ondevice │  │ motion-constraints │   │
│  │.ts  │  │rs.ts │  │-infer.ts │  │ ZUPT + yaw-bias    │   │
│  └─────┘  └──────┘  └────┬─────┘  └───────────────────┘   │
│                           │                                   │
│                  ┌────────▼────────┐                         │
│                  │ frozen-fusion.ts│  complementary filter    │
│                  │  golden-vector  │  τ = 20 s               │
│                  │  parity pinned  │                         │
│                  └────────┬────────┘                         │
│                           │                                   │
│                  ┌────────▼────────┐                         │
│                  │  ONNX Runtime   │  Δv model + |v| model   │
│                  │  on-device CPU  │  opset 17, ~151k params  │
│                  └─────────────────┘                         │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  routing.ts  ·  guidance.ts  ·  map-matching.ts     │    │
│  │  road-graph.ts  ·  map-graph.ts  ·  geo.ts          │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │  optional
                   ┌──────────▼──────────┐
                   │   FastAPI backend   │
                   │  (diagnostics only) │
                   │  /api/v1/inference  │
                   │  /api/v1/sessions/* │
                   └─────────────────────┘
```

### Screens

| Screen | Purpose |
|---|---|
| **Dashboard** | Live GNSS / DR status, current mode badge |
| **Live Navigation** | MapLibre map with route overlay, turn-by-turn guidance |
| **History** | Past navigation sessions |
| **Settings** | Theme, ZUPT toggle, DR parameters |
| **Demo Mode** | Replays a recorded Coventry outage at real speed |
| **Diagnostics** | ONNX graph health, sampling stats, model contract checks |
| **Session Detail** | Per-session outage log and metrics |
| **Outage Analytics** | Aggregated drift vs. duration across sessions |
| **About** | Honest disclosure of limitations |

### Service Layer

| Service | Responsibility |
|---|---|
| `navigation-engine.ts` | Master state machine, heartbeat, mode arbitration |
| `ondevice-inference.ts` | ONNX model loading, window ingestion, 10 Hz grid |
| `frozen-fusion.ts` | Complementary filter — TypeScript port of the Python reference |
| `motion-constraints.ts` | ZUPT detection, yaw-bias removal |
| `gnss.ts` | Location provider, accuracy classification, outage timing |
| `sensors.ts` | Accelerometer + gyroscope, fixed-grid emission |
| `routing.ts` | Offline turn-by-turn route computation |
| `guidance.ts` | Progress monitoring, voice instruction generation |
| `map-matching.ts` | HMM-style road snapping during dead reckoning |
| `road-graph.ts` | In-memory OSM road network |
| `geo.ts` | Haversine, bearing, dead-reckoning maths |
| `inference-backend.ts` | Optional FastAPI client (diagnostics) |
| `demo-player.ts` | Recorded session playback at 1× speed |
| `storage.ts` | AsyncStorage persistence for sessions |
| `track.ts` | Running position track for map overlay |

---

## The Dataset

**IO-VNBD** — Inertial and Odometry Vehicle Navigation Benchmark Dataset
[arXiv:2005.01701](https://arxiv.org/abs/2005.01701) · [github.com/onyekpeu/IO-VNBD](https://github.com/onyekpeu/IO-VNBD)

~2.1 GB of real driving in the UK, Nigeria and France: smartphone IMU at 10 Hz alongside a VBOX reference and vehicle ECU channels. Excellent corpus. Not ready to train on without a serious audit.

### Ten findings that would have broken a naive pipeline

| # | Finding | Cost of missing it |
|---|---|---|
| 1 | 564 CSVs are **187 unique datasets** in two redundant views across two directory trees | Blind concatenation duplicates most trips 2–4× |
| 2 | Same data ships under two header namings (`GYROSCOPE X/Y/Z` vs `Yaw/Pitch/Roll`), verified numerically identical | Header-matching invents two incompatible schemas from one |
| 3 | **Prefix collision:** `GYROSCOPE YAW` matches the shorter key `GYROSCOPE Y` | Yaw silently assigned to the Y axis — mapping must be longest-prefix-first |
| 4 | **GPS updates roughly every 9 s, not at 1 Hz** as the README states | Ground truth is ~90× sparser than assumed; forward-filling fabricates ~99% of rows |
| 5 | Not every phone samples at 10 Hz — the Blackberry Priv records at **2 Hz** | A fixed `dt=0.1` assumption is wrong for 13 datasets / 382,957 rows |
| 6 | `GRAVITY` has exactly constant magnitude 9.80660 and mean direction (0,0,1) | It is a *derived* channel; cannot be used to infer mounting tilt |
| 7 | Accelerometer/gravity and gyroscope are **not in a consistent axis convention** | Any assumed rotation matrix is wrong; per-session alignment is required |
| 8 | "Synchronised" pairs aligned **by row index, not timestamp**; residual lag reaches **8.5 s** | Multi-second errors injected straight into the supervision signal |
| 9 | Smartphone wall-clock is local time, VBOX time-of-day is UTC | 8 pairs need a +3600 s (BST) shift or the join silently fails |
| 10 | `S-A4` has one spurious empty field per row, shifting every column right by one | Looks corrupt; recoverable — `gravity_z` → 9.8065 after repair |

Where the published README/PDF disagrees with the data, **the data wins** — and the disagreement is recorded rather than quietly resolved.

**After cleaning:** 90 usable smartphone sessions · 1,815,592 rows · canonical core schema · three stationary calibration sessions · 162 VBOX variants used for supervision only.

**Split strategy:** By **driver**, not by random window. A random split over a 10 Hz time series leaks neighbouring samples across the boundary and inflates every metric you report. The test split is one driver the model has never seen.

**Preprocessing pipeline:** 12 sequential passes (`pass1` → `pass12`) — deduplication, header normalisation, prefix-collision repair, GPS interpolation, per-device rate correction, axis alignment, row-index synchronisation, UTC offset repair, column-shift repair, and canonical schema export.

---

## Repository Layout

```
Matrix-react-native/
├── model/                   FROZEN ML system — never modified
│   ├── dataset/             Raw IO-VNBD (2.1 GB, gitignored, read-only)
│   ├── preprocessing/       pass1..pass12 pipeline + derived data
│   │   └── outputs/         Audit reports, scaler.json, column maps
│   ├── baseline/            Absolute-v model (LSTM)
│   │   └── checkpoints/     best_huber.pt  ← frozen
│   └── experiments/
│       ├── delta_v/         Δv + yaw model (TCN)
│       │   └── checkpoints/ best_k5_huber.pt  ← frozen
│       └── complementary_fusion/
│           └── frozen_fusion_config.json  ← τ=20 s, frozen
│
├── backend/                 FastAPI inference service (optional)
│   ├── matrix_service/      API endpoints /api/v1/*
│   ├── tools/               ONNX export, golden-vector export, integrity check
│   ├── tests/               43 pytest tests
│   └── ml_integrity_manifest.json  SHA-256 manifest of the frozen system
│
├── mobile/                  Expo / React Native app (the product)
│   ├── src/
│   │   ├── app/             9 screens (Expo Router file-based routing)
│   │   ├── services/        21 service modules (navigation, inference, map...)
│   │   ├── components/      Shared UI components
│   │   ├── hooks/           React hooks
│   │   ├── theme/           Monochrome design system
│   │   └── types/           TypeScript type definitions
│   ├── assets/models/       Exported ONNX graphs (delta_v.onnx, baseline.onnx)
│   ├── plugins/             Expo config plugins (ONNX, legacy packaging, signing)
│   ├── patches/             patch-package hunk for ORT bridgeless fix
│   ├── __tests__/           184 Jest tests + golden-vector fixtures
│   └── keystores/           Fixed release keystore (CN=MATRIX)
│
├── reports/                 Frozen experiment write-ups
├── RESEARCH.md              Literature survey and ranked roadmap
├── FRONTEND_RUN.md          Complete operating manual
├── HANDOFF.md               Session-to-session engineering notes
└── requirements.txt         Python dependencies
```

### The frozen boundary

Nothing under `model/` may be modified: weights, architecture, preprocessing, scaler, feature order, Δv formulation, yaw target, τ, dead-reckoning maths, dataset, splits, or configs. Verify at any time:

```bash
python backend/tools/verify_ml_integrity.py
```

Expected: `UNCHANGED — every frozen artifact present here matches the baseline`

Everything MATRIX adds — the sampling grid, the state machine, the hysteresis, the ZUPT, the map matching, the routing, the UI — lives *outside* that boundary and consumes the model through a fixed contract.

---

## Running It

### Prerequisites

- Node.js 20+
- JDK 17 or 21 (React Native 0.86 does not build on JDK 24)
- Android Studio with SDK 35 + NDK
- Python 3.10+ (for the backend — optional)

### The app — development build

```bash
cd mobile
npm install
npx expo run:android
```

> **Note:** Expo Go will not work. MapLibre and ONNX Runtime are native modules that do not ship with it. Use a development build or the release APK.

```bash
npm test          # 184 tests
npm run typecheck
```

### The backend (optional — diagnostics and session upload)

Navigation runs fully on-device. The backend is for diagnostics, session upload, and desktop evaluation.

```bash
pip install -r backend/requirements.txt
python -m uvicorn matrix_service.api:app --app-dir backend --host 0.0.0.0 --port 8000
```

Endpoints: `GET /api/v1/health` · `GET /api/v1/model/info` · `POST /api/v1/inference` · `GET /api/v1/sessions/*`

### Release APK

`mobile/android/` is generated and gitignored. Start with a prebuild:

```bash
cd mobile
npm install
npx expo prebuild --platform android
```

Then build with `JAVA_HOME` pointing at JDK 17 or 21:

```bash
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon
```

Output: `android/app/build/outputs/apk/release/app-release.apk`
~48 MB · arm64-v8a · minSdk 24 (Android 7+) · targetSdk 36

Verify the build before distributing:

```bash
grep OnnxruntimePackage android/app/src/main/java/com/matrix/deadreckoning/MainApplication.kt
grep useLegacyPackaging android/gradle.properties
grep matrix-release android/app/build.gradle
apksigner verify --print-certs app-release.apk   # → CN=MATRIX, ...
```

### Build environment gotchas

| Problem | Cause | Fix |
|---|---|---|
| `SDK location not found` | BOM in `local.properties`, or backslashes | Forward slashes; write with `[System.IO.File]::WriteAllText` to avoid BOM |
| `ninja: manifest still dirty after 100 tries` | CMake mangles spaces in long paths | Build from a short path like `C:\mx` |
| `Cannot read property 'install' of null` | `OnnxruntimePackage` not registered | Plugin `with-onnxruntime-package.js` handles this automatically after prebuild |
| App not installed over an existing build | Debug key, not the MATRIX key | Plugin `with-release-signing` — verify with `apksigner` |

---

## Test Coverage

### Frontend — 184 tests (Jest + jest-expo)

| Test area | What is verified |
|---|---|
| `frozen-fusion.ts` | Golden vectors — TypeScript output matches Python reference to float32 precision |
| `motion-constraints.ts` | With constraints disabled → bit-identical to frozen track |
| `navigation-engine.ts` | All GnssState × InferenceState → NavigationMode transitions |
| `ondevice-inference.ts` | Window ingestion, grid enforcement, window rejection |
| `sensors.ts` | Fixed-grid emission, catch-up logic, resync on stall |
| `navigation-status` component | Render for all navigation modes |

```bash
cd mobile && npm test && npm run typecheck
```

### Backend — 43 tests (pytest)

| Test | What is verified |
|---|---|
| `test_onnx_graphs_match_pytorch_within_tolerance` | max \|onnx − torch\| ≤ 1 × 10⁻⁴ on 256 real test windows |
| `test_streaming_matches_offline_pipeline` | Streaming inference produces results within 0.25 mm of the offline batch |
| `test_frozen_filter_matches_reference` | FastAPI complementary filter matches the frozen Python implementation |
| API endpoint tests | health, model/info, inference, sessions CRUD |

```bash
cd backend && pytest tests/ -v
```

---

## Benchmarks

### ONNX vs. PyTorch parity

Verified on 256 real test windows (CPU vs. CPU — the same execution path the phone uses):

```
max |onnx − torch| = 1.9 × 10⁻⁶     tolerance: 1 × 10⁻⁴    PASS
```

### Yaw-sign validation (real GNSS drive)

```
YAW_SIGN = +1  →   15.8 m residual   (adopted)
YAW_SIGN = −1  →  131.4 m residual
```

### Drift at horizon (IO-VNBD test split)

| Outage duration | Dominant error source | Approximate magnitude |
|---|---|---|
| 10 s | Speed noise | Single-digit metres |
| 60 s | Accumulated drift | Tens of metres |
| 300 s | Yaw drift | Hundreds of metres |

*Research results on one dataset with one phone in one vehicle. Not a real-world guarantee.*

---

## Roadmap

Ranked by expected value per unit of risk. All items are additive and live outside the frozen boundary.

| Priority | Item | Status |
|---|---|---|
| 1 | ZUPT + yaw-bias removal | Done — thresholds need tuning against VBOX reference on a real drive |
| 2 | Offline map matching | Done — `map-matching.ts` with HMM-style road snapping |
| 3 | Turn-by-turn routing + voice | Done — `routing.ts`, `guidance.ts`, `expo-speech` |
| 4 | Uncertainty visualisation | Planned — empirical error radius growing with outage duration |
| 5 | Per-device recalibration (R-WhONet approach) | Planned — short supervised drive, scale + bias fit, no retraining |
| 6 | Live phone-to-vehicle frame estimation | Planned — GNSS-good phase alignment; touches the input contract |
| 7 | Real-drive validation with a real tunnel | Pending — everything verified stationary or on replayed data |

---

## Honest Limits

Stated plainly — and also in the app's About screen:

- **Dead reckoning drifts.** Single-digit metres at 10 s, hundreds of metres at 300 s. Beyond roughly 5 minutes, yaw drift dominates and the estimate should not be trusted for precise navigation.
- **Trained on one phone in one vehicle.** Huawei P20 Pro, Ford Fiesta, three drivers. The test split is one unseen driver. Generalisation to other phones, mounting positions and vehicles is unproven.
- **Needs a velocity anchor at outage start.** The last GNSS fix provides this; that fix's error propagates into everything after it.
- **Out-of-spec windows are dropped, not resampled.** If the phone cannot sustain 10 Hz, the model does not run.
- **No uncertainty display yet.** The map shows a point that looks as confident at 300 s as at 3 s. This is a known gap in the roadmap.
- **Benchmark figures are research results on one dataset**, not a real-world guarantee.

---

## Research Background

See [RESEARCH.md](RESEARCH.md) for a full literature survey covering:

- The Onyekpe / IO-VNBD lineage — WhONet, R-WhONet
- AI-IMU Dead-Reckoning (Brossard et al.) — IEKF with learned covariances
- Learned inertial odometry: IONet, RoNIN, TLIO
- Why pedestrian model weights do not transfer to vehicles
- A ranked roadmap with cost and risk analysis for each next step

---

## Attribution

IO-VNBD is the work of Onyekpe, Palade, Kanarachos and Szkolnik. If you build on this work, cite their dataset paper:

> U. Onyekpe, V. Palade, S. Kanarachos and A. Szkolnik, *"IO-VNBD: Inertial and Odometry Vehicle Navigation Benchmark Dataset for Ground Vehicle Positioning,"* Data in Brief, 2021. [arXiv:2005.01701](https://arxiv.org/abs/2005.01701)

---

<div align="center">

Built by Pratham Mittal  ·  [RESEARCH.md](RESEARCH.md)  ·  [FRONTEND_RUN.md](FRONTEND_RUN.md)  ·  [HANDOFF.md](HANDOFF.md)

</div>
