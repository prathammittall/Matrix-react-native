/**
 * On-device inference — the offline path.
 *
 * Runs the two FROZEN models with ONNX Runtime directly on the phone, so dead
 * reckoning works with no network at all. What runs here is exactly what runs
 * on the server:
 *
 *   weights        exported from the frozen checkpoints by
 *                  `backend/tools/export_onnx.py`, which refuses to write the
 *                  files unless they reproduce PyTorch on real test windows
 *                  (verified: max |onnx − torch| = 1.9e-6)
 *   scaler         `feature_mean` / `feature_std` copied verbatim from
 *                  `scaler.json[:6]` into `frozen_runtime.json`
 *   target scalers copied verbatim from the checkpoints
 *   fusion         `@/services/frozen-fusion`, a transcription of the frozen
 *                  Python held to it by golden-vector tests
 *   τ, k, dt       copied from `frozen_fusion_config.json`
 *
 * Nothing is re-derived, re-fitted or approximated. The model is not quantised:
 * it is 151k parameters and runs in single figures of milliseconds on CPU, so
 * there is no reason to trade accuracy for speed.
 */
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import type { InferenceSession as OrtSession } from 'onnxruntime-react-native';

import { FROZEN } from './config';
import { fuseAndDeadReckon, type FusionConstants } from './frozen-fusion';
import { bearingFromFrozenHeading, localToLatLng } from './geo';
import type {
  DeadReckoningState,
  LatLng,
  MlTelemetry,
  OutageAnchor,
  SensorSample,
  ServiceSessionState,
} from '@/types';

import runtimeManifest from '@/../assets/models/frozen_runtime.json';

export interface FrozenRuntimeManifest {
  window_samples: number;
  sampling_rate_hz: number;
  dt_s: number;
  k: number;
  tau_s: number;
  features: string[];
  feature_mean: number[];
  feature_std: number[];
  delta_v: { file: string; target_mean: number[]; target_std: number[]; source_sha256: string; onnx_sha256: string };
  abs_v: { file: string; target_mean: number[]; target_std: number[]; source_sha256: string; onnx_sha256: string };
  opset: number;
  verification: { tolerance: number; results: Record<string, { max_abs_diff: number }> };
}

export const MANIFEST = runtimeManifest as unknown as FrozenRuntimeManifest;

const WINDOW = MANIFEST.window_samples;
const N_FEAT = MANIFEST.features.length;
const CONSTANTS: FusionConstants = {
  k: MANIFEST.k,
  dt: MANIFEST.dt_s,
  tau: MANIFEST.tau_s,
};

/** Same contiguity rule the frozen `dv_common.dense` applies. */
const SPAN_NOMINAL = (WINDOW - 1) * MANIFEST.dt_s;
const SPAN_TOL = 0.1 * SPAN_NOMINAL;

export class OnDeviceModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnDeviceModelError';
  }
}

/**
 * ONNX Runtime is loaded LAZILY and defensively, never at module import.
 *
 * `onnxruntime-react-native` installs its JSI bindings from module scope, so a
 * missing or unregistered native module throws during import — which takes the
 * whole app down at startup before anything renders. That is exactly what
 * happened: `TypeError: Cannot read property 'install' of null`.
 *
 * Requiring it on first use instead means a failure surfaces as "AI service
 * unavailable" on the navigation screen, which the app already knows how to
 * show, rather than as a crash.
 */
type OrtModule = typeof import('onnxruntime-react-native');
let ortModule: OrtModule | null = null;
let ortError: string | null = null;

function ort(): OrtModule {
  if (ortModule) return ortModule;
  if (ortError) throw new OnDeviceModelError(ortError);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ortModule = require('onnxruntime-react-native') as OrtModule;
  } catch (err) {
    ortError =
      'ONNX Runtime is not available in this build: ' +
      (err instanceof Error ? err.message : String(err));
    throw new OnDeviceModelError(ortError);
  }
  return ortModule;
}

/** True when on-device inference can run at all. Never throws. */
export function isOnDeviceAvailable(): boolean {
  try {
    ort();
    return true;
  } catch {
    return false;
  }
}

