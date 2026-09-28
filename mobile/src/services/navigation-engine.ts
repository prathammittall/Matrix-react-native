/**
 * Navigation orchestration.
 *
 * This is the only place that decides which position source the app is using.
 * It consumes the GNSS sensor layer and the ML inference layer and produces a
 * single NavigationMode plus the tracks the map draws.
 *
 *   no fix yet                       -> ACQUIRING      (not an outage)
 *   GNSS ACTIVE/WEAK                 -> GNSS
 *   GNSS lost + anchor + inference   -> DEAD_RECKONING
 *   GNSS lost, anything else missing -> DEGRADED       (last position held)
 *
 * It never computes a dead-reckoned position itself. Position during an outage
 * comes from an InferenceBackend running the frozen model - either on-device
 * (ONNX Runtime, works with no network) or the inference service. Both produce
 * the same numbers. If neither can answer, the mode is DEGRADED: the app holds
 * the last position it could justify and labels it as held, rather than either
 * claiming a fix it does not have or blanking the map.
 *
 * Two rules keep the mode honest, and both are about TIME:
 *   1. every transition must hold continuously for a wall-clock interval
 *      (`ConfirmationGate`) before it is adopted, so receiver noise cannot
 *      flip the app into dead reckoning;
 *   2. a heartbeat re-evaluates and republishes at `TUNING.HEARTBEAT_MS`, so
 *      staleness is measured against the clock rather than against the arrival
 *      of the next fix — which, during an outage, never comes.
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
import { onDevice } from './ondevice-inference';
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
  /** true when a previous GNSS fix exists to dead-reckon from */
  hasAnchor: boolean;
}

/** The mode-selection rule, isolated so it can be tested exhaustively. */
export function nextMode({
  navigating,
  gnss,
  inference,
  windowReady,
  hasAnchor,
}: ModeInput): NavigationMode {
  if (!navigating) return 'IDLE';
  if (gnss === 'ACTIVE' || gnss === 'WEAK') return 'GNSS';
  // "Still looking for the first fix" is its own state. Treating it as an
  // outage meant the app announced GNSS LOST before it had ever been found,
  // and then fell straight to DEGRADED because dead reckoning has no anchor to
  // start from. The driver saw "position unavailable" seconds after Start.
  if (gnss === 'ACQUIRING') return 'ACQUIRING';
  // GNSS is OUTAGE or UNAVAILABLE from here on.
  // Dead reckoning needs somewhere to reckon FROM, so without a previous fix
  // there is no honest estimate to offer.
  if (!hasAnchor) return 'DEGRADED';
  if (inference === 'READY' && windowReady) return 'DEAD_RECKONING';
  return 'DEGRADED';
}

/**
 * Is the inference backend actually producing, or only warmed up?
 *
 * `windows_inferred > 0` is proof the frozen model has run at least once on THIS
 * session. Raw buffer fill only says the 50-sample ring holds 50 entries — and
 * on a real device sample timestamps can drift enough that every window fails
 * the frozen 10 Hz contiguity check (see `rejected_windows`). Gating readiness
 * on buffer fill let that broken case look identical to a healthy one: the mode
 * flipped to DEAD_RECKONING and stayed there reporting a frozen position with
 * zero real inferences behind it. Merged from the parallel `main` line, where
 * this was found independently; it complements the fixed-grid emitter in
 * `sensors.ts`, which removes the drift that caused the rejections.
 */
export function isInferenceReady(windowsInferred: number): boolean {
  return windowsInferred > 0;
}

/**
 * Confirmation gate, measured in SECONDS.
 *
 * The previous implementation counted consecutive agreeing readings. That is
 * only meaningful if one caller pushes at one rate, and two did: a GNSS fix and
 * an inference reply arriving 50 ms apart satisfied a two-sample threshold, so
 * a single spurious reading flipped the app into dead reckoning. Real-world
 * receivers produce spurious readings constantly, which is exactly the
 * "GNSS lost out of nowhere" behaviour.
 *
 * Holding a candidate for a wall-clock duration is independent of how often it
 * is evaluated, so the guarantee is the one that was actually wanted: the new
 * state must be true continuously for N seconds.
 */
