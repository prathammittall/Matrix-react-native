# MATRIX — session handoff

Context for continuing work in a new chat. Written 2026-09-12.

---

## 1. What this project is

MATRIX is an AI dead-reckoning navigation app: when GNSS drops, a trained model
reads the phone's IMU and keeps estimating position until GNSS returns.

```
Pre ppt round prototype/
├── model/       FROZEN ML system — NEVER MODIFY (see §2)
├── backend/     FastAPI inference service + export tools   (NEW, this session)
├── mobile/      Expo / React Native app                    (built out this session)
├── reports/     frozen experiment write-ups
├── FRONTEND_RUN.md   full operating manual                 (NEW)
└── HANDOFF.md        this file
```

---

## 2. THE ABSOLUTE RULE — `model/` is frozen

Never modify anything under `model/`: weights, architecture, preprocessing,
scaler, feature order, Δv formulation, yaw target, τ, dead-reckoning maths,
dataset, splits, configs.

Verify at any time:

```powershell
python backend/tools/verify_ml_integrity.py
```

Expected: `UNCHANGED - every frozen artifact is byte-identical to the baseline.`
(638 files, dataset excluded. Baseline: `backend/ml_integrity_manifest.json`.)

**Status: verified UNCHANGED as of the last check this session.**

### The frozen system (two models + a filter)

| Component | Artifact |
|---|---|
| Δv model | `model/experiments/delta_v/checkpoints/best_k5_huber.pt` |
| absolute-v model | `model/baseline/checkpoints/best_huber.pt` |
| complementary filter | τ=20 s, k=5, dt=0.1, velocity floor 0 |

Input contract: **50 samples × 6 channels @ exactly 10 Hz**, order
`acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z`, acceleration in m/s² with gravity
retained. Scaler = `scaler.json` first 6 of 11 entries, train-split only.

---

## 3. Work completed this session (do NOT redo)

### Backend inference service — `backend/`
FastAPI service that imports the frozen model read-only. Endpoints under
`/api/v1`: `health`, `model/info`, `benchmarks`, `inference`, `sessions/*`,
`demo/sessions/*`. Closes `model/RUN.md` §12 (no API existed).

Run: `python -m uvicorn matrix_service.api:app --app-dir backend --host 0.0.0.0 --port 8000`

### On-device (offline) inference — ALREADY VERIFIED, DO NOT RE-RUN
* ONNX export: `backend/tools/export_onnx.py` → `mobile/assets/models/*.onnx`
  Verified against PyTorch on 256 real test windows: **max |onnx − torch| = 1.9e-6**
  (tolerance 1e-4). CPU-vs-CPU comparison — that's what the phone runs.
* Frozen filter ported to TS: `mobile/src/services/frozen-fusion.ts`, pinned to
  the Python original by golden vectors
  (`backend/tools/export_fusion_golden.py` → `mobile/__tests__/fixtures/fusion_golden.json`).
* Yaw-sign convention validated against real GNSS: `YAW_SIGN = +1`
  (15.8 m residual vs 131.4 m for −1).
* Streaming API proven identical to the offline pipeline (0.25 mm difference).

**These are done and authoritative. Do not re-run ONNX/PyTorch parity, golden-vector,
yaw-validation, streaming-parity, dataset, training or accuracy experiments.**

### Frontend — `mobile/`
9 screens (Dashboard, Live Navigation, History, Settings, Demo Mode,
Diagnostics, Session detail, Outage analytics, About) plus a component/UI kit.
Services layer: `sensors`, `gnss`, `navigation-engine`, `inference-backend`,
`ondevice-inference`, `frozen-fusion`, `geo`, `api`, `demo-source`,
`demo-player`, `track`, `storage`, `format`.

Three states kept separate: `GnssState` (receiver), `InferenceState` (ML),
`NavigationMode` (what the app navigates by). Rule:
`GNSS OUTAGE + inference down → DEGRADED` — show no position rather than a guess.

### Google Maps → MapLibre (this session)
`react-native-maps` removed. `@maplibre/maplibre-react-native@11.3.10` with
OpenStreetMap raster tiles. **No API key, no billing.** All Google Maps config
removed from `app.config.js`, `.env.example`, `config.ts`, `diagnostics.tsx`.
Map styles reduced to `standard` | `terrain` (no satellite without a paid provider).

Offline caveat: basemap *tiles* need network on first view; navigation overlays
and the AI itself work with no network.

