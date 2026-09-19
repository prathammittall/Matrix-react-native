# MATRIX Inference API

A thin HTTP serving layer around the **frozen** MATRIX dead-reckoning system.

`model/RUN.md` §12 recorded "API endpoint is not currently implemented". This is
that endpoint. It adds serving; it changes nothing about the model.

---

## Frozen-model contract

Everything that can affect accuracy is **imported from `model/` and called
unchanged**. `matrix_service/frozen.py` is the only module that touches the ML
tree, and it is read-only.

| Quantity | Produced by | Source file |
|---|---|---|
| architecture | `MatrixBaseline` | `model/baseline/train_baseline.py` |
| feature scaler | `FMU`, `FSD` (`scaler.json[:6]`) | `model/experiments/delta_v/dv_common.py` |
| scale → forward → unscale | `predict()` | `model/experiments/delta_v/dv_common.py` |
| velocity anchoring | `v_abs_anchored()` | `.../complementary_fusion/phase2_4_fusion_select.py` |
| complementary filter | `complementary()` | `.../phase2_4_fusion_select.py` |
| heading + position | `dead_reckon()` | `.../phase2_4_fusion_select.py` |
| τ, k, dt | `frozen_fusion_config.json` | `.../complementary_fusion/` |

The service defines **no** model mathematics of its own. Two things live in the
integration layer and are documented as such:

1. **`matrix_service/geo.py`** — rotating the frozen planar track `(x, y, heading)`
   onto WGS-84 latitude/longitude. This is map projection, not modelling; it
   cannot change an error metric, only where the picture is drawn. The one real
   convention choice (does a positive yaw rate mean a left turn?) is settled
   empirically, not assumed — see below.
2. **Session bookkeeping** — buffering samples, tracking outage boundaries.

### Streaming is provably identical to the offline pipeline

Rather than transcribing the frozen filter's recursion into an incremental
update (where it could drift), each update **re-runs the frozen functions over
the whole outage so far**. A 300 s outage is 3000 samples, so this costs
microseconds.

```powershell
python backend/tools/streaming_parity_check.py
```

Replays real IMU samples from a test session through the live HTTP API and
compares the result against the same outage computed offline:

```
outage 60 s | streamed samples 600 | offline windows 600
  streaming end  52.4061054, -1.5021463  v=13.0775 m/s
  offline   end  52.4061054, -1.5021463  v=13.0775 m/s
  position difference 0.000252 m | velocity difference 0.000016 m/s

PARITY OK - the serving layer does not alter the frozen pipeline
```

The sub-millimetre residual is GPU float noise from different batch sizes (50
per request vs one batch of 600), not a pipeline difference.

### Yaw-sign convention

`geo.YAW_SIGN` records whether a positive frozen `yaw_rate` is a left turn. It
was determined by dead-reckoning the recorded VBOX ground truth over 120 s
segments of the test sessions and fitting each to that segment's real GNSS fixes:

```
overall median residual: +1 -> 15.8 m, -1 -> 131.4 m
best convention: YAW_SIGN = +1
```

Re-check it any time with `python backend/tools/validate_geo_convention.py`.

### On-device export

`model/RUN.md` section 17 gap #7 recorded "No model export (ONNX/TorchScript)".
`tools/export_onnx.py` closes it. It traces the frozen architecture in eval
mode, writes the graphs to `mobile/assets/models/` (outside `model/`), copies
the frozen scalers and fusion constants into `frozen_runtime.json`, and then
verifies itself:

```powershell
python backend/tools/export_onnx.py
```

```
verifying on 256 real test-split windows
  delta_v    max |onnx - torch| = 2.757e-07   mean = 3.847e-08
  abs_v      max |onnx - torch| = 1.907e-06   mean = 2.671e-07

EXPORT VERIFIED  worst difference 1.907e-06 (tolerance 1e-04)
```

If the comparison fails the ONNX files are deleted rather than shipped. Re-check
an existing export at any time with `--verify-only`.

The mobile app then runs those graphs with ONNX Runtime and the frozen filter
ported to TypeScript, so dead reckoning works with no network. That port is held
to the Python original by golden vectors this repository generates:

```powershell
python backend/tools/export_fusion_golden.py
```

It runs the frozen `v_abs_anchored` / `complementary` / `dead_reckon` over real
outage segments (10 s to 300 s, plus a velocity-floor case) and writes their
exact inputs and outputs to `mobile/__tests__/fixtures/fusion_golden.json`;
`mobile/__tests__/frozen-fusion.test.ts` fails if the TypeScript disagrees by
more than 1e-6.

### Proving the model was not touched

```powershell
python backend/tools/verify_ml_integrity.py
```

Hashes all 638 files under `model/` (excluding the raw dataset) against
`backend/ml_integrity_manifest.json` and reports any change, flagging
accuracy-critical artifacts separately.

---

## Running

```powershell
cd "D:\Projects\Dead Reaconking system\Pre ppt round prototype"
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
python -m uvicorn matrix_service.api:app --app-dir backend --host 0.0.0.0 --port 8000
```

Interactive docs: <http://127.0.0.1:8000/docs>

