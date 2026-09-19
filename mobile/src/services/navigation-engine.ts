/**
 * Navigation orchestration.
 *
 * This is the only place that decides which position source the app is using.
 * It consumes the GNSS sensor layer and the ML inference layer and produces a
 * single NavigationMode plus the tracks the map draws.
 *
 *   GNSS ACTIVE/WEAK              -> GNSS
 *   GNSS OUTAGE + inference READY -> DEAD_RECKONING
 *   GNSS OUTAGE + inference down  -> DEGRADED   (no position claimed)
 *
 * It never computes a dead-reckoned position itself. Position during an outage
 * comes from an InferenceBackend running the frozen model - either on-device
 * (ONNX Runtime, works with no network) or the inference service. Both produce
 * the same numbers. If neither can answer, the mode is DEGRADED and the UI says
 * so rather than showing a position it cannot justify.
 */
import { TUNING } from './config';
import { ApiError } from './api';
import { GnssService, haversineM } from './gnss';
import {
  resolveBackend,
  type BackendKind,
  type InferenceBackend,
  type InferenceMode,
} from './inference-backend';
import { SensorService } from './sensors';
import { appendPoint, pathLengthM } from './track';
import type {
  GnssStatus,
  InferenceState,
  LatLng,
  MlTelemetry,
  NavigationMode,
  NavigationSession,
  OutageEvent,
  ServiceSessionState,
} from '@/types';

// --------------------------------------------------------------- pure logic
export interface ModeInput {
  navigating: boolean;
  gnss: GnssStatus['state'];
  inference: InferenceState;
  /** true once the rolling 50-sample window is full on the service */
  windowReady: boolean;
}

/** The mode-selection rule, isolated so it can be tested exhaustively. */
export function nextMode({ navigating, gnss, inference, windowReady }: ModeInput): NavigationMode {
  if (!navigating) return 'IDLE';
  if (gnss === 'ACTIVE' || gnss === 'WEAK') return 'GNSS';
  // GNSS is OUTAGE or UNAVAILABLE from here on
  if (inference === 'READY' && windowReady) return 'DEAD_RECKONING';
  return 'DEGRADED';
}

/** Debounce helper: how many consecutive readings agree with `want`. */
export class Debouncer {
  private count = 0;
  private current: string | null = null;

  /** Returns true when `value` has been seen `threshold` times in a row. */
  push(value: string, threshold: number): boolean {
    if (value === this.current) this.count += 1;
    else {
      this.current = value;
      this.count = 1;
    }
    return this.count >= threshold;
  }

  reset() {
    this.count = 0;
    this.current = null;
  }
}

// ------------------------------------------------------------------ engine
export interface EngineSnapshot {
  mode: NavigationMode;
  gnss: GnssStatus;
  inference: InferenceState;
  inferenceError: string | null;
  telemetry: MlTelemetry | null;
  /** position the app is currently navigating by, whatever the source */
  position: LatLng | null;
  headingDeg: number | null;
  speedMps: number | null;
  gnssPath: LatLng[];
  drPath: LatLng[];
  outages: OutageEvent[];
  activeOutage: OutageEvent | null;
  serviceState: ServiceSessionState | null;
  lastInferenceMs: number | null;
  lastInferenceAt: number | null;
  startedAt: number | null;
  distanceM: number;
  windowFill: number;
  windowRequired: number;
  /** where the frozen model is running right now */
  backend: BackendKind | null;
  backendLabel: string | null;
  /** true when the current backend keeps working with no network */
  offlineCapable: boolean;
  /** set when 'auto' wanted on-device but had to fall back to the service */
  backendFallbackReason: string | null;
}

const EMPTY: EngineSnapshot = {
  mode: 'IDLE',
  gnss: { state: 'UNAVAILABLE', fix: null, age: 0, reason: 'Not started', satellites: null },
  inference: 'IDLE',
  inferenceError: null,
  telemetry: null,
  position: null,
  headingDeg: null,
  speedMps: null,
  gnssPath: [],
  drPath: [],
  outages: [],
  activeOutage: null,
  serviceState: null,
  lastInferenceMs: null,
  lastInferenceAt: null,
  startedAt: null,
  distanceM: 0,
  windowFill: 0,
  windowRequired: 50,
  backend: null,
  backendLabel: null,
  offlineCapable: false,
  backendFallbackReason: null,
};