### Tests (already passing — don't re-run routinely)
153 frontend (jest), 28 backend (pytest), typecheck clean.

---

## 4. CURRENT STATE — where things stand right now

### APK builds successfully
```
D:\Projects\Dead Reaconking system\Pre ppt round prototype\mobile\build-output\matrix-release.apk
```
88.9 MB, arm64-v8a, rebuilt 2026-09-12 23:11 (the verified-working build).

Build directory (a **copy**, not the source of truth):
```
C:\mx\android\app\build\outputs\apk\release\app-release.apk
```

Build command:
```powershell
cd C:\mx\android
.\gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

### ✅ CONFIRMED WORKING on a real device (2026-09-12 23:11)
Verified on a vivo V2153 (arm64, Android 15): app launches, all four tabs
render, Start Navigation runs with `SOURCE: AI model`, Demo Mode replays a
Coventry outage, and Diagnostics reports **Graph loaded: yes**, *Matches frozen
contract: yes*, opset 17, `max |onnx - torch| = 1.91e-6`. Zero fatal exceptions
in logcat across the whole sweep.

---

## 5. The crash and its real fix

Three separate faults, found in this order. Only the third was the actual
startup blocker; the first two were introduced by a misdiagnosis.

### 5.1 The real root cause — OnnxruntimePackage was never registered

```
TypeError: Cannot read property 'install' of null
  ort@1:1436295
  ?anon_0_createSession@1:2178413
