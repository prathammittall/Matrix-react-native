/**
 * IMU acquisition.
 *
 * The frozen model assumes EXACTLY 10 Hz, 50-sample causal windows, channel
 * order acc_xyz + gyro_xyz, acceleration in m/s^2 with gravity retained
 * (`model/preprocessing/outputs/feature_schema.json`). This service's only job
 * is to produce that stream from the phone's sensors:
 *
 *   - both sensors are polled faster than 10 Hz,
 *   - samples are emitted onto a FIXED 100 ms GRID with zero-order hold, which
 *     is how the training corpus was logged (fixed-rate logger, ZOH), and
 *   - values are converted from g to m/s^2.
 *
 * ## Why a grid and not `setInterval(..., 100)`
 *
 * A JavaScript timer is not a clock. Under load React Native fires a 100 ms
 * interval every 105-130 ms, and the drift accumulates: over the 49 intervals
 * of one frozen window a mean period of 110 ms produces a 5.39 s span against
 * the nominal 4.90 s. `OnDeviceInference.ingest` rejects any window whose span
 * differs from nominal by 10 % or more, so with a drifting timer EVERY window
 * was rejected, `windows_inferred` stayed at 0, and dead reckoning produced no
 * motion at all — the outage clock and distance sat at zero while the app
 * claimed the AI was active.
 *
 * The emitter therefore owns a grid: sample `n` is stamped `t = n * 0.1`
 * exactly and is due at `t0 + n * 100 ms`. The timer runs faster than the grid
 * and emits every grid point that has come due, so timer jitter changes *when*
 * a sample is written, never the timeline it is written onto. A real gap (the
 * app was backgrounded, the sensors stalled) is larger than `MAX_CATCHUP` and
 * resynchronises the grid instead of fabricating history — which the window
 * contiguity check then correctly rejects, because that data really is missing.
 *
 * No filtering, no gravity removal, no bias correction is applied. The frozen
 * pipeline applies a per-dataset stationary bias only where one was estimated
 * and zero otherwise (18 of 45 training sessions had none), so a live phone with
 * no stationary calibration is handled exactly as those sessions were.
 *
 * Samples are written into a ring buffer by a timer, NOT into React state, so a
 * 10 Hz stream costs zero re-renders. The UI reads a throttled snapshot.
 */
import type { EventSubscription } from 'expo-modules-core';
import { Accelerometer, Gyroscope } from 'expo-sensors';

import { FROZEN, G } from './config';
import type { SensorSample } from '@/types';

export interface SensorAvailability {
  accelerometer: boolean;
  gyroscope: boolean;
}

export interface SensorSnapshot {
  acc: { x: number; y: number; z: number };
  gyro: { x: number; y: number; z: number };
  /** samples emitted since start() */
  count: number;
  /** measured emit rate over the last second, Hz */
  rateHz: number;
  running: boolean;
  /** grid resynchronisations caused by a stall (backgrounding, sensor pause) */
  gaps: number;
  /** ms the emitter is currently behind its grid — health of the 10 Hz stream */
  lagMs: number;
}

/** Fixed-capacity ring buffer of IMU samples. */
export class SampleBuffer {
  private buf: SensorSample[];
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array<SensorSample>(capacity);
  }

  push(s: SensorSample) {
    this.buf[this.head] = s;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  get length() {
    return this.size;
  }

  /** Oldest-to-newest copy. */
  toArray(): SensorSample[] {
    const out: SensorSample[] = [];
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i += 1) out.push(this.buf[(start + i) % this.capacity]);
    return out;
  }

  /** The most recent `n` samples, oldest-to-newest. */
  last(n: number): SensorSample[] {
    const take = Math.min(n, this.size);
    const out: SensorSample[] = [];
    for (let i = take; i > 0; i -= 1) {
      out.push(this.buf[(this.head - i + this.capacity) % this.capacity]);
    }
    return out;
  }

  peek(): SensorSample | null {
    return this.size === 0 ? null : this.buf[(this.head - 1 + this.capacity) % this.capacity];
  }

  clear() {
    this.head = 0;
    this.size = 0;
  }
}

export class SensorService {
  /** The frozen window (50) plus the longest supported outage (300 s at 10 Hz),
   *  with slack — so the whole of a worst-case outage is still in memory. */
  readonly buffer = new SampleBuffer(FROZEN.WINDOW_SAMPLES + 300 * FROZEN.SAMPLE_RATE_HZ + 256);
  /** samples not yet handed to the inference service */
  private pending: SensorSample[] = [];

  private accSub: EventSubscription | null = null;
  private gyroSub: EventSubscription | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private acc = { x: 0, y: 0, z: 0 };
  private gyro = { x: 0, y: 0, z: 0 };
  private accSeen = false;
  private gyroSeen = false;

  private t0 = 0;
  private count = 0;
  private rateWindow: number[] = [];
  running = false;

  /** index of the next grid point to emit, counted from the current origin */
  private gridIndex = 0;
  /** value of `t` at grid index 0 — advances only across a resynchronisation */
  private gridOriginS = 0;
  private gaps = 0;
  private lagMs = 0;

