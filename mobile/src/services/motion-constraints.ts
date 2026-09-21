/**
 * Motion constraints — free information the frozen model does not use.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  This module is OUTSIDE the frozen boundary and must stay there.
 *
 *  It never touches the weights, the scaler, the feature order, τ, k, or the
 *  complementary filter. It takes the frozen pipeline's OUTPUT — a velocity
 *  series and a yaw-rate series — and applies two constraints that are true of
 *  road vehicles and were not available to the model at training time. The
 *  frozen pipeline is then re-integrated with the constrained series through
 *  the same frozen `deadReckon`.
 *
 *  Turning `enabled` off reproduces the frozen behaviour exactly, sample for
 *  sample. That is deliberate: the unconstrained result must remain
 *  demonstrable, because it is what the reported benchmark figures measure.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ## Why this exists
 *
 * Dead reckoning's error is dominated by two things. Velocity error integrates
 * into position linearly. Heading error integrates into position as an arc, and
 * past roughly 300 s it dominates everything else. Both have a cheap partial
 * remedy that needs no extra sensor and no retraining.
 *
 * ### 1. Zero-velocity update (ZUPT)
 *
 * A vehicle that is stopped is producing an IMU signal that is unmistakably
 * stationary: acceleration magnitude sits at g with tiny variance, and angular
 * rate is at the gyro's noise floor. During those samples the model's velocity
 * estimate is not just wrong, it is wrong in a way that accumulates — every
 * second at a red light in a tunnel is a second of invented distance. Clamping
 * velocity to zero when the vehicle is provably stationary removes that
 * entirely. This is the oldest and most reliable trick in inertial navigation.
 *
 * ### 2. ZUPT-aided yaw-rate bias estimation
 *
 * The same stationary samples are a direct measurement of the yaw-rate
 * estimate's bias: a stopped vehicle is not turning, so whatever non-zero yaw
 * rate is being reported during those samples *is* the bias. Subtracting it
 * from the whole outage attacks heading drift at its source, which is the
 * error term that dominates long outages.
 *
 * ### What about non-holonomic constraints?
 *
 * AI-IMU Dead-Reckoning (Brossard et al., arXiv:1904.06064) gets much of its
 * accuracy from NHC: a wheeled vehicle has ~zero lateral and vertical velocity
 * in its own body frame, which is free information at every timestep.
 *
 * MATRIX gets that for free and cannot do otherwise. The frozen `deadReckon`
 * advances strictly along the current heading — `x += v·cos(h)·dt`,
 * `y += v·sin(h)·dt` — with no lateral velocity state to constrain. The
 * constraint is structural in the formulation rather than enforced by a filter.
 * Implementing it explicitly here would be a no-op, so it is not implemented;
 * it is recorded instead, so nobody adds a no-op later believing it does
 * something. The NHC idea only becomes actionable if MATRIX ever moves to a
 * full 3-D filter with a velocity vector — see RESEARCH.md §4.
 *
 * ## The failure mode this guards against
 *
 * A false-positive ZUPT is worse than no ZUPT: it freezes the position while
 * the vehicle is actually crawling, and the error never recovers because dead
 * reckoning has no way to notice. Every threshold here is therefore set to
 * under-detect. A missed stationary period costs a little accuracy; a
 * fabricated one costs correctness.
 */

/** Stationarity thresholds, deliberately conservative. */
export const ZUPT = {
  /** variance of |acceleration| over one window, (m/s²)². A phone in a car at
   *  idle sees engine and HVAC vibration, so this cannot be near zero — but a
   *  vehicle under way is far above it. */
  ACC_VARIANCE_MAX: 0.04,
  /** mean |angular rate| over one window, rad/s (~0.86 °/s). Any real
   *  manoeuvre is an order of magnitude above this. */
  GYRO_MEAN_MAX: 0.015,
  /** |acceleration| must also be near g: a phone in free fall or under strong
   *  sustained acceleration is not stationary however steady it looks. */
  ACC_MEAN_TOLERANCE: 0.6,
  /** below this many stationary samples, do not estimate a yaw bias from them
   *  — a handful of samples estimates noise, not bias */
  MIN_SAMPLES_FOR_BIAS: 30,
  /** never subtract more than this, rad/s. A larger apparent bias means the
   *  detector was wrong, not that the gyro drifted that far. */
  MAX_YAW_BIAS: 0.05,
} as const;