/** One outage: accumulated predictions plus the frozen fused track. */
class LocalOutage {
  readonly dv: number[] = [];
  readonly va: number[] = [];
  readonly yaw: number[] = [];
  readonly times: number[] = [];
  path: LatLng[] = [];
  // typed as ArrayBufferLike so the frozen-fusion return type assigns cleanly
  private v: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private h: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private x: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private y: Float64Array<ArrayBufferLike> = new Float64Array(0);

  constructor(
    readonly anchor: OutageAnchor,
    readonly startedAtS: number,
  ) {}

  get samples() {
    return this.dv.length;
  }

  get durationS() {
    return this.times.length ? this.times[this.times.length - 1] - this.startedAtS : 0;
  }

  append(dv: number, va: number, yaw: number, t: number) {
    this.dv.push(dv);
    this.va.push(va);
    this.yaw.push(yaw);
    this.times.push(t);
  }

  /**
   * Re-run the frozen fusion over the WHOLE outage.
   *
   * Same choice the server makes: recomputing from scratch is O(n) on at most
   * 3000 samples (a fraction of a millisecond) and removes any chance of an
   * incremental shortcut drifting away from the frozen filter.
   */
  recompute() {
    if (!this.dv.length) return;
    const out = fuseAndDeadReckon(this.dv, this.va, this.yaw, this.anchor.speed_mps, CONSTANTS);
    this.v = out.v;
    this.x = out.x;
    this.y = out.y;
    this.h = out.h;
    const origin = {
      lat0: this.anchor.latitude,
      lon0: this.anchor.longitude,
      heading0Deg: this.anchor.bearing_deg ?? 0,
    };
    const path: LatLng[] = new Array(out.x.length);
    for (let i = 0; i < out.x.length; i += 1) path[i] = localToLatLng(out.x[i], out.y[i], origin);
    this.path = path;
  }

  snapshot(): DeadReckoningState {
    const n = this.path.length;
    if (n === 0) {
      return {
        active: true,
        samples: 0,
        duration_s: 0,
        latitude: this.anchor.latitude,
        longitude: this.anchor.longitude,
        velocity_mps: this.anchor.speed_mps,
        heading_deg: this.anchor.bearing_deg ?? 0,
        distance_m: 0,
        delta_v: null,
        yaw_rate: null,
      };
    }
    const last = this.path[n - 1];
    return {
      active: true,
      samples: this.samples,
      duration_s: Number(this.durationS.toFixed(2)),
      latitude: last.latitude,
      longitude: last.longitude,
      velocity_mps: this.v[n - 1],
      heading_deg: bearingFromFrozenHeading(this.anchor.bearing_deg ?? 0, this.h[n - 1]),
      distance_m: Math.hypot(this.x[n - 1], this.y[n - 1]),
      delta_v: this.dv[this.dv.length - 1],
      yaw_rate: this.yaw[this.yaw.length - 1],
    };
  }
}

/**
 * The offline engine.
 *
 * Mirrors the server's `DRSession` surface so the navigation layer does not
 * care which one it is talking to.
 */
export class OnDeviceInference {
  private deltaV: OrtSession | null = null;
  private absV: OrtSession | null = null;
  private ready = false;

  /** rolling window, oldest-to-newest, capped at WINDOW */
  private buf: { t: number; f: number[] }[] = [];
  private outage: LocalOutage | null = null;

  sessionId = `local_${Date.now()}`;
  samplesIngested = 0;
  windowsInferred = 0;
  rejectedWindows = 0;
  lastInferenceMs: number | null = null;
  lastTelemetry: MlTelemetry | null = null;
  completedOutages = 0;

  get isReady() {
    return this.ready;
  }

