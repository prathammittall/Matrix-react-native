# MATRIX — FRONTEND_RUN.md

Operating manual for the MATRIX **application**: the React Native (Expo) app and
the inference service that connects it to the frozen dead-reckoning model.

> For the model itself — training, evaluation, the frozen results — see
> [`model/RUN.md`](model/RUN.md). **Nothing in this document modifies the model.**

---

## QUICK START

Four terminals' worth of commands, in order. Every command below was executed
against this repository.

> **The app runs the AI model offline by default.** The frozen model is bundled
> into the binary and executed on the phone with ONNX Runtime, so navigation,
> dead reckoning and Demo Mode all work in aeroplane mode. The backend below is
> optional — it is a second way to run the same frozen model, useful for
> debugging and for comparing the two paths.

**Backend** (optional; from the project root, venv activated):

```powershell
python -m uvicorn matrix_service.api:app --app-dir backend --host 0.0.0.0 --port 8000
```

**Inference smoke test** (proves the frozen model is being served correctly):

```powershell
python backend/tools/streaming_parity_check.py
```

**Frontend** (Metro bundler):

```powershell
cd mobile; npx expo start --dev-client
```

**Android** (builds and installs the dev client — required once):

```powershell
cd mobile; npx expo run:android
```

**iOS** (macOS only):

```powershell
cd mobile && npx expo run:ios
```