  /** How many grid points one tick may back-fill before the stream is declared
   *  broken and the grid resynchronises. 1.5 s of hold is still honest ZOH; a
   *  longer hold would be inventing vehicle motion that was never measured. */
  private static readonly MAX_CATCHUP = 15;

  static async availability(): Promise<SensorAvailability> {
    const [accelerometer, gyroscope] = await Promise.all([
      Accelerometer.isAvailableAsync().catch(() => false),
      Gyroscope.isAvailableAsync().catch(() => false),
    ]);
    return { accelerometer, gyroscope };
  }

  /** iOS gates motion sensors behind a permission; Android grants them implicitly. */
  static async requestPermission(): Promise<boolean> {
    try {
      const [acc, gyro] = await Promise.all([
        Accelerometer.requestPermissionsAsync(),
        Gyroscope.requestPermissionsAsync(),
      ]);
      return acc.granted && gyro.granted;
    } catch {
      // platforms where the sensors need no permission resolve here
      return true;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.t0 = Date.now();
    this.count = 0;
    this.rateWindow = [];
    this.buffer.clear();
    this.pending = [];
    this.gridIndex = 0;
    this.gridOriginS = 0;
    this.gaps = 0;
    this.lagMs = 0;

    // poll faster than the emit rate so each 100 ms tick has a fresh reading
    const pollMs = Math.floor(FROZEN.SAMPLE_INTERVAL_MS / 2);
    Accelerometer.setUpdateInterval(pollMs);
    Gyroscope.setUpdateInterval(pollMs);

    this.accSub = Accelerometer.addListener(({ x, y, z }) => {
      this.acc = { x, y, z };
      this.accSeen = true;
    });
    this.gyroSub = Gyroscope.addListener(({ x, y, z }) => {
      this.gyro = { x, y, z };
      this.gyroSeen = true;
    });

    // tick faster than the grid so a late tick has spare capacity to catch up
    this.timer = setInterval(() => this.tick(Date.now()), pollMs);
  }

  /** Emit every grid point that is due at `now`. Exposed for tests. */
  tick(now: number) {
    if (!this.accSeen || !this.gyroSeen) {
      // Nothing has been measured yet, so nothing is due yet either: hold the
      // grid at the present instant instead of accruing a debt of empty
      // samples that would be back-filled the moment the first reading lands.
      this.t0 = now;
      return;
    }

    const due = Math.floor((now - this.t0) / FROZEN.SAMPLE_INTERVAL_MS) + 1 - this.gridIndex;
    if (due <= 0) return;

    if (due > SensorService.MAX_CATCHUP) {
      // The stream stalled. Resynchronise: keep `t` monotonic by advancing the
      // origin over the real elapsed time, so the gap is visible in the
      // timestamps and the affected windows are rejected rather than silently
      // stitched across missing motion.
      this.gridOriginS += (now - this.t0) / 1000;
      this.t0 = now;
      this.gridIndex = 0;
      this.gaps += 1;
      this.lagMs = 0;
      this.emitGridPoint(now);
      return;
    }

    for (let i = 0; i < due; i += 1) this.emitGridPoint(now);
    this.lagMs = Math.max(0, now - this.t0 - (this.gridIndex - 1) * FROZEN.SAMPLE_INTERVAL_MS);
  }

  private emitGridPoint(now: number) {
    const sample: SensorSample = {
      // exactly on the grid — this is what makes a window's span exactly
      // (WINDOW-1) * dt and keeps it inside the frozen contiguity tolerance
      t: Number(
        (this.gridOriginS + (this.gridIndex * FROZEN.SAMPLE_INTERVAL_MS) / 1000).toFixed(3),
      ),
      // expo-sensors reports acceleration in g; the frozen model expects m/s^2
      acc_x: this.acc.x * G,
      acc_y: this.acc.y * G,
      acc_z: this.acc.z * G,
      // gyroscope is already rad/s
      gyro_x: this.gyro.x,
      gyro_y: this.gyro.y,
      gyro_z: this.gyro.z,
    };
    this.gridIndex += 1;
    this.buffer.push(sample);
    this.pending.push(sample);
    this.count += 1;
    this.rateWindow.push(now);
    while (this.rateWindow.length && now - this.rateWindow[0] > 1000) this.rateWindow.shift();
  }

  /** Take everything collected since the last drain. */
  drain(): SensorSample[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Put a batch back at the front after a failed upload, so nothing is lost. */
  requeue(samples: SensorSample[]) {
    if (samples.length) this.pending = samples.concat(this.pending);
  }

  get pendingCount() {
    return this.pending.length;
  }

  snapshot(): SensorSnapshot {
    return {
      acc: { ...this.acc },
      gyro: { ...this.gyro },
      count: this.count,
      rateHz: this.rateWindow.length,
      running: this.running,
      gaps: this.gaps,
      lagMs: Math.round(this.lagMs),
    };
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.accSub?.remove();
    this.gyroSub?.remove();
    this.accSub = null;
    this.gyroSub = null;
  }
}