export class ConfirmationGate {
  private candidate: string | null = null;
  private since = 0;

  /** True once `value` has held continuously for `holdS` seconds. */
  push(value: string, holdS: number, now: number): boolean {
    if (value !== this.candidate) {
      this.candidate = value;
      this.since = now;
    }
    return now - this.since >= holdS * 1000;
  }

  /** Adopt `value` immediately on the next push — for explicit user actions. */
  force(value: string) {
    this.candidate = value;
    this.since = Number.NEGATIVE_INFINITY;
  }

  reset() {
    this.candidate = null;
    this.since = 0;
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
  /** seconds since start(), maintained by the engine heartbeat.
   *  Screens used to compute this from `Date.now()` at render time, which
   *  froze the whole drive on whatever value the last engine emission
   *  happened to land on. A clock has to be driven by a clock. */
  elapsedS: number;
  /** seconds the current outage has been running, by the device clock. The
   *  model's own `duration_s` counts INFERRED WINDOWS, so it reads 00:00 for
   *  as long as inference is not yet producing — true, but useless as the
   *  "how long have we been on the AI" readout. */
  outageElapsedS: number;
  /** last position the app could justify, kept across DEGRADED so the map
   *  never blanks out. `position` is null when nothing is trustworthy;
   *  this is the breadcrumb, always labelled as stale in the UI. */
  lastKnown: LatLng | null;
  lastKnownAt: number | null;
  /** seconds since `lastKnown` was established — how stale the held position is */
  heldS: number;
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
  elapsedS: 0,
  outageElapsedS: 0,
  lastKnown: null,
  lastKnownAt: null,
  heldS: 0,
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private backend: InferenceBackend | null = null;
  private mode: InferenceMode = 'auto';
  private failures = 0;
  private modeGate = new ConfirmationGate();
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

  /** Enable ZUPT and yaw-bias removal on the frozen pipeline's output.
   *  Takes effect on the next outage. See `motion-constraints.ts`. */
  setMotionConstraints(on: boolean) {
    onDevice.constraintsEnabled = on;
  }

  /** Snap the dead-reckoned path onto the offline road graph during an outage.
   *  Takes effect on the next outage. See `map-matching.ts`. */
  setMapMatching(on: boolean) {
    onDevice.mapMatchingEnabled = on;
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
    this.modeGate.reset();

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
    this.heartbeatTimer = setInterval(() => this.heartbeat(), TUNING.HEARTBEAT_MS);
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

  // -------------------------------------------------------------- heartbeat
  /**
   * The engine's own tick.
   *
   * Everything used to be event-driven off a GNSS fix or an inference reply,
   * which is why the app appeared to freeze the moment either stopped arriving:
   * the elapsed clock stopped, the outage clock stopped, and a receiver that
   * had silently died still looked healthy because nobody re-read its age.
   * One timer removes all three failure modes.
   */
  private heartbeat() {
    if (!this.navigating) return;
    const now = Date.now();
    const s = this.state;
    this.set({
      elapsedS: s.startedAt ? (now - s.startedAt) / 1000 : 0,
      outageElapsedS: s.activeOutage ? (now - s.activeOutage.startedAt) / 1000 : 0,
      heldS: s.lastKnownAt ? (now - s.lastKnownAt) / 1000 : 0,
      // re-read the receiver so staleness is evaluated against the clock
      gnss: this.gnss.status(),
    });
    this.recomputeMode();
  }

  // ------------------------------------------------------------------- GNSS
  private onGnss(status: GnssStatus) {
    this.gnssSamples += 1;
    const good = status.state === 'ACTIVE' || status.state === 'WEAK';
    if (good) this.gnssGoodSamples += 1;

    let { gnssPath, distanceM, position, headingDeg, speedMps, lastKnown, lastKnownAt } =
      this.state;
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
      lastKnown = p;
      lastKnownAt = Date.now();
      if (status.fix.speed !== null) {
        this.speedSum += status.fix.speed;
        this.speedCount += 1;
        this.maxSpeed = Math.max(this.maxSpeed, status.fix.speed);
      }
    }
    this.set({
      gnss: status,
      gnssPath,
      distanceM,
      position,
      headingDeg,
      speedMps,
      lastKnown,
      lastKnownAt,
    });
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
      patch.lastKnown = p;
      patch.lastKnownAt = Date.now();
      patch.headingDeg = s.outage.heading_deg;
      patch.speedMps = s.outage.velocity_mps;
      patch.activeOutage = {
        ...this.state.activeOutage,
        // Wall-clock, not the model's inferred-window count. The two agree once
        // inference is flowing; only the wall clock is right before it is.
        durationS: (Date.now() - this.state.activeOutage.startedAt) / 1000,
        inferredS: s.outage.duration_s,
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
    // Readiness is "the model has actually produced", not "the buffer is full":
    // a full buffer whose windows are all rejected on timing must NOT count.
    const windowReady = isInferenceReady(this.state.serviceState?.windows_inferred ?? 0);
    const target = nextMode({
      navigating: this.navigating,
      gnss: this.state.gnss.state,
      inference: this.state.inference,
      windowReady,
      hasAnchor: this.state.gnss.fix !== null,
    });
    if (target === this.state.mode) {
      this.modeGate.reset();
      return;
    }

    // Leaving a good GNSS position is the expensive, user-visible transition,
    // so it is the one that has to be certain. Coming back is cheap: a real fix
    // is better than an estimate, so trust it sooner.
    const holdS =
      target === 'GNSS' || target === 'ACQUIRING'
        ? TUNING.RECOVERY_CONFIRM_S
        : TUNING.OUTAGE_CONFIRM_S;
    if (!this.modeGate.push(target, holdS, Date.now())) return;
    this.modeGate.reset();

    const gnssBack = target === 'GNSS';
    if (target === 'DEAD_RECKONING' && this.state.mode !== 'DEAD_RECKONING') {
      void this.openOutage();
    } else if (this.state.activeOutage && gnssBack) {
      void this.closeOutage();
    } else if (this.state.activeOutage && target === 'DEGRADED') {
      // Inference stumbled mid-outage but GNSS is still gone. Do NOT end the
      // outage: it is one continuous event, and closing it would throw away
      // the anchor and the track so far. Mark it degraded and keep the record.
      this.set({
        mode: 'DEGRADED',
        activeOutage: { ...this.state.activeOutage, degraded: true },
      });
    } else {
      this.set({ mode: target });
    }
  }

  /** Skip the confirmation delay for a transition the user asked for. */
  private forceMode(target: NavigationMode) {
    this.modeGate.force(target);
    this.recomputeMode();
  }

  private async openOutage() {
    // Resuming after a mid-outage inference stumble: the backend still holds
    // the outage, so re-opening it would throw and drop the driver back to
    // DEGRADED for good.
    if (this.state.activeOutage) {
      this.set({ mode: 'DEAD_RECKONING' });
      return;
    }
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
      inferredS: 0,
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
    const endedAt = Date.now();
    let finished: OutageEvent = {
      ...active,
      endedAt,
      durationS: (endedAt - active.startedAt) / 1000,
    };
    if (this.backend) {
      try {
        const outage = await this.backend.endOutage(fix);
        finished = {
          ...finished,
          inferredS: outage.duration_s || finished.inferredS,
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
      outageElapsedS: 0,
      outages: [...this.state.outages, finished],
    });
  }

  /** Demo/testing control: force the receiver to look dead.
   *  The confirmation delay exists to reject receiver noise; the user pressing
   *  a button is not noise, so this transition is immediate. */
  simulateOutage(on: boolean) {
    this.gnss.setSimulatedOutage(on);
    this.set({ gnss: this.gnss.status() });
    const windowReady = isInferenceReady(this.state.serviceState?.windows_inferred ?? 0);
    this.forceMode(
      nextMode({
        navigating: this.navigating,
        gnss: this.state.gnss.state,
        inference: this.state.inference,
        windowReady,
        hasAnchor: this.state.gnss.fix !== null,
      }),
    );
  }

  // -------------------------------------------------------------------- stop
  async stop(): Promise<NavigationSession | null> {
    if (!this.navigating) return null;
    this.navigating = false;
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    this.uploadTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
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