**Release APK** — use the helper script, which handles the two Windows path
gotchas described in section 14 (`gradlew assembleRelease` on its own FAILS from
this repository's path, because it contains spaces):

```powershell
cd mobile; ./scripts/build-apk.ps1
```

**Re-export the on-device models** (only needed if the checkpoints change):

```powershell
python backend/tools/export_onnx.py
```

**Demo Mode** — already bundled in the app; re-export only to refresh it:

```powershell
python backend/tools/export_demo_sessions.py
```

---

## 1. Prerequisites

| Component | Version | Notes |
|---|---|---|
| **Node.js** | **22.22.1** (18+ works; 20 or 22 LTS recommended) | `node -v` |
| npm | 11.16.0 | ships with Node 22 |
| Python | **3.13.12** | the same interpreter `model/RUN.md` pins |
| Expo SDK | **57.0.22** | already in `mobile/package.json` |
| React Native | 0.86.3 | |
| Android Studio | Ladybug+ with SDK 35 and an AVD | for `expo run:android` |
| Xcode | 16+ | macOS only, for `expo run:ios` |
| Google Cloud project | — | with billing enabled, for Maps (section 7) |

> **Expo Go will not work.** `react-native-maps` is a native module that is not
> bundled in Expo Go from SDK 53 onward. You need a **development build**
> (`expo run:android` / `expo run:ios`), which the commands below create.

---

## 2. Install

```powershell
# Python side (backend + frozen model), from the project root
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype"
py -3.13 -m venv .venv                  # skip if .venv already exists
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt         # frozen ML stack (~2.5 GB, CUDA torch)
pip install -r backend\requirements.txt # fastapi, uvicorn, pydantic, pytest

# JavaScript side
cd mobile
npm install
```

`backend/requirements.txt` deliberately pins **only** FastAPI, uvicorn, pydantic
and pytest. It does not re-pin torch/numpy/pandas, so installing it cannot move
a version the frozen model depends on.

---

## 3. Environment variables

```powershell
cd mobile
Copy-Item .env.example .env
```

Then edit `mobile/.env`:

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_MATRIX_API_URL` | Base URL of the inference service (no trailing slash) |
| `GOOGLE_MAPS_ANDROID_API_KEY` | Android Maps SDK key |
| `GOOGLE_MAPS_IOS_API_KEY` | iOS Maps SDK key |
| `ANDROID_PACKAGE` | Android package id (must match the key restriction) |
| `IOS_BUNDLE_ID` | iOS bundle id (must match the key restriction) |

Choosing `EXPO_PUBLIC_MATRIX_API_URL`:

| Running on | Value |
|---|---|
| Android emulator | `http://10.0.2.2:8000` |
| iOS simulator | `http://127.0.0.1:8000` |
| Physical phone | `http://<your-computer-LAN-IP>:8000` — find it with `ipconfig` |

The URL can also be changed at runtime in **Settings → Inference service**, which
is the fastest way to fix it during a demo without rebuilding.

`.env` is gitignored. **No key is ever read from JavaScript**: `app.config.js`
injects the Maps keys into the native config at build time, and the app only
learns *whether* a key was configured (shown in Diagnostics), never its value.

Backend environment variables are listed in [`backend/README.md`](backend/README.md).

---

## 4. Start the backend

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype"
.\.venv\Scripts\Activate.ps1
python -m uvicorn matrix_service.api:app --app-dir backend --host 0.0.0.0 --port 8000
```

Expected on startup:

```
[matrix] frozen models loaded on cuda | tau=20.0s k=5
INFO:     Uvicorn running on http://0.0.0.0:8000
```

Verify:

```powershell
curl http://127.0.0.1:8000/api/v1/health
curl http://127.0.0.1:8000/api/v1/model/info
```

Interactive API docs: <http://127.0.0.1:8000/docs>

CPU-only machines work — `frozen.py` falls back automatically and reports
`"device": "cpu"`. Inference for one window is well under 10 ms either way.

---

## 5. ML inference service setup

Nothing to set up beyond section 4 — the service loads the existing checkpoints
in place. It requires:

| Artifact | Path |
|---|---|
| Δv model | `model/experiments/delta_v/checkpoints/best_k5_huber.pt` |
| absolute-v model | `model/baseline/checkpoints/best_huber.pt` |
| scaler | `model/preprocessing/training_dataset/core/scaler/scaler.json` |
| frozen fusion config | `model/experiments/complementary_fusion/frozen_fusion_config.json` |

All four are committed. If any is missing, the service fails at startup with the
exact path and a pointer to `model/RUN.md` §4 — it does not start in a degraded
state and pretend to predict.

Confirm the serving layer has not altered the pipeline:

```powershell
python backend/tools/streaming_parity_check.py
python backend/tools/verify_ml_integrity.py
python -m pytest backend/tests -q
```

---

## 5b. On-device (offline) inference

### What runs on the phone

| Piece | Where it comes from |
|---|---|
| Δv model + anchor model | `mobile/assets/models/*.onnx`, exported from the frozen checkpoints |
| feature scaler | `frozen_runtime.json`, copied verbatim from `scaler.json[:6]` |
| target scalers | copied verbatim from the two checkpoints |
| complementary filter, dead reckoning | `src/services/frozen-fusion.ts` |
| τ = 20 s, k = 5, dt = 0.1 s | copied from `frozen_fusion_config.json` |

Nothing is re-fitted, approximated or quantised. The model is 151k parameters
and runs in single-figure milliseconds on a phone CPU, so there is no reason to
trade accuracy for speed.

### The export, and why you can trust it

```powershell
python backend/tools/export_onnx.py
```

The script traces the frozen `MatrixBaseline` in eval mode, writes the ONNX
graphs **outside `model/`**, then runs 256 real IMU windows from the test split
through both PyTorch and ONNX Runtime and compares the outputs in physical
units. It refuses to keep the files unless they match:

```
  matrix_delta_v.onnx            591.0 KB  opset 17
  matrix_abs_v.onnx              591.0 KB  opset 17

verifying on 256 real test-split windows
  delta_v    max |onnx - torch| = 2.757e-07   mean = 3.847e-08
  abs_v      max |onnx - torch| = 1.907e-06   mean = 2.671e-07

EXPORT VERIFIED  worst difference 1.907e-06 (tolerance 1e-04)
```

1.9e-6 m/s is float32 noise, six orders of magnitude below anything that could
move a dead-reckoning metric.

### The filter, and why you can trust that

Offline operation means the complementary filter has to run in TypeScript. A
re-implementation could silently drift, so it is pinned instead:

```powershell
python backend/tools/export_fusion_golden.py   # regenerate the golden vectors
cd mobile; npx jest frozen-fusion               # 32 assertions
```

`export_fusion_golden.py` runs the **frozen Python functions** over real outage
segments of the test split (10 s to 300 s, plus a velocity-floor case) and dumps
their exact inputs and outputs. `__tests__/frozen-fusion.test.ts` replays those
vectors through the TypeScript port and fails if it disagrees by more than 1e-6.
Editing the arithmetic in `frozen-fusion.ts` turns that test red.

### Choosing where the model runs

**Settings → AI inference**:

| Mode | Behaviour |
|---|---|
| **On device** (default) | ONNX Runtime on the phone. No network needed, ever. |
| Auto | Prefers on-device; falls back to the service only if the bundled models fail to load. |
| Server | Every window goes to the inference service. Stops working when the network does. |

Both paths run the same weights, the same scaler and the same τ = 20 s filter,
so they produce the same track. The active backend is shown in the AI panel and
in **Diagnostics → On-device model**, along with the ONNX graph hashes and the
measured export accuracy.

### Demo Mode is offline too

`backend/tools/export_demo_sessions.py` also copies the demo payloads into
`mobile/assets/demo/`, and the app prefers the bundled copy. A demo runs with
the phone in aeroplane mode.

---

## 6. Start the frontend

**First time on a device or emulator** — build and install the dev client:

```powershell
cd mobile
npx expo run:android          # or: npx expo run:ios   (macOS)
```

**Afterwards** — just start Metro and the installed dev client picks it up:

```powershell
cd mobile
npx expo start --dev-client
```

Other scripts:

```powershell
npm run android      # expo start --android
npm run ios          # expo start --ios
npm run web          # runs, but the map shows a "not available on web" panel
npm test             # 94 unit tests
npm run typecheck    # tsc --noEmit
npm run lint
```

---

## 7. Google Maps setup

### Google Cloud project

1. Create (or pick) a project at <https://console.cloud.google.com/>.
2. **Enable billing.** The Maps SDKs refuse to render without it; the free
   monthly credit covers development and a demo comfortably.
3. **APIs & Services → Library**, enable:
   * **Maps SDK for Android**
   * **Maps SDK for iOS** (only if you are building for iOS)
4. **APIs & Services → Credentials → Create credentials → API key.**
   Create **two separate keys** — restrictions differ per platform.

### Android key restrictions

* *Application restrictions* → **Android apps**
* Add your package name (`ANDROID_PACKAGE`, default `com.matrix.deadreckoning`)
  and the SHA-1 fingerprint of the signing certificate.

Debug SHA-1:

```powershell
keytool -list -v -alias androiddebugkey -keystore "$env:USERPROFILE\.android\debug.keystore" -storepass android -keypass android
```

* *API restrictions* → restrict to **Maps SDK for Android**.

### iOS key restrictions

* *Application restrictions* → **iOS apps**, add the bundle id (`IOS_BUNDLE_ID`).
* *API restrictions* → restrict to **Maps SDK for iOS**.

### Wiring the keys

Put them in `mobile/.env`. `app.config.js` reads them and injects:

* Android → `android.config.googleMaps.apiKey`
* iOS → `ios.config.googleMapsApiKey`

Then **rebuild the native app** — a native config change does not hot-reload:

```powershell
cd mobile; npx expo run:android
```

### If the map is blank

That is almost always a key problem, and the app tells you which:
**Diagnostics → App → Google Maps key** reports `configured` or `MISSING`.
If it says `configured` and the map is still blank, check that the key's
package/bundle and SHA-1 restrictions match the build you installed, and that
billing is enabled on the project.

---

## 8. Permissions

The app requests, and explains, the following:

| Permission | Platform | Why | If denied |
|---|---|---|---|
| Foreground location | both | position on the map, and the anchor the dead-reckoning estimate starts from | Navigation still runs; GNSS shows `UNAVAILABLE` and the app says so rather than inventing a position |
| Motion / Fitness | iOS | accelerometer + gyroscope — dead reckoning is impossible without them | The app warns that dead reckoning cannot run |
| High-rate sensors | Android | 10 Hz IMU sampling | granted implicitly |
| Background location | declared | `UIBackgroundModes: ["location"]` for continuing a drive with the screen off | optional |

Wording is in `app.config.js` (`NSLocationWhenInUseUsageDescription`,
`NSMotionUsageDescription`, and the `expo-location` plugin messages).
Current state is always visible in **Diagnostics → Permissions**, which also
offers a re-request button.

---

## 9. Demo Mode

Export the data once (reads the frozen prediction files, writes to
`backend/demo_data/` — never into `model/`):

```powershell
python backend/tools/export_demo_sessions.py
```

Expected:

```
wrote backend\demo_data\S-M_s00.json  (13 outages, 37.1 km) median final error by outage: {10: 11.1, 30: 27.2, 60: 37.4, 120: 58.0, 300: 645.8}
wrote backend\demo_data\S-M_s01.json  (13 outages, 64.9 km) median final error by outage: {10: 10.7, 30: 32.9, 60: 137.8, 120: 282.1, 300: 735.1}
wrote backend\demo_data\index.json
```

`backend/demo_data/` (384 KB) is committed deliberately. The dense prediction
files it is derived from are gitignored as regenerable derived data
(`.gitignore:65`), so without the committed export a clean checkout could not
run Demo Mode without first re-running `generate_dense.py` (~3 min, RUN.md §9).

Restart the backend so it picks the files up, then open **Demo Mode** from the
dashboard. Pick an outage length (10 / 30 / 60 / 120 / 300 s) and press **Play**:

1. 8 s of normal GNSS driving along the recorded track,
2. the receiver is cut — the status flips to **AI DEAD RECKONING** and the
   vehicle continues along the trajectory the frozen model actually produced,
3. GNSS returns, and the estimated and reference end points are both marked with
   the measured error between them.

Long outages play at up to 10× so every demo lands inside 30 seconds.

**Nothing in Demo Mode is fabricated.** The drives are real IO-VNBD test-split
recordings (driver B, never seen in training); `dv_pred`, `yaw_pred_dv` and
`v_abs_pred` are read from
`model/experiments/complementary_fusion/predictions/dense/test/`; velocity is
fused by the frozen complementary filter and integrated by the frozen
`dead_reckon`; errors are measured against the recorded VBOX ground truth. If
the export has not been run, Demo Mode says so rather than showing a fake route.

---

## 10. Testing with live sensors

1. Start the backend bound to `0.0.0.0`, and set `EXPO_PUBLIC_MATRIX_API_URL`
   (or Settings → Inference service) to your computer's LAN IP.
2. Install the dev client on a **physical phone** — emulators have no real IMU.
3. Open **Navigate → Start Navigation**, grant location and motion permissions.
4. Watch **Diagnostics → Sensors**: the IMU rate should read **10 Hz** and the
   window buffer should fill to **50/50** within about five seconds. Once it
   does, the AI panel moves from *Filling window* to *Active* and Δv and yaw
   rate start updating.
5. **Force an outage without a tunnel:** press **Simulate outage** on the
   Navigate screen. This suppresses real GNSS fixes — it never invents one — so
   the app takes the genuine dead-reckoning path. Press **Restore GNSS** to
   recover and see the recovery error.
6. Stop navigation to save the session; it appears in History with its outages.

For a real outage, drive through a tunnel or a multi-storey car park.

---

## 11. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        MOBILE APP  (Expo / React Native)                │
│                                                                         │
│  UI layer            src/app/**              screens (expo-router)      │
│                      src/components/**       reusable components        │
│        │                                                                │
│        │  useEngine() — throttled snapshot, 4 Hz max                    │
│        ▼                                                                │
│  Navigation state    src/services/navigation-engine.ts                  │
│                      · nextMode()  GNSS │ DEAD_RECKONING │ DEGRADED     │
│                      · Debouncer   one dropped fix must not flip modes  │
│                      · outage open/close, track accumulation            │
│        │                          ▲                                     │
│        ├──────────────┐           │                                     │
│        ▼              ▼           │                                     │
│  Sensor service   GNSS service    │                                     │
│  sensors.ts       gnss.ts         │                                     │
│  · 10 Hz emit     · watchPosition │                                     │
│  · ring buffer    · classifyGnss()│                                     │
│  · g → m/s²         ACTIVE/WEAK/  │                                     │
│  · NO React         OUTAGE/UNAVAIL│                                     │
│    state per                      │                                     │
│    sample                         │                                     │
│        │                          │                                     │
│        ▼                          │                                     │
│  Inference backend   inference-backend.ts   ──────────────┘             │
│        │                                                                │
│        ├────────────────────────────────┬───────────────────────────┐   │
│        ▼                                ▼                           │   │
│  ┌──────────────────────────────┐  ┌─────────────────────────────┐  │   │
│  │ ON-DEVICE   (default)        │  │ SERVICE      (optional)     │  │   │
│  │ ondevice-inference.ts        │  │ api.ts                      │  │   │
│  │  · ONNX Runtime              │  │  · HTTP, batched ~1 s       │  │   │
│  │  · bundled frozen graphs     │  │  · every response validated │  │   │
│  │  · frozen scaler (manifest)  │  │    field by field;          │  │   │
│  │  · frozen-fusion.ts τ = 20 s │  │    malformed ⇒ ApiError     │  │   │
│  │  · geo.ts → lat/lon          │  └──────────────┬──────────────┘  │   │
│  │  WORKS WITH NO NETWORK       │                 │                 │   │
│  └──────────────────────────────┘                 │                 │   │
│              both paths produce the same track    │                 │   │
└───────────────────────────────────────────────────│─────────────────────┘
                                                    │
                     HTTP  POST /api/v1/sessions/{id}/samples
                                                    │
┌───────────────────────────────────────────────────▼─────────────────────┐
│                    INFERENCE SERVICE  (FastAPI, backend/)               │
│                                                                         │
│  api.py          routing, validation, limits                            │
│  schemas.py      rejects out-of-spec input — never reshapes it          │
│  dr_engine.py    session state, rolling 50-sample window, outage record │
│  geo.py          local (x,y,heading) → lat/lon      ← integration only  │
│  frozen.py       the ONLY module that touches model/  (read-only)       │
└───────────────────────────────│─────────────────────────────────────────┘
                                │  direct Python import, no copies
┌───────────────────────────────▼─────────────────────────────────────────┐
│                       FROZEN ML PIPELINE  (model/)                      │
│                                                                         │
│   IMU window (50 × 6, raw)                                              │
│        │  (x − FMU) / FSD          scaler.json[:6], train-split only    │
│        ├──────────────────────┬─────────────────────────                │
│        ▼                      ▼                                         │
│   Δv model                absolute-v model                              │
│   best_k5_huber.pt        best_huber.pt                                 │
│   → dv5, yaw_rate         → v_absolute                                  │
│        │                      │                                         │
│        │                      ▼                                         │
│        │              v_abs_anchored(v_abs, v0)                         │
│        │                      │                                         │
│        └──────────┬───────────┘                                         │
│                   ▼                                                     │
│        complementary(dv, v_abs_anch, v0, τ = 20 s)                      │
│        v[t] = (1−dt/τ)(v[t−1] + dv[t]/k) + (dt/τ)·v_abs[t],  v ≥ 0      │
│                   │                                                     │
│                   ▼                                                     │
│        dead_reckon(v, yaw)  →  x, y, heading                            │
└───────────────────────────────│─────────────────────────────────────────┘
                                │
                                ▼  local_to_latlon()  (integration layer)
                          latitude / longitude  →  map polyline
```

### How the offline path stays honest

The on-device branch is the only place the app carries frozen mathematics
itself, so both halves of it are pinned to the Python original rather than
trusted:

```
frozen checkpoints ──► export_onnx.py ──► matrix_*.onnx
       (model/)          verifies ONNX vs PyTorch on 256 real test windows
                         max |onnx − torch| = 1.9e-6  (refuses to ship above 1e-4)

frozen filter ────────► export_fusion_golden.py ──► fusion_golden.json
  (phase2_4_...py)       real 10–300 s outages, inputs + exact outputs
                                     │
                         frozen-fusion.test.ts replays them through the
                         TypeScript port — fails above 1e-6
```

### Three states, kept separate

This separation is why the app can never show a position it cannot justify:

| State | Lives in | Question it answers |
|---|---|---|
| `GnssState` | `gnss.ts` | What is the receiver doing? |
| `InferenceState` | `navigation-engine.ts` | What is the ML service doing? |
| `NavigationMode` | `navigation-engine.ts` | Which am I navigating by? |

```
GNSS ACTIVE / WEAK                       →  GNSS
GNSS OUTAGE  +  inference READY + window →  DEAD_RECKONING
GNSS OUTAGE  +  inference down           →  DEGRADED   (no position claimed)
```

### Performance

| Concern | How it is handled |
|---|---|
| 10 Hz sensor stream | written into a ring buffer by a timer, **never** into React state |
| Sensor dashboard | polls a snapshot at 4 Hz, and **only while expanded** |
| Engine updates | coalesced onto a 250 ms interval before reaching React |
| Inference calls | batched ~1 s, not one request per sample |
| Polylines | `decimate()` caps every rendered line at 1200 points |
| Map markers | `tracksViewChanges={false}` so custom markers do not re-rasterise |
| Failed uploads | requeued ahead of newer samples — no gaps, no duplicates |
| Screen wake lock | held only while a drive is actually running |

---

## 12. What was built

### Screens

| Screen | Route | Contents |
|---|---|---|
| Dashboard | `(tabs)/index` | status, four quick actions, system-health card (GNSS / IMU / AI model / Inference API), last session |
| Live Navigation | `(tabs)/navigate` | full-bleed Google map, floating status bar, outage banner, draggable sheet with metrics, AI panel and sensor dashboard |
| History | `(tabs)/history` | lifetime totals plus every saved drive with its GNSS-availability bar |
| Settings | `(tabs)/settings` | units, map, navigation, **where the model runs**, inference URL, read-only model facts |
| Demo Mode | `demo` | recorded-drive playback with a real simulated outage and charts, from data bundled in the app |
| Diagnostics | `diagnostics` | permissions, sensors, GNSS, **on-device model** (graph hashes, export accuracy, active backend), service, frozen model, app |
| Session detail | `session/[id]` | trajectory map, summary metrics, outage list |
| Outage analytics | `outage/[id]` | DR path vs recovery, recovery/heading error, benchmark bar chart |
| About | `about` | how it works, and the limitations stated plainly |

### Services

| Module | Responsibility |
|---|---|
| `sensors.ts` | 10 Hz IMU acquisition into a ring buffer, g → m/s² |
| `gnss.ts` | GNSS watch + `classifyGnss()` state machine |
| `navigation-engine.ts` | the single mode decision: GNSS / DEAD_RECKONING / DEGRADED |
| `inference-backend.ts` | pluggable backend — on-device or service |
| `ondevice-inference.ts` | ONNX Runtime on the phone; window formation, scaling, outage state |
| `frozen-fusion.ts` | the frozen complementary filter + dead reckoning, ported and pinned |
| `geo.ts` | local planar track → latitude/longitude |
| `api.ts` | inference-service client with per-field response validation |
| `demo-source.ts` | bundled-first demo data |
| `demo-player.ts` | pure playback state machine |
| `track.ts` | polyline append / decimate / region |
| `storage.ts` | history + settings |
| `format.ts` | unit-aware formatting |

### Components

`MatrixMap` · `NavigationStatusBar` · `AIStatusCard` · `SensorPanel` ·
`MetricsCard` / `MetricsGrid` · `OutageBanner` · `SystemHealthCard` /
`DiagnosticRow` · `SessionCard` · `MapLegend` · `LineChart` / `BarChart` ·
`Screen` / `ScreenHeader` · UI kit (`Txt`, `Card`, `Section`, `Row`, `Badge`,
`StatusDot`, `ProgressBar`, `Stat`, `Button`, `IconButton`, `ListRow`,
`ToggleRow`, `SegmentedControl`, `EmptyState`, `ErrorState`, `LoadingState`,
`Skeleton`, `BottomSheet`, `Collapsible`, 15 hand-drawn SVG icons).

---

## 13. Troubleshooting

**"AI service unavailable" on the dashboard**
The app cannot reach the backend. Check it is running, that it is bound to
`0.0.0.0` (not `127.0.0.1`) if you are on a physical device, and that
**Diagnostics → Inference service → Base URL** is right. Emulators need
`10.0.2.2`, not `localhost`. A Windows firewall prompt on first run must be
allowed for private networks.

**The map is blank / grey**
See section 7. **Diagnostics → App → Google Maps key** tells you whether a key
was baked into the build. Remember a native config change needs
`npx expo run:android`, not just a Metro reload.

**"Expo Go" shows an error about `react-native-maps`**
Expected. Build a dev client: `npx expo run:android`.

**The AI panel is stuck on "Filling window"**
The rolling 50-sample window is not completing. Check
**Diagnostics → Sensors**: if *Rejected windows* is climbing, the phone is not
delivering a steady 10 Hz and windows are being dropped rather than resampled —
that is deliberate, because resampling would put the input out of the
distribution the frozen model was trained on. Close other apps using the
sensors, or use a device with a better-behaved IMU.

**Mode never switches to AI DEAD RECKONING during an outage**
Both conditions must hold: the window must be full **and** inference must be
`READY`. If the service is down the mode is `DEGRADED` by design — the app
refuses to show an estimate it cannot produce. Diagnostics shows which condition
failed.

**Backend fails at startup with `FileNotFoundError`**
A frozen artifact is missing. The message names the exact path; train it per
`model/RUN.md` §4.

**`torch.load` weights-only error**
The checkpoints contain numpy arrays and are loaded with `weights_only=False`,
as every frozen script does. Only load checkpoints you trust.

**Metro cache weirdness after changing config**

```powershell
cd mobile; npx expo start --clear
```

**`npm test` cannot find `jest-expo`**

```powershell
cd mobile; npm install
```

---

## 14. Building the release APK

The short version, which does everything below for you:

```powershell
cd mobile; ./scripts/build-apk.ps1        # add -Clean for a from-scratch build
```

Output: `mobile/build-output/matrix-release.apk`

Done by hand, the build is:

```powershell
cd mobile
npx expo prebuild --platform android --clean
cd android
./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

**On this repository the by-hand version fails**, for the two reasons below.
`scripts/build-apk.ps1` exists because of them.

### Two Windows gotchas this repository will hit

**1. The project path contains spaces.** React Native's Android toolchain
cannot build from a path like `D:\Projects\Dead Reaconking system\Pre ppt round
prototype\mobile` — configuration fails with *"The filename, directory name, or
volume label syntax is incorrect"*. A directory junction does **not** help;
Gradle resolves it back to the real path. Copy the app to a space-free path and
build there:

```powershell
robocopy "D:\Projects\Dead Reaconking system\Pre ppt round prototype\mobile" D:\matrix-build /MIR /XD ".gradle" ".expo" build
```

> Do **not** exclude directories named `build` from `node_modules` — several
> packages (e.g. `expo-modules-autolinking`) ship real source in a `build/`
> folder, and excluding it breaks autolinking. Mirror `node_modules` separately
> with no `/XD build`.

**2. `local.properties` needs forward slashes.** In a `.properties` file a
single backslash is an escape character, so `sdk.dir=C:\Users\...` parses as
`C:Users...` and the SDK is not found — with the same unhelpful *"filename,
directory name, or volume label syntax is incorrect"* message. Write:

```properties
sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
```

### The onnxruntime patch

`onnxruntime-react-native@1.24.3` uses `org.gradle.util.VersionNumber`, which
Gradle 9 removed, in a check that only applies to React Native < 0.71. The fix
is committed as `mobile/patches/onnxruntime-react-native+1.24.3.patch` and
applied automatically by the `postinstall` script (`patch-package`), so a fresh
`npm install` builds without manual intervention.

### Signing

`expo prebuild` generates a release `signingConfig` that points at the **debug
keystore**. That produces an installable APK, which is what a demo needs, but it
is not a release credential. For anything beyond a demo, generate your own
keystore and point `signingConfigs.release` at it:

```powershell
keytool -genkeypair -v -storetype PKCS12 -keystore matrix-release.keystore -alias matrix -keyalg RSA -keysize 2048 -validity 10000
```

Remember that the Maps API key is restricted to a signing certificate's SHA-1,
so a release-signed build needs its own Maps key (section 7).

### Installing

```powershell
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

---

## 15. Production builds

```powershell
cd mobile

# Local release binaries
npx expo run:android --variant release
npx expo run:ios --configuration Release

# EAS (cloud) builds — configure eas.json first
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile production
eas build --platform ios --profile production
```

Before shipping anything beyond a demo:

* set `MATRIX_CORS_ORIGINS` on the backend instead of the `*` default,
* put the inference service behind TLS with authentication and rate limiting,
* create **release** Maps API keys restricted to the release signing certificate,
* keep `.env` out of the build image; supply keys via EAS secrets.

---

## 16. Verifying the model was not touched

```powershell
python backend/tools/verify_ml_integrity.py
```

```
checked 638 files under model/ (dataset excluded)
UNCHANGED - every frozen artifact is byte-identical to the baseline.
```

Also available:

| Command | Proves |
|---|---|
| `python backend/tools/streaming_parity_check.py` | the streaming API reproduces the offline frozen pipeline |
| `python backend/tools/export_onnx.py --verify-only` | the bundled ONNX graphs still reproduce PyTorch |
| `python backend/tools/validate_geo_convention.py` | the map projection's yaw convention matches real GNSS |
| `python -m pytest backend/tests -q` | the frozen contract (window, τ, k, feature order, scaler) is intact |
| `cd mobile; npm test` | 153 tests: GNSS states, buffering, request/response, mode switching, polylines, the on-device path and the frozen-filter port |

---

## 17. Limitations

Carried forward from `model/RUN.md` §18 and the reports, and shown to users in
the app's About screen:

* Dead reckoning **drifts**: metres over 10 s, hundreds of metres over 300 s.
* Trained and tested on **one phone** (Huawei P20 Pro) in **one vehicle**
  (Ford Fiesta). Cross-device generalisation is **untested**.
* Three drivers; the test split is a single unseen driver.
* The model assumes **exactly 10 Hz**. Out-of-spec windows are dropped.
* Dead reckoning needs a **velocity anchor** at outage start. Offline evaluation
  uses ground-truth VBOX velocity; production uses the last GNSS fix, whose
  error propagates (`model/RUN.md` §17 gap #10).
* Beyond ~300 s, **yaw drift dominates** (65% of error).
* Benchmark figures are measured research results on one dataset, **not** a
  guarantee of real-world accuracy. The app labels them as such everywhere.
* On-device inference **is** implemented (this closes `model/RUN.md` §17 gap
  #7), and is the default. In Server mode, or if the bundled models fail to
  load in Auto mode, the app depends on the service; when neither is available
  it reports that and shows no estimated position rather than a guess.
* The on-device path adds about 1.2 MB of ONNX graphs and the ONNX Runtime
  native library (~15 MB of ABI-specific `.so` files) to the APK.
* On-device inference has been verified numerically against PyTorch and by unit
  test, but **not yet measured on real Android hardware** — no device was
  available during the build. Expected latency is a few milliseconds per window
  for a 151k-parameter model; confirm with Diagnostics → Inference service →
  Last inference on a real phone.