```

`onnxruntime-react-native` ships **no `react-native.config.js` and no codegen
spec**. Expo's autolinking therefore resolves its Gradle *project* — verify with
`npx expo-modules-autolinking resolve -p android --json`, which reports
`"packages": []` for it — so the Java and the `.so` are compiled into the app,
but `OnnxruntimePackage` never reaches the generated `PackageList.java`.
`NativeModules.Onnxruntime` was consequently `null`.

**Fix:** register it by hand in `MainApplication.kt`, in the placeholder slot
the Expo template provides:

```kotlin
PackageList(this).packages.apply { add(OnnxruntimePackage()) }
```

Made permanent by `mobile/plugins/with-onnxruntime-package.js`, wired into
`app.config.js`. `android/` is generated, so without the plugin
`expo prebuild --clean` regresses the app to this crash.

Verify after any prebuild:
```powershell
Select-String -Path mobile/android/app/src/main/java/com/matrix/deadreckoning/MainApplication.kt -Pattern OnnxruntimePackage
```

### 5.2 Second crash path — an unhandled rejection turned a fault into a crash

`OnDeviceModel.init()` loaded both graphs with `Promise.all`. When ORT is
missing **both** loads reject; `Promise.all` adopts only the first, leaving the
second an unhandled rejection, which React Native reports as a *fatal* in
release. So an "AI unavailable" condition killed the app instead of degrading.
Now `Promise.allSettled`, then surface one rejection — every rejection is
observed. (`mobile/src/services/ondevice-inference.ts`)

### 5.3 The misdiagnosis — do NOT reintroduce it

The previous session read `install of null` as a New Architecture problem and
added a `ReactNativeFeatureFlags.override { useTurboModuleInterop = true }` to
`MainApplication.onCreate`. **That was wrong and caused two further crashes:**

1. `SoLoader.init() not yet called` — the override reaches into
   `libreactnative.so` before `loadReactNative()` initialises SoLoader.
2. After fixing that ordering: `Feature flags cannot be overridden more than
   once` — `loadReactNative()` performs its own override and RN forbids a second.

The override was never needed. Decompiling `react-android-0.86.3-release.aar`
shows `DefaultNewArchitectureEntryPoint.load()` installs
`ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android`, which extends
`ReactNativeNewArchitectureFeatureFlagsDefaults`, whose `useTurboModuleInterop()`
is a hardcoded `true` and is not overridden. **TurboModule interop is already on
by default.** `MainApplication.kt` is back to stock apart from the
`add(OnnxruntimePackage())` line.

### 5.4 Also still in place (from the previous session)

* `OnnxruntimeModule.java`: `getCatalystInstance()` (bridge-only, throws under
  bridgeless) → `getReactApplicationContext().getJSCallInvokerHolder()`. This
  only started mattering once the module actually registered and `install()`
  could run.
* `SplashScreen.hideAsync()` in `mobile/src/app/_layout.tsx`.
* Lazy `require` guard + `isOnDeviceAvailable()` in `ondevice-inference.ts`.

---

## 6. ✅ Loose ends — both closed

1. **`patches/onnxruntime-react-native+1.24.3.patch` now contains the Java
   bridgeless fix.** `npx patch-package` still dies on a git CRLF warning
   (`core.autocrlf false` does not help — it is patch-package's own temp repo),
   so the hunk was hand-written and verified by applying the patch to a pristine
   `npm pack onnxruntime-react-native@1.24.3`: applies clean, `getCatalystInstance`
   gone. `postinstall: patch-package` is wired, so `npm install` keeps it.
   Note: `git apply` fails with *"Filename too long"* if run from a deeply nested
   directory — test from a short path such as `C:\pt`.

2. **`MainApplication.kt` no longer needs manual repair after a prebuild** —
   `mobile/plugins/with-onnxruntime-package.js` reapplies the one required edit.
   The plugin is idempotent and fails loudly if the Expo template changes.

---

## 7. Build environment — hard-won knowledge, don't relearn

| Problem | Cause | Fix |
|---|---|---|
| `SDK location not found` | `local.properties` with backslashes (escape chars in `.properties`), and PowerShell 5.1 `Set-Content -Encoding utf8` adds a **BOM** → key parses as `<BOM>sdk.dir` | `sdk.dir=C:/Users/prath/AppData/Local/Android/Sdk` with forward slashes, written via `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))` |
| `ENOSPC` ×14 | D: drive was full | build on C: (had ~48 GB free) |
| `ninja: manifest 'build.ninja' still dirty after 100 tries` | CMake object-path length limit; the project path is deep and CMake mangles the spaces in `Dead Reaconking system\Pre ppt round prototype` | build from a **short path**: `C:\mx` |
| `this and base files have different roots` | copied build dirs still held `D:` paths | delete `android/build`, `android/app/build`, `node_modules/*/android/build` after copying |
| `Cannot find module '../build'` | robocopy `/XD build` excluded real package source | never exclude dirs named `build` from `node_modules` |

**Other environment facts:**
* JDK: `C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot`
* Android SDK: `C:\Users\prath\AppData\Local\Android\Sdk`
* Do **not** set `ANDROID_HOME` with mixed separators — leave it unset, use `local.properties`
* `-PreactNativeArchitectures=arm64-v8a` is a documented `gradle.properties`
  override (line 30). Covers modern phones; excludes 32-bit ARM and x86 emulators.
  Drop it when there's ~10 GB free to build all four ABIs.
* Release builds are signed with the **debug keystore** (expo prebuild default) —
  fine for a demo, not for distribution.
* Use `--no-daemon`; long builds should be backgrounded with the log written
  **outside** the build dir.
* `C:\mx` is a COPY. Re-sync from `mobile/` after source changes, then re-apply
  the two loose-end fixes in §6.

### A correction worth remembering
I initially blamed the **spaces in the project path** for early build failures and
copied the project to `D:\matrix-build`. That was wrong — those failures were the
malformed SDK path. A dry-run later confirmed Gradle configures fine in the real
project path. Spaces **do** matter, but only for the CMake/ninja native phase.
The `D:\matrix-build` copy also filled the D: drive and was deleted.

---

## 8. Expo Go does not work — this is expected

`npx expo start` + Expo Go shows:
* `TurboModuleRegistry.getEnforcing(...): 'MLRNCameraModule' could not be found` (MapLibre)
* `Cannot read property 'install' of null` (onnxruntime)
* cascading "missing default export" / `ErrorBoundary of undefined` warnings

Both are native modules that don't exist in Expo Go. Use a development build
(`npx expo run:android`) or the release APK. This is not a bug to fix.

---

## 9. Immediate next steps

The app is verified working. What is genuinely untested:

1. **A real drive.** Everything so far was verified stationary and indoors, with
   GNSS unavailable. The on-road behaviour — outage entry/exit, drift against a
   real fix — has not been exercised on this build.
2. **Grant location permission.** Diagnostics showed `Location permission:
   denied`, which is why GNSS reads OFFLINE. Use *Request location permission*
   on the Diagnostics screen.
3. Optionally run the backend if you want *Inference API* to leave OFFLINE — it
   is not needed for navigation, which runs fully on-device.

## 10. Documentation already written

* `FRONTEND_RUN.md` — prerequisites, install, env vars, MapLibre, backend,
  on-device inference, Demo Mode, architecture diagram, troubleshooting,
  APK build, limitations.
* `backend/README.md` — API contract, frozen-model guarantees, ONNX export,
  verification tools.
* `mobile/README.md` — quick start.
* `mobile/scripts/build-apk.ps1` — build helper (its header still claims spaces
  are the blocker and defaults to `D:\matrix-build`; both are stale — see §7).

## 11. Known limitations (stated in the app's About screen)

Dead reckoning drifts (metres at 10 s, hundreds of metres at 300 s). Trained on
one phone (Huawei P20 Pro) in one vehicle (Ford Fiesta), three drivers, test =
one unseen driver. Model assumes exactly 10 Hz; out-of-spec windows are dropped,
not resampled. Needs a velocity anchor at outage start — production uses the last
GNSS fix, whose error propagates. Beyond ~300 s yaw drift dominates. Benchmark
figures are research results on one dataset, not a real-world guarantee.

---

# Session addendum — 2026-09-21, branch `feat/robust-dr-and-ui`

Written after the first on-road test of the release APK, which showed the app
announcing *AI DEAD RECKONING ACTIVE — 00:00 · 0 m* while the vehicle drove
away, and declaring GNSS lost on a clear road.

## What was actually wrong

**Dead reckoning produced no motion at all.** Not a model problem — an input
problem. The IMU emitter stamped each sample with the wall clock at whatever
moment `setInterval(100)` happened to fire. RN timer drift pushed a 50-sample
window's span to 5.3–5.5 s against a nominal 4.9 s, outside the frozen ±10 %
contiguity tolerance, so `ingest` rejected **every** window. `windows_inferred`
never left zero, the outage accumulated nothing, and the UI faithfully reported
a duration and distance of zero. Fixed by emitting onto a fixed grid: sample *n*
is stamped `n × 0.1` exactly and is due at `t₀ + n × 100 ms`.

**Outage detection fired on noise.** `Debouncer` counted consecutive agreeing
readings, but `recomputeMode` was called from two sources at different rates —
a GNSS fix and an inference reply 50 ms apart satisfied the 2-sample threshold.
Replaced with `ConfirmationGate`, a wall-clock hold. `ACCURACY_OUTAGE_M` also
went 60 → 150 m with hysteresis: a phone on cell/Wi-Fi positioning reports
50–100 m, which is a position, not a loss.

**Nothing re-evaluated anything on the clock.** `GnssService.emit()` only ran on
fix arrival, so `age` was always ~0 in whatever the UI held and a dead receiver
looked healthy forever; and the screens computed Elapsed from `Date.now()` at
render time, which froze the display the moment the engine stopped emitting.
Both fixed by a 2 Hz heartbeat in the engine (`TUNING.HEARTBEAT_MS`) that
re-reads GNSS and maintains `elapsedS` / `outageElapsedS` / `heldS`.

## Also changed

* `ACQUIRING` is a real state now, for both `GnssState` and `NavigationMode`.
  Before the first fix the app used to say GNSS LOST and fall to DEGRADED,
  because dead reckoning had no anchor.
* DEGRADED holds and labels the last known position (hollow puck) instead of
  blanking the map. An inference stumble mid-outage no longer *ends* the outage
  and throws away its anchor and track.
* `mobile/src/services/motion-constraints.ts` — ZUPT plus yaw-bias removal,
  outside the frozen boundary, toggleable from Settings. NHC deliberately not
  implemented; the reason is in the module header.
* Monochrome theme (black ground, white type), `theme` setting, progressive
  disclosure on Navigate and Settings.
* `backend/tools/verify_ml_integrity.py` reported MODIFIED on every fresh clone
  — line endings and gitignored derived data. Both fixed; it now passes here.

## Still untested

The on-road behaviour these fixes were written for. And the ZUPT thresholds are
reasoned from the sensor noise floor, not tuned against the VBOX reference.
See `RESEARCH.md` §4.1.

## Note on the paths in §7 above

They refer to the original machine (`D:\Projects\...`, `C:\mx`). This work was
done in a clone at `C:\repo\Matrix-react-native`, which had no `node_modules`;
`npm install` is required before `npm test` or `npm run typecheck`. Do not run
two `npm install`s concurrently on Windows — they collide with ENOTEMPTY and
leave a half-installed tree.