  /** Load both ONNX graphs from the bundled assets. Idempotent. */
  async init(): Promise<void> {
    if (this.ready) return;
    // allSettled, not all: when ONNX Runtime is missing BOTH loads reject, and
    // Promise.all adopts only the first — the second is then an unhandled
    // rejection, which React Native reports as a fatal exception in release.
    // That turned an "AI unavailable" condition into a hard crash. Settling
    // both first means every rejection is observed; we then surface one.
    const [dv, abs] = await Promise.allSettled([
      createSession(require('@/../assets/models/matrix_delta_v.onnx'), 'matrix_delta_v.onnx'),
      createSession(require('@/../assets/models/matrix_abs_v.onnx'), 'matrix_abs_v.onnx'),
    ]);
    if (dv.status === 'rejected') throw dv.reason;
    if (abs.status === 'rejected') throw abs.reason;
    [this.deltaV, this.absV] = [dv.value, abs.value];
    this.ready = true;
    // Warm both graphs so the first real window is not the slow one.
    await this.run(new Float32Array(WINDOW * N_FEAT), 1);
  }

  /** Scale → run both models → unscale. Mirrors the frozen `dv_common.predict`. */
  private async run(scaled: Float32Array, batch: number) {
    if (!this.deltaV || !this.absV) throw new OnDeviceModelError('models are not loaded');
    const input = new (ort().Tensor)('float32', scaled, [batch, WINDOW, N_FEAT]);
    const [dvOut, absOut] = await Promise.all([
      this.deltaV.run({ window: input }),
      this.absV.run({ window: input }),
    ]);
    const dvRaw = dvOut.prediction.data as Float32Array;
    const absRaw = absOut.prediction.data as Float32Array;

    const dvMu = MANIFEST.delta_v.target_mean;
    const dvSd = MANIFEST.delta_v.target_std;
    const abMu = MANIFEST.abs_v.target_mean;
    const abSd = MANIFEST.abs_v.target_std;

    const dv = new Float64Array(batch);
    const yaw = new Float64Array(batch);
    const vAbs = new Float64Array(batch);
    for (let i = 0; i < batch; i += 1) {
      dv[i] = dvRaw[i * 2] * dvSd[0] + dvMu[0];
      yaw[i] = dvRaw[i * 2 + 1] * dvSd[1] + dvMu[1];
      vAbs[i] = absRaw[i * 2] * abSd[0] + abMu[0];
    }
    return { dv, yaw, vAbs };
  }

  /** Ingest samples, forming and inferring every complete frozen window. */
  async ingest(samples: SensorSample[]): Promise<ServiceSessionState> {
    if (!this.ready) throw new OnDeviceModelError('on-device models are not loaded');

    const windows: number[][] = [];
    const ends: number[] = [];

    for (const s of samples) {
      this.buf.push({
        t: s.t,
        f: [s.acc_x, s.acc_y, s.acc_z, s.gyro_x, s.gyro_y, s.gyro_z],
      });
      if (this.buf.length > WINDOW) this.buf.shift();
      this.samplesIngested += 1;
      if (this.buf.length < WINDOW) continue;

      const span = this.buf[WINDOW - 1].t - this.buf[0].t;
      if (Math.abs(span - SPAN_NOMINAL) >= SPAN_TOL) {
        // Out of specification: the frozen model assumes exactly 10 Hz.
        this.rejectedWindows += 1;
        continue;
      }
      const flat: number[] = [];
      let finite = true;
      for (const row of this.buf) {
        for (const value of row.f) {
          if (!Number.isFinite(value)) finite = false;
          flat.push(value);
        }
      }
      if (!finite) {
        this.rejectedWindows += 1;
        continue;
      }
      windows.push(flat);
      ends.push(this.buf[WINDOW - 1].t);
    }

    if (windows.length) {
      const mu = MANIFEST.feature_mean;
      const sd = MANIFEST.feature_std;
      const scaled = new Float32Array(windows.length * WINDOW * N_FEAT);
      let w = 0;
      for (const flat of windows) {
        for (let i = 0; i < flat.length; i += 1) {
          const c = i % N_FEAT;
          scaled[w++] = (flat[i] - mu[c]) / sd[c];
        }
      }

      const t0 = Date.now();
      const { dv, yaw, vAbs } = await this.run(scaled, windows.length);
      this.lastInferenceMs = Date.now() - t0;
      this.windowsInferred += windows.length;

      const last = windows.length - 1;
      this.lastTelemetry = {
        timestamp_s: ends[last],
        delta_v: dv[last],
        yaw_rate: yaw[last],
        v_abs_pred: vAbs[last],
      };

      if (this.outage) {
        for (let i = 0; i < windows.length; i += 1) {
          this.outage.append(dv[i], vAbs[i], yaw[i], ends[i]);
        }
        this.outage.recompute();
      }
    }

    return this.state();
  }

