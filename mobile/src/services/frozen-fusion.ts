/**
 * On-device port of the FROZEN fusion and dead-reckoning maths.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  DO NOT EDIT THE MATHEMATICS IN THIS FILE.
 *
 *  These four functions are a line-for-line transcription of the frozen
 *  implementation in
 *      model/experiments/complementary_fusion/phase2_4_fusion_select.py
 *  They exist only so that dead reckoning can run with no network. They are
 *  held to the Python original by `__tests__/frozen-fusion.test.ts`, which
 *  replays golden vectors generated from the frozen functions themselves
 *  (`backend/tools/export_fusion_golden.py`). Any change to the arithmetic
 *  here turns that test red.
 *
 *  When the inference service IS reachable the app uses it instead, and the
 *  service calls the Python originals directly. This file is the offline path.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The frozen reference, for comparison:
 *
 *     def v_abs_anchored(va, v0):
 *         return np.maximum(va - (va[0] - v0), 0.0)
 *
 *     def complementary(dv, va_anch, v0, tau):
 *         inc = dv / K
 *         g   = DT / tau
 *         v[0] = v0
 *         for t in range(1, n):
 *             v[t] = (1.0 - g) * (v[t - 1] + inc[t]) + g * va_anch[t]
 *         return np.maximum(v, 0.0)
 *
 *     def dead_reckon(v, yaw, dt=DT):
 *         h  = np.cumsum(yaw * dt)
 *         hm = np.concatenate([[0.0], h[:-1]]) + yaw * dt / 2.0
 *         return np.cumsum(v * np.cos(hm) * dt), np.cumsum(v * np.sin(hm) * dt), h
 */

/** k = 5 and dt = 0.1 s are frozen; see frozen_runtime.json, written by the export. */
export interface FusionConstants {
  k: number;
  dt: number;
  tau: number;
}

/** Frozen: `np.maximum(va - (va[0] - v0), 0.0)`. */
export function vAbsAnchored(va: Float64Array | number[], v0: number): Float64Array {
  const n = va.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const offset = va[0] - v0;
  for (let i = 0; i < n; i += 1) {
    const x = va[i] - offset;
    out[i] = x > 0 ? x : 0;
  }
  return out;
}

/**
 * Frozen complementary filter.
 *
 * `v[t] = (1 - dt/tau) * (v[t-1] + dv[t]/k) + (dt/tau) * va_anch[t]`, floored at 0.
 * Note the floor is applied to the whole series at the end, exactly as the
 * frozen `np.maximum(v, 0.0)` does — NOT inside the recursion, which would be a
 * different filter.
 */
export function complementary(
  dv: Float64Array | number[],
  vaAnchored: Float64Array | number[],
  v0: number,
  { k, dt, tau }: FusionConstants,
): Float64Array {
  const n = dv.length;
  const v = new Float64Array(n);
  if (n === 0) return v;
  const g = dt / tau;
  v[0] = v0;
  for (let t = 1; t < n; t += 1) {
    const prop = v[t - 1] + dv[t] / k;
    v[t] = (1.0 - g) * prop + g * vaAnchored[t];
  }
  for (let t = 0; t < n; t += 1) if (v[t] < 0) v[t] = 0;
  return v;
}

export interface DeadReckoned {
  /** local metres along the anchor heading */
  x: Float64Array;
  /** local metres to the left of it */
  y: Float64Array;
  /** cumulative heading in radians, counter-clockwise from the anchor */
  h: Float64Array;
}

/** Frozen dead reckoning: cumulative heading, midpoint rule, cumulative position. */
export function deadReckon(
  v: Float64Array | number[],
  yaw: Float64Array | number[],
  dt: number,
): DeadReckoned {
  const n = v.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const h = new Float64Array(n);
  let hAcc = 0;
  let xAcc = 0;
  let yAcc = 0;
  let hPrev = 0; // h[t-1], and 0.0 for the first sample — matches the frozen concat
  for (let t = 0; t < n; t += 1) {
    hAcc += yaw[t] * dt;
    h[t] = hAcc;
    const hm = hPrev + (yaw[t] * dt) / 2.0;
    xAcc += v[t] * Math.cos(hm) * dt;
    yAcc += v[t] * Math.sin(hm) * dt;
    x[t] = xAcc;
    y[t] = yAcc;
    hPrev = hAcc;
  }
  return { x, y, h };
}

/** The whole frozen velocity + position pipeline for one outage. */
export function fuseAndDeadReckon(
  dv: Float64Array | number[],
  va: Float64Array | number[],
  yaw: Float64Array | number[],
  v0: number,
  constants: FusionConstants,
): DeadReckoned & { v: Float64Array; vaAnchored: Float64Array } {
  const vaAnchored = vAbsAnchored(va, v0);
  const v = complementary(dv, vaAnchored, v0, constants);
  return { v, vaAnchored, ...deadReckon(v, yaw, constants.dt) };
}