export class NavigationEngine {
  readonly sensors = new SensorService();
  readonly gnss = new GnssService();

  private state: EngineSnapshot = { ...EMPTY };
  private listeners = new Set<(s: EngineSnapshot) => void>();
  private uploadTimer: ReturnType<typeof setInterval> | null = null;
  private backend: InferenceBackend | null = null;
  private mode: InferenceMode = 'auto';
  private failures = 0;
  private outageDebounce = new Debouncer();
  private navigating = false;
  private gnssSamples = 0;
  private gnssGoodSamples = 0;
  private speedSum = 0;
  private speedCount = 0;
  private maxSpeed = 0;
  private uploading = false;

  subscribe(fn: (s: EngineSnapshot) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<EngineSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  snapshot() {
    return this.state;
  }

  // ------------------------------------------------------------------ start
  /** Choose where the frozen model runs. Takes effect on the next start(). */
  setInferenceMode(mode: InferenceMode) {
    this.mode = mode;
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.navigating) return { ok: true };
    this.state = { ...EMPTY, startedAt: Date.now() };
    this.navigating = true;
    this.failures = 0;
    this.gnssSamples = 0;
    this.gnssGoodSamples = 0;
    this.speedSum = 0;
    this.speedCount = 0;
    this.maxSpeed = 0;
    this.outageDebounce.reset();

    this.gnss.onStatus = (s) => this.onGnss(s);
    this.gnss.setClockOrigin(Date.now());
    const perm = await this.gnss.start();
    const motionOk = await SensorService.requestPermission();
    this.sensors.start();

    this.set({ inference: 'WARMING' });
    try {
      const { backend, state, fallbackReason } = await resolveBackend(this.mode);
      this.backend = backend;
      this.set({
        serviceState: state,
        inference: 'WARMING',
        inferenceError: null,
        backend: backend.kind,
        backendLabel: backend.label,
        offlineCapable: backend.offlineCapable,
        backendFallbackReason: fallbackReason ?? null,
      });
    } catch (err) {
      this.backend = null;
      this.set({
        inference: 'OFFLINE',
        inferenceError: err instanceof Error ? err.message : 'No inference backend available',
        backend: null,
        backendLabel: null,
        offlineCapable: false,
      });
    }

    this.uploadTimer = setInterval(() => void this.flush(), TUNING.UPLOAD_INTERVAL_MS);
    this.recomputeMode();

    if (!motionOk) {
      return {
        ok: true,
        error:
          'Motion sensor permission denied. Dead reckoning cannot run without the IMU — ' +
          'enable Motion & Fitness for MATRIX in system settings.',
      };
    }
    if (perm !== 'granted') {
      return {
        ok: true,
        error:
          perm === 'services-off'
            ? 'Location services are turned off. Navigation will run without a GNSS position.'
            : 'Location permission denied. Navigation will run without a GNSS position.',
      };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------- GNSS
  private onGnss(status: GnssStatus) {
    this.gnssSamples += 1;
    const good = status.state === 'ACTIVE' || status.state === 'WEAK';
    if (good) this.gnssGoodSamples += 1;

    let { gnssPath, distanceM, position, headingDeg, speedMps } = this.state;
    if (good && status.fix) {
      const p = { latitude: status.fix.latitude, longitude: status.fix.longitude };
      const before = gnssPath;
      gnssPath = appendPoint(gnssPath, p);
      if (gnssPath !== before && before.length) {
        distanceM += haversineM(before[before.length - 1], p);
      }
      position = p;
      headingDeg = status.fix.bearing ?? headingDeg;
      speedMps = status.fix.speed ?? speedMps;
      if (status.fix.speed !== null) {
        this.speedSum += status.fix.speed;
        this.speedCount += 1;
        this.maxSpeed = Math.max(this.maxSpeed, status.fix.speed);
      }
    }
    this.set({ gnss: status, gnssPath, distanceM, position, headingDeg, speedMps });
    this.recomputeMode();
  }

  // -------------------------------------------------------------- inference
  private async flush() {
    if (!this.navigating || this.uploading) return;
    const batch = this.sensors.drain();
    if (!batch.length) return;
    if (!this.backend) {
      await this.reconnect();
      if (!this.backend) {
        this.sensors.requeue(batch.slice(-TUNING.MAX_POLYLINE_POINTS));
        return;
      }
    }
    this.uploading = true;
    try {
      const s = await this.backend.push(batch);
      this.failures = 0;
      this.applyServiceState(s);
    } catch (err) {
      this.failures += 1;
      const msg = err instanceof Error ? err.message : 'Inference failed';
      if (this.failures >= TUNING.FAILURES_BEFORE_OFFLINE) {
        this.set({ inference: 'OFFLINE', inferenceError: msg });
        // a 404 means the service forgot the session, so drop it and reopen
        if (err instanceof ApiError && err.status === 404) this.backend = null;
      } else {
        this.set({ inference: 'ERROR', inferenceError: msg });
      }
      this.recomputeMode();
    } finally {
      this.uploading = false;
    }
  }

  private applyServiceState(s: ServiceSessionState) {
    const patch: Partial<EngineSnapshot> = {
      serviceState: s,
      telemetry: s.telemetry,
      lastInferenceMs: s.last_inference_ms,
      lastInferenceAt: Date.now(),
      windowFill: s.buffer_fill,
      windowRequired: s.buffer_required,
      inference: s.buffer_fill >= s.buffer_required ? 'READY' : 'WARMING',
      inferenceError: null,
    };

    if (s.outage && this.state.activeOutage) {
      const p = { latitude: s.outage.latitude, longitude: s.outage.longitude };
      const drPath = appendPoint(this.state.drPath, p, 1);
      patch.drPath = drPath;
      patch.position = p;
      patch.headingDeg = s.outage.heading_deg;
      patch.speedMps = s.outage.velocity_mps;
      patch.activeOutage = {
        ...this.state.activeOutage,
        durationS: s.outage.duration_s,
        path: appendPoint(this.state.activeOutage.path, p, 1),
        estimated: p,
        drDistanceM: s.outage.distance_m,
      };
    }
    this.set(patch);
    this.recomputeMode();
  }

  private async reconnect() {
    try {
      const { backend, state, fallbackReason } = await resolveBackend(this.mode);
      this.backend = backend;
      this.failures = 0;
      this.set({
        serviceState: state,
        inference: 'WARMING',
        inferenceError: null,
        backend: backend.kind,
        backendLabel: backend.label,
        offlineCapable: backend.offlineCapable,
        backendFallbackReason: fallbackReason ?? null,
      });
    } catch {
      /* stay unavailable; the next flush retries */
    }
  }

  // ------------------------------------------------------------------ modes
  private recomputeMode() {
    const windowReady = this.state.windowFill >= this.state.windowRequired;
    const target = nextMode({
      navigating: this.navigating,
      gnss: this.state.gnss.state,
      inference: this.state.inference,
      windowReady,
    });
    if (target === this.state.mode) return;

    const leavingGnss = this.state.mode === 'GNSS' || this.state.mode === 'IDLE';
    const threshold =
      target === 'GNSS' ? TUNING.RECOVERY_CONFIRM_SAMPLES : TUNING.OUTAGE_CONFIRM_SAMPLES;
    if (!this.outageDebounce.push(target, threshold)) return;

    if (target === 'DEAD_RECKONING' && leavingGnss) void this.openOutage();
    else if (this.state.mode === 'DEAD_RECKONING' && target === 'GNSS') void this.closeOutage();
    else this.set({ mode: target });
  }

  private async openOutage() {
    const fix = this.state.gnss.fix;
    if (!fix || !this.backend) {
      this.set({ mode: 'DEGRADED' });
      return;
    }
    const anchor = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      // last known GNSS speed is the production anchor (RUN.md gap #10)
      speed_mps: Math.max(0, fix.speed ?? this.state.speedMps ?? 0),
      bearing_deg: fix.bearing ?? this.state.headingDeg ?? 0,
      timestamp_s: this.sensors.buffer.peek()?.t ?? null,
    };
    const event: OutageEvent = {
      id: `${Date.now()}`,
      startedAt: Date.now(),
      endedAt: null,
      durationS: 0,
      anchor,
      path: [{ latitude: fix.latitude, longitude: fix.longitude }],
      estimated: null,
      recovery: null,
      recoveryErrorM: null,
      headingErrorDeg: null,
      drDistanceM: 0,
      degraded: false,
    };
    try {
      const s = await this.backend.startOutage(anchor);
      this.set({
        mode: 'DEAD_RECKONING',
        activeOutage: event,
        drPath: [{ latitude: fix.latitude, longitude: fix.longitude }],
        serviceState: s,
      });
    } catch (err) {
      this.set({
        mode: 'DEGRADED',
        inference: 'ERROR',
        inferenceError: err instanceof Error ? err.message : 'Could not start dead reckoning',
      });
    }
  }

  private async closeOutage() {
    const active = this.state.activeOutage;
    const fix = this.state.gnss.fix;
    if (!active) {
      this.set({ mode: 'GNSS' });
      return;
    }
    let finished: OutageEvent = { ...active, endedAt: Date.now() };
    if (this.backend) {
      try {
        const outage = await this.backend.endOutage(fix);
        finished = {
          ...finished,
          durationS: outage.duration_s || finished.durationS,
          drDistanceM: outage.dr_distance_m || finished.drDistanceM,
          path: outage.path.length ? outage.path : finished.path,
          estimated: outage.estimated ?? finished.estimated,
          recoveryErrorM: outage.recovery_error_m,
          headingErrorDeg: outage.heading_error_deg,
          recovery: fix ? { latitude: fix.latitude, longitude: fix.longitude } : null,
        };
      } catch {
        /* keep the locally accumulated summary */
      }
    }
    this.set({
      mode: 'GNSS',
      activeOutage: null,
      outages: [...this.state.outages, finished],
    });
  }

  /** Demo/testing control: force the receiver to look dead. */
  simulateOutage(on: boolean) {
    this.gnss.setSimulatedOutage(on);
  }

  // -------------------------------------------------------------------- stop
  async stop(): Promise<NavigationSession | null> {
    if (!this.navigating) return null;
    this.navigating = false;
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    this.uploadTimer = null;
    if (this.state.activeOutage) await this.closeOutage();
    this.sensors.stop();
    this.gnss.stop();

    const backend = this.backend;
    this.backend = null;
    if (backend) void backend.close().catch(() => undefined);

    const s = this.state;
    const startedAt = s.startedAt ?? Date.now();
    const durationS = (Date.now() - startedAt) / 1000;
    const outageS = s.outages.reduce((a, o) => a + o.durationS, 0);
    const session: NavigationSession = {
      id: `sess_${startedAt}`,
      startedAt,
      endedAt: Date.now(),
      distanceM: s.distanceM + pathLengthM(s.drPath),
      durationS,
      gnssPath: s.gnssPath,
      drPath: s.drPath,
      outages: s.outages,
      gnssAvailability: this.gnssSamples ? this.gnssGoodSamples / this.gnssSamples : 0,
      totalOutageS: outageS,
      longestOutageS: s.outages.reduce((a, o) => Math.max(a, o.durationS), 0),
      avgSpeedMps: this.speedCount ? this.speedSum / this.speedCount : 0,
      maxSpeedMps: this.maxSpeed,
      windowsInferred: s.serviceState?.windows_inferred ?? 0,
      source: 'LIVE',
    };
    this.set({ ...EMPTY });
    return session;
  }
}

export const engine = new NavigationEngine();
