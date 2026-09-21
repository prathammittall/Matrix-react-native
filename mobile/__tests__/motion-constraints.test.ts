/**
 * Motion constraints.
 *
 * Two properties matter more than any accuracy figure:
 *
 *   1. with constraints disabled the output is bit-identical to the frozen
 *      pipeline, so the benchmark numbers remain measurable; and
 *   2. the stationarity detector under-detects rather than over-detects,
 *      because a false ZUPT freezes the position while the vehicle is moving
 *      and dead reckoning has no way to ever notice.
 */
import { FROZEN } from '@/services/config';
import { deadReckon } from '@/services/frozen-fusion';
import {
  applyMotionConstraints,
  isStationaryWindow,
  ZUPT,
} from '@/services/motion-constraints';

const G = 9.80665;
const N = FROZEN.WINDOW_SAMPLES;

/** A flat window: constant acceleration magnitude `g + drift`, gyro at `rate`. */
function window({
  accNoise = 0,
  gyro = 0,
  accOffset = 0,
  samples = N,
}: {
  accNoise?: number;
  gyro?: number;
  accOffset?: number;
  samples?: number;
} = {}) {
  const out: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    // alternating sign so the mean is unchanged and the variance is accNoise²
    const n = i % 2 === 0 ? accNoise : -accNoise;
    out.push(0, 0, G + accOffset + n, gyro, 0, 0);
  }
  return out;
}

describe('isStationaryWindow', () => {
  it('detects a phone sitting perfectly still', () => {
    expect(isStationaryWindow(window())).toBe(true);
  });

  it('tolerates the vibration of a car at idle', () => {
    // variance well inside the threshold
    const noise = Math.sqrt(ZUPT.ACC_VARIANCE_MAX) * 0.5;
    expect(isStationaryWindow(window({ accNoise: noise }))).toBe(true);
  });

  it('rejects a window with real longitudinal motion', () => {
    const noise = Math.sqrt(ZUPT.ACC_VARIANCE_MAX) * 2;
    expect(isStationaryWindow(window({ accNoise: noise }))).toBe(false);
  });

  it('rejects a window with any real turn rate', () => {
    expect(isStationaryWindow(window({ gyro: ZUPT.GYRO_MEAN_MAX * 2 }))).toBe(false);
    // 10 deg/s is an ordinary gentle corner and must never read as stationary
    expect(isStationaryWindow(window({ gyro: 0.175 }))).toBe(false);
  });

  it('rejects a steady but non-gravitational acceleration magnitude', () => {
    // perfectly steady, zero variance, zero rotation — but not at g, so the
    // phone is not resting in a gravity field and this is not a stopped car
    expect(isStationaryWindow(window({ accOffset: 2 }))).toBe(false);
  });

  it('is orientation-free — the same still phone, mounted differently', () => {
    const tilted: number[] = [];
    const c = G / Math.sqrt(3);
    for (let i = 0; i < N; i += 1) tilted.push(c, c, c, 0, 0, 0);
    expect(isStationaryWindow(tilted)).toBe(true);
  });

  it('returns false for an empty window rather than claiming stationarity', () => {
    expect(isStationaryWindow([])).toBe(false);
  });
});

describe('applyMotionConstraints', () => {
  const v = [10, 10, 10, 0.4, 0.3, 0.35, 0.3, 9, 10];
  const yaw = [0.2, 0.2, 0.2, 0.01, 0.01, 0.01, 0.01, 0.2, 0.2];
  const moving = v.map(() => false);
  const stopped = [false, false, false, true, true, true, true, false, false];

  it('returns its inputs untouched when disabled', () => {
    const r = applyMotionConstraints(v, yaw, stopped, false);
    expect([...r.v]).toEqual(v);
    expect([...r.yaw]).toEqual(yaw);
    expect(r.zuptSamples).toBe(0);
    expect(r.yawBias).toBe(0);
  });

  it('disabled output re-integrates to exactly the frozen track', () => {
    const frozen = deadReckon(v, yaw, FROZEN.SAMPLE_INTERVAL_MS / 1000);
    const r = applyMotionConstraints(v, yaw, stopped, false);
    const after = deadReckon(r.v, r.yaw, FROZEN.SAMPLE_INTERVAL_MS / 1000);
    expect([...after.x]).toEqual([...frozen.x]);
    expect([...after.y]).toEqual([...frozen.y]);
    expect([...after.h]).toEqual([...frozen.h]);
  });

  it('clamps velocity and turn rate to zero while stationary', () => {
    const r = applyMotionConstraints(v, yaw, stopped);
    expect(r.zuptSamples).toBe(4);
    for (let i = 0; i < v.length; i += 1) {
      if (stopped[i]) {
        expect(r.v[i]).toBe(0);
        expect(r.yaw[i]).toBe(0);
      } else {
        expect(r.v[i]).toBe(v[i]);
      }
    }
  });

  it('removes no distance when the vehicle never stops', () => {
    const r = applyMotionConstraints(v, yaw, moving);
    expect([...r.v]).toEqual(v);
    expect(r.zuptSamples).toBe(0);
  });

  it('stops position accumulating through a stop — the point of ZUPT', () => {
    const dt = FROZEN.SAMPLE_INTERVAL_MS / 1000;
    // 30 s stopped with the model still reporting a 0.4 m/s creep
    const n = 300;
    const creeping = new Array(n).fill(0.4);
    const flat = new Array(n).fill(0);
    const still = new Array(n).fill(true);

    const uncorrected = deadReckon(creeping, flat, dt);
    const r = applyMotionConstraints(creeping, flat, still);
    const corrected = deadReckon(r.v, r.yaw, dt);

    // 0.4 m/s for 30 s is 12 m of distance that was never travelled
    expect(uncorrected.x[n - 1]).toBeCloseTo(12, 1);
    expect(corrected.x[n - 1]).toBe(0);
  });

  it('estimates and removes the yaw-rate bias seen while stopped', () => {
    const bias = 0.01; // rad/s ~ 0.57 deg/s
    const n = 200;
    const stationary = new Array(n).fill(false);
    for (let i = 0; i < 100; i += 1) stationary[i] = true;
    const rates = new Array(n).fill(0).map((_, i) => (stationary[i] ? bias : 0.1 + bias));

    const r = applyMotionConstraints(new Array(n).fill(5), rates, stationary);
    expect(r.yawBias).toBeCloseTo(bias, 9);
    // moving samples keep their true turn rate, with the bias taken out
    expect(r.yaw[150]).toBeCloseTo(0.1, 9);
  });

  it('will not estimate a bias from a handful of samples', () => {
    const n = 40;
    const stationary = new Array(n).fill(false);
    for (let i = 0; i < ZUPT.MIN_SAMPLES_FOR_BIAS - 1; i += 1) stationary[i] = true;
    const r = applyMotionConstraints(
      new Array(n).fill(5),
      new Array(n).fill(0.02),
      stationary,
    );
    expect(r.yawBias).toBe(0);
  });

  it('rejects an implausibly large bias — that means the detector was wrong', () => {
    const n = 100;
    const stationary = new Array(n).fill(true);
    const wild = ZUPT.MAX_YAW_BIAS * 10;
    const r = applyMotionConstraints(new Array(n).fill(0), new Array(n).fill(wild), stationary);
    expect(r.yawBias).toBe(0);
  });

  it('never mutates its inputs', () => {
    const vIn = [...v];
    const yawIn = [...yaw];
    applyMotionConstraints(vIn, yawIn, stopped);
    expect(vIn).toEqual(v);
    expect(yawIn).toEqual(yaw);
  });
});
