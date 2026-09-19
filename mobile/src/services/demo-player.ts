/**
 * Demo Mode playback.
 *
 * Replays a REAL recorded drive: the GNSS track, then a real simulated outage in
 * which the vehicle follows the trajectory the FROZEN model actually produced
 * for that stretch of road, then GNSS recovery with the measured error.
 *
 * Every coordinate comes from `backend/demo_data/*.json`, exported once from the
 * frozen prediction files. This module only interpolates along those arrays with
 * time — it never generates a position.
 */
import type { DemoOutage, DemoSession, LatLng } from '@/types';
import { toLatLng } from './track';

export type DemoPhase = 'READY' | 'GNSS' | 'OUTAGE' | 'RECOVERED';

export interface DemoFrame {
  phase: DemoPhase;
  /** seconds into the current phase */
  phaseTime: number;
  /** where the marker is drawn */
  position: LatLng | null;
  /** dead-reckoned path revealed so far */
  drPath: LatLng[];
  /** ground-truth path revealed so far (VBOX reference) */
  truthPath: LatLng[];
  /** GNSS track leading into the outage */
  gnssPath: LatLng[];
  /** live error between the two, metres — only during/after the outage */
  errorM: number | null;
  /** dead-reckoning velocity at this instant, m/s */
  velocityMps: number | null;
  truthVelocityMps: number | null;
  progress: number;
  finished: boolean;
}

/** Seconds of GNSS driving shown before the outage begins. */
export const LEAD_IN_S = 8;

export class DemoPlayer {
  private drPath: LatLng[];
  private truthPath: LatLng[];
  private leadIn: LatLng[];

  constructor(
    readonly session: DemoSession,
    readonly outage: DemoOutage,
    /** playback speed multiplier — 300 s outages are shown faster */
    readonly rate = 1,
  ) {
    this.drPath = toLatLng(outage.dr_path);
    this.truthPath = toLatLng(outage.truth_path);
    // GNSS fixes from the minute before the outage, for the approach
    const t0 = outage.start_t - (session.track[0]?.t ?? 0);
    this.leadIn = session.track
      .filter((p) => p.t <= t0 && p.t >= t0 - 120)
      .map((p) => ({ latitude: p.lat, longitude: p.lon }));
    if (!this.leadIn.length && this.truthPath.length) this.leadIn = [this.truthPath[0]];
  }

  get totalS() {
    return LEAD_IN_S + this.outage.duration_s / this.rate;
  }

  /** Pure: the frame at `elapsed` seconds of wall-clock playback. */
  frame(elapsed: number): DemoFrame {
    if (elapsed <= 0) {
      return {
        phase: 'READY',
        phaseTime: 0,
        position: this.leadIn[this.leadIn.length - 1] ?? null,
        drPath: [],
        truthPath: [],
        gnssPath: this.leadIn,
        errorM: null,
        velocityMps: null,
        truthVelocityMps: null,
        progress: 0,
        finished: false,
      };
    }

    if (elapsed < LEAD_IN_S) {
      const f = elapsed / LEAD_IN_S;
      const n = Math.max(1, Math.ceil(this.leadIn.length * f));
      return {
        phase: 'GNSS',
        phaseTime: elapsed,
        position: this.leadIn[n - 1] ?? null,
        drPath: [],
        truthPath: [],
        gnssPath: this.leadIn.slice(0, n),
        errorM: null,
        velocityMps: this.outage.anchor.speed_mps,
        truthVelocityMps: this.outage.anchor.speed_mps,
        progress: 0,
        finished: false,
      };
    }

    const outageElapsed = Math.min((elapsed - LEAD_IN_S) * this.rate, this.outage.duration_s);
    const f = this.outage.duration_s > 0 ? outageElapsed / this.outage.duration_s : 1;
    const drN = Math.max(1, Math.round(this.drPath.length * f));
    const truthN = Math.max(1, Math.round(this.truthPath.length * f));
    const drSoFar = this.drPath.slice(0, drN);
    const truthSoFar = this.truthPath.slice(0, truthN);
    const done = outageElapsed >= this.outage.duration_s;

    return {
      phase: done ? 'RECOVERED' : 'OUTAGE',
      phaseTime: outageElapsed,
      position: drSoFar[drSoFar.length - 1] ?? null,
      drPath: drSoFar,
      truthPath: truthSoFar,
      gnssPath: this.leadIn,
      errorM: sampleAt(this.outage.error_growth, outageElapsed, (p) => p.t, (p) => p.err),
      velocityMps: sampleAt(this.outage.velocity, outageElapsed, (p) => p.t, (p) => p.dr),
      truthVelocityMps: sampleAt(this.outage.velocity, outageElapsed, (p) => p.t, (p) => p.truth),
      progress: f,
      finished: done,
    };
  }
}

/** Linear interpolation over a sorted series. Exported for tests. */
export function sampleAt<T>(
  series: T[],
  t: number,
  getT: (p: T) => number,
  getV: (p: T) => number,
): number | null {
  if (!series.length) return null;
  if (t <= getT(series[0])) return getV(series[0]);
  const last = series[series.length - 1];
  if (t >= getT(last)) return getV(last);
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1];
    const b = series[i];
    if (t <= getT(b)) {
      const span = getT(b) - getT(a);
      const w = span === 0 ? 0 : (t - getT(a)) / span;
      return getV(a) + w * (getV(b) - getV(a));
    }
  }
  return getV(last);
}

/** Faster playback for the long outages so a demo still lands in seconds. */
export function defaultRate(durationS: number): number {
  if (durationS >= 300) return 10;
  if (durationS >= 120) return 6;
  if (durationS >= 60) return 3;
  if (durationS >= 30) return 2;
  return 1;
}