const G = 9.80665;

/**
 * Is this window of raw IMU stationary?
 *
 * `window` is flat, row-major, `samples × 6`, in the frozen channel order
 * `acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z`, with acceleration in m/s² and
 * gravity retained — exactly the array the on-device path already builds.
 *
 * The test is orientation-free: magnitudes only, so it holds whatever way up
 * the phone is mounted.
 */
export function isStationaryWindow(window: ArrayLike<number>, nFeatures = 6): boolean {
  const n = Math.floor(window.length / nFeatures);
  if (n === 0) return false;

  let accSum = 0;
  let accSumSq = 0;
  let gyroSum = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * nFeatures;
    const a = Math.hypot(window[o], window[o + 1], window[o + 2]);
    accSum += a;
    accSumSq += a * a;
    gyroSum += Math.hypot(window[o + 3], window[o + 4], window[o + 5]);
  }
  const accMean = accSum / n;
  // population variance; n is 50 here so the Bessel correction is irrelevant
  const accVar = Math.max(0, accSumSq / n - accMean * accMean);
  const gyroMean = gyroSum / n;

  return (
    accVar < ZUPT.ACC_VARIANCE_MAX &&
    gyroMean < ZUPT.GYRO_MEAN_MAX &&
    Math.abs(accMean - G) < ZUPT.ACC_MEAN_TOLERANCE
  );
}

export interface ConstraintResult {
  /** velocity with stationary samples clamped to zero */
  v: Float64Array;
  /** yaw rate with the estimated bias removed and stationary samples zeroed */
  yaw: Float64Array;
  /** how many samples were held at zero velocity */
  zuptSamples: number;
  /** the bias that was subtracted, rad/s — 0 when none could be estimated */
  yawBias: number;
}

/**
 * Apply the constraints to one outage's frozen output.
 *
 * Pure, so it is testable against recorded predictions with no device and no
 * model. `stationary[i]` corresponds to `v[i]` and `yaw[i]`.
 */
export function applyMotionConstraints(
  v: Float64Array | number[],
  yaw: Float64Array | number[],
  stationary: ArrayLike<boolean>,
  enabled = true,
): ConstraintResult {
  const n = v.length;
  const outV = new Float64Array(n);
  const outYaw = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    outV[i] = v[i];
    outYaw[i] = yaw[i];
  }
  if (!enabled || n === 0) return { v: outV, yaw: outYaw, zuptSamples: 0, yawBias: 0 };

  // --- estimate the yaw-rate bias from the stationary samples ---------------
  let stationaryCount = 0;
  let yawSum = 0;
  for (let i = 0; i < n; i += 1) {
    if (!stationary[i]) continue;
    stationaryCount += 1;
    yawSum += yaw[i];
  }

  let yawBias = 0;
  if (stationaryCount >= ZUPT.MIN_SAMPLES_FOR_BIAS) {
    const estimate = yawSum / stationaryCount;
    // An estimate beyond the plausible range means the detector fired on
    // something that was not stationary. Distrust the estimate, not the gyro.
    if (Math.abs(estimate) <= ZUPT.MAX_YAW_BIAS) yawBias = estimate;
  }

  // --- clamp and de-bias ---------------------------------------------------
  for (let i = 0; i < n; i += 1) {
    if (stationary[i]) {
      // A stopped vehicle is neither moving nor turning. Zeroing the yaw rate
      // as well as the velocity is what stops heading drifting while parked,
      // which would otherwise rotate the whole remainder of the track.
      outV[i] = 0;
      outYaw[i] = 0;
    } else {
      outYaw[i] = yaw[i] - yawBias;
    }
  }

  return { v: outV, yaw: outYaw, zuptSamples: stationaryCount, yawBias };
}