Bind to `0.0.0.0` so a phone on the same Wi-Fi can reach it; `127.0.0.1` is
enough for an emulator.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MATRIX_MODEL_ROOT` | `<repo>/model` | where the frozen artifacts live |
| `MATRIX_MAX_SAMPLES` | `600` | max IMU samples per request (60 s at 10 Hz) |
| `MATRIX_MAX_SESSIONS` | `32` | concurrent navigation sessions |
| `MATRIX_SESSION_TTL` | `3600` | seconds before an idle session is evicted |
| `MATRIX_CORS_ORIGINS` | `*` | comma-separated allowed origins |

---

## Endpoints

All paths are prefixed `/api/v1`.

### Diagnostics

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness, model loaded, device, active sessions |
| GET | `/model/info` | frozen model identity: window, features, τ, k, parameter counts, **checkpoint SHA-256** |
| GET | `/benchmarks` | the frozen validation/test dead-reckoning results, read from `model/` as recorded, with an explicit disclaimer field |

### One-shot inference (stateless)

```http
POST /api/v1/inference
```

```jsonc
{
  "samples": [                       // EXACTLY 50, at 10 Hz (±10% span tolerance)
    { "t": 0.0, "acc_x": -0.97, "acc_y": -0.02, "acc_z": 9.97,
      "gyro_x": -0.004, "gyro_y": -0.109, "gyro_z": -0.037 }
    // ... 49 more
  ]
}
```

```jsonc
{
  "delta_v": -0.366,        // dv5 = v[t] - v[t-5], m/s over 0.5 s
  "yaw_rate": -0.1228,      // rad/s
  "v_abs_pred": 8.576,      // absolute-velocity anchor model, m/s
  "window_samples": 50,
  "features": ["acc_x","acc_y","acc_z","gyro_x","gyro_y","gyro_z"],
  "latency_ms": 3.1
}
```

This endpoint deliberately returns **no position**. A position requires the
stateful complementary filter and an anchor — use the session endpoints.

### Streaming sessions (stateful — this is what the app uses)

| Method | Path | Purpose |
|---|---|---|
| POST | `/sessions` | open a session, returns `session_id` |
| POST | `/sessions/{id}/samples` | push a batch of IMU samples; windows are formed and inferred server-side |
| POST | `/sessions/{id}/outage/start` | GNSS lost — supply the anchor |
| POST | `/sessions/{id}/outage/end` | GNSS returned — supply the recovery fix |
| GET | `/sessions/{id}` | current state |
| DELETE | `/sessions/{id}` | close |

`POST /sessions/{id}/samples`:

```jsonc
{ "samples": [ { "t": 12.3, "acc_x": …, "gyro_z": … } ] }   // 1..600 samples
```

Response (the same shape from every session endpoint):

```jsonc
{
  "session_id": "…",
  "mode": "GNSS",              // or "DEAD_RECKONING"
  "samples_ingested": 620,
  "windows_inferred": 571,
  "rejected_windows": 0,       // out-of-spec timing — dropped, never resampled
  "buffer_fill": 50,
  "buffer_required": 50,
  "last_inference_ms": 4.2,
  "telemetry": { "timestamp_s": 62.0, "delta_v": -0.37,
                 "yaw_rate": -0.12, "v_abs_pred": 8.58 },
  "outage": null,              // populated while an outage is open:
                               // { latitude, longitude, velocity_mps,
                               //   heading_deg, distance_m, duration_s, samples }
  "completed_outages": 0,
  "k": 5,
  "tau_s": 20.0
}
```

`POST /sessions/{id}/outage/start`:

```jsonc
{
  "latitude": 52.4026, "longitude": -1.5035,
  "speed_mps": 12.4,          // the anchor v0 — from the LAST GOOD GNSS FIX
  "bearing_deg": 271.0,
  "timestamp_s": 62.0
}
```

> **The anchor is the production weak point.** `model/RUN.md` §17 gap #10:
> offline evaluation anchors on ground-truth VBOX velocity. In production it
> comes from the last GNSS fix and its error propagates into the whole track.

`POST /sessions/{id}/outage/end` returns the finished outage, its full
dead-reckoned path, and — when a recovery fix is supplied — the recovery error
and heading error.

### Demo mode

| Method | Path | Purpose |
|---|---|---|
| GET | `/demo/sessions` | catalogue of exported recorded drives |
| GET | `/demo/sessions/{id}` | full payload: GNSS track, outages, frozen predictions, errors |

Populate with:

```powershell
python backend/tools/export_demo_sessions.py
```

Everything in a demo payload is a recorded measurement or the output of a frozen
function. If the export has not been run, `/demo/sessions` returns an empty list
with an explanatory `detail` — it never fabricates a trajectory.

---

## Input validation

Out-of-spec input is **rejected with 4xx, never coerced**:

* fewer or more than 50 samples on `/inference` → 422
* a window whose time span is not 4.9 s ±10% → 422 (the frozen model assumes
  exactly 10 Hz; resampling would put the input out of distribution)
* NaN/Inf in a window → the window is counted in `rejected_windows` and skipped
* latitude/longitude/speed/bearing outside physical ranges → 422
* more than `MATRIX_MAX_SAMPLES` per request → 400
* more than `MATRIX_MAX_SESSIONS` concurrent sessions → 503

## Security notes

* No secrets in source; all configuration is via environment variables.
* Sessions are bounded and TTL-evicted, so an abandoned client cannot leak memory.
* CORS defaults to `*` for local development — **set `MATRIX_CORS_ORIGINS`
  before exposing this service beyond localhost.**
* The service exposes model *metadata* (checkpoint hashes, parameter counts) but
  never serves the checkpoint files themselves.
* No authentication is implemented. This is a demo/research service and should
  sit behind a reverse proxy with auth and rate limiting if exposed publicly.

## Tests

```powershell
python -m pytest backend/tests -q               # 26 tests
python backend/tools/streaming_parity_check.py  # streaming == offline pipeline
python backend/tools/export_onnx.py --verify-only  # ONNX == PyTorch
python backend/tools/validate_geo_convention.py # yaw convention vs real GNSS
python backend/tools/verify_ml_integrity.py     # model/ unchanged
```
