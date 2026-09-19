/**
 * IMU acquisition.
 *
 * The frozen model assumes EXACTLY 10 Hz, 50-sample causal windows, channel
 * order acc_xyz + gyro_xyz, acceleration in m/s^2 with gravity retained
 * (`model/preprocessing/outputs/feature_schema.json`). This service's only job
 * is to produce that stream from the phone's sensors:
 *
 *   - both sensors are polled faster than 10 Hz,
 *   - a fixed 100 ms timer emits one sample built from the most recent reading
 *     of each, which is how the training corpus was logged (fixed-rate logger,
 *     zero-order hold), and
 *   - values are converted from g to m/s^2.
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

    this.timer = setInterval(() => this.emit(), FROZEN.SAMPLE_INTERVAL_MS);
  }

  private emit() {
    if (!this.accSeen || !this.gyroSeen) return; // wait for both sensors to report once
    const now = Date.now();
    const sample: SensorSample = {
      t: Number(((now - this.t0) / 1000).toFixed(3)),
      // expo-sensors reports acceleration in g; the frozen model expects m/s^2
      acc_x: this.acc.x * G,
      acc_y: this.acc.y * G,
      acc_z: this.acc.z * G,
      // gyroscope is already rad/s
      gyro_x: this.gyro.x,
      gyro_y: this.gyro.y,
      gyro_z: this.gyro.z,
    };
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