  startOutage(anchor: OutageAnchor) {
    if (this.outage) throw new OnDeviceModelError('an outage is already active');
    const startedAt = anchor.timestamp_s ?? this.buf[this.buf.length - 1]?.t ?? 0;
    this.outage = new LocalOutage(anchor, startedAt);
    return this.state();
  }

  endOutage() {
    if (!this.outage) throw new OnDeviceModelError('no outage is active');
    const o = this.outage;
    this.outage = null;
    this.completedOutages += 1;
    const snap = o.snapshot();
    return {
      duration_s: snap.duration_s,
      samples: snap.samples,
      dr_distance_m: snap.distance_m,
      path: o.path,
      estimated: { latitude: snap.latitude, longitude: snap.longitude },
      heading_deg: snap.heading_deg,
      velocity_mps: snap.velocity_mps,
    };
  }

  get activeOutage() {
    return this.outage;
  }

  state(): ServiceSessionState {
    return {
      session_id: this.sessionId,
      mode: this.outage ? 'DEAD_RECKONING' : 'GNSS',
      samples_ingested: this.samplesIngested,
      windows_inferred: this.windowsInferred,
      rejected_windows: this.rejectedWindows,
      buffer_fill: this.buf.length,
      buffer_required: WINDOW,
      last_inference_ms: this.lastInferenceMs,
      telemetry: this.lastTelemetry,
      outage: this.outage ? this.outage.snapshot() : null,
      completed_outages: this.completedOutages,
      k: MANIFEST.k,
      tau_s: MANIFEST.tau_s,
    };
  }

  reset() {
    this.buf = [];
    this.outage = null;
    this.samplesIngested = 0;
    this.windowsInferred = 0;
    this.rejectedWindows = 0;
    this.completedOutages = 0;
    this.lastTelemetry = null;
    this.lastInferenceMs = null;
    this.sessionId = `local_${Date.now()}`;
  }

  async dispose() {
    await Promise.allSettled([this.deltaV?.release(), this.absV?.release()]);
    this.deltaV = null;
    this.absV = null;
    this.ready = false;
  }
}

/**
 * Open a bundled ONNX graph.
 *
 * The happy path is a plain file path: `expo-asset` unpacks the asset out of
 * the APK into the cache directory and reports a `file://` URI. Some Android
 * configurations hand back a URI ONNX Runtime will not open directly, so the
 * fallback reads the bytes and builds the session from a Uint8Array instead —
 * the same graph either way.
 */
async function createSession(moduleId: number, name: string): Promise<OrtSession> {
  const asset = Asset.fromModule(moduleId);
  if (!asset.downloaded) await asset.downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri) throw new OnDeviceModelError(`bundled model ${name} has no local URI`);

  const path = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  try {
    return await ort().InferenceSession.create(path);
  } catch (pathError) {
    try {
      const bytes = new Uint8Array(await new File(uri).arrayBuffer());
      return await ort().InferenceSession.create(bytes);
    } catch (bytesError) {
      const a = pathError instanceof Error ? pathError.message : String(pathError);
      const b = bytesError instanceof Error ? bytesError.message : String(bytesError);
      throw new OnDeviceModelError(
        `Could not load the on-device model ${name} (by path: ${a}; by bytes: ${b})`,
      );
    }
  }
}

/** Sanity check that the bundled manifest still matches the frozen contract. */
export function manifestMatchesFrozenContract(): boolean {
  return (
    MANIFEST.window_samples === FROZEN.WINDOW_SAMPLES &&
    MANIFEST.k === FROZEN.K &&
    MANIFEST.tau_s === FROZEN.TAU_S &&
    Math.abs(MANIFEST.sampling_rate_hz - FROZEN.SAMPLE_RATE_HZ) < 1e-9 &&
    MANIFEST.features.length === FROZEN.FEATURES.length &&
    MANIFEST.features.every((f, i) => f === FROZEN.FEATURES[i])
  );
}

export const onDevice = new OnDeviceInference();
