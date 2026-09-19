/**
 * GNSS sensor layer.
 *
 * This layer answers exactly one question: what is the GNSS receiver doing?
 * It does NOT decide what the app navigates by — that is the navigation layer's
 * job (see `navigation-engine.ts`). Keeping the two apart is why a GNSS outage
 * with the inference service down becomes DEGRADED rather than a fake position.
 *
 * `classifyGnss` is a pure function so the whole state machine is unit-testable
 * without a device.
 */
import * as Location from 'expo-location';

import { TUNING } from './config';
import type { GnssSample, GnssState, GnssStatus } from '@/types';

export interface ClassifyInput {
  fix: GnssSample | null;
  /** seconds since the last accepted fix */
  age: number;
  /** false when the OS reports location services off or permission denied */
  available: boolean;
}

export function classifyGnss({ fix, age, available }: ClassifyInput): {
  state: GnssState;
  reason: string;
} {
  if (!available) return { state: 'UNAVAILABLE', reason: 'Location services unavailable' };
  if (!fix) return { state: 'OUTAGE', reason: 'No GNSS fix acquired yet' };
  if (age >= TUNING.FIX_TIMEOUT_S) {
    return { state: 'OUTAGE', reason: `No fix for ${age.toFixed(1)} s` };
  }
  const acc = fix.accuracy;
  if (acc === null) return { state: 'WEAK', reason: 'Fix reports no accuracy estimate' };
  if (acc >= TUNING.ACCURACY_OUTAGE_M) {
    return { state: 'OUTAGE', reason: `Accuracy degraded to ${acc.toFixed(0)} m` };
  }
  if (acc >= TUNING.ACCURACY_WEAK_M) {
    return { state: 'WEAK', reason: `Accuracy ${acc.toFixed(0)} m` };
  }
  if (age >= TUNING.FIX_STALE_S) {
    return { state: 'WEAK', reason: `Fix is ${age.toFixed(1)} s old` };
  }
  return { state: 'ACTIVE', reason: `Accuracy ${acc.toFixed(0)} m` };
}

export type PermissionOutcome = 'granted' | 'denied' | 'services-off';

export class GnssService {
  private sub: Location.LocationSubscription | null = null;
  private lastFix: GnssSample | null = null;
  private lastFixAt = 0;
  private available = true;
  private clockOrigin = Date.now();
  /** consecutive readings in a bad/good state, for debouncing the mode switch */
  private simulatedOutage = false;

  onStatus: ((s: GnssStatus) => void) | null = null;

  /** Align the GNSS clock with the sensor stream so `t` shares one origin. */
  setClockOrigin(ms: number) {
    this.clockOrigin = ms;
  }

  static async requestPermission(): Promise<PermissionOutcome> {
    const enabled = await Location.hasServicesEnabledAsync().catch(() => false);
    if (!enabled) return 'services-off';
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === Location.PermissionStatus.GRANTED ? 'granted' : 'denied';
  }

  static async permissionStatus(): Promise<PermissionOutcome> {
    const enabled = await Location.hasServicesEnabledAsync().catch(() => false);
    if (!enabled) return 'services-off';
    const { status } = await Location.getForegroundPermissionsAsync();
    return status === Location.PermissionStatus.GRANTED ? 'granted' : 'denied';
  }

  async start(): Promise<PermissionOutcome> {
    const outcome = await GnssService.requestPermission();
    this.available = outcome === 'granted';
    if (!this.available) {
      this.emit();
      return outcome;
    }
    this.sub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 0,
      },
      (loc) => this.ingest(loc),
    );
    this.emit();
    return outcome;
  }

  private ingest(loc: Location.LocationObject) {
    const now = Date.now();
    this.lastFix = {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      speed: typeof loc.coords.speed === 'number' && loc.coords.speed >= 0 ? loc.coords.speed : null,
      bearing: typeof loc.coords.heading === 'number' && loc.coords.heading >= 0 ? loc.coords.heading : null,
      accuracy: typeof loc.coords.accuracy === 'number' ? loc.coords.accuracy : null,
      altitude: typeof loc.coords.altitude === 'number' ? loc.coords.altitude : null,
      timestamp: loc.timestamp ?? now,
      t: (now - this.clockOrigin) / 1000,
    };
    this.lastFixAt = now;
    this.emit();
  }

  /** Demo/testing aid: pretend the receiver has stopped reporting.
   *  It suppresses real fixes — it never invents one. */
  setSimulatedOutage(on: boolean) {
    this.simulatedOutage = on;
    this.emit();
  }

  get isSimulatingOutage() {
    return this.simulatedOutage;
  }

  status(): GnssStatus {
    if (this.simulatedOutage) {
      return {
        state: 'OUTAGE',
        fix: this.lastFix,
        age: (Date.now() - this.lastFixAt) / 1000,
        reason: 'Simulated GNSS outage (demo control)',
        satellites: null,
      };
    }
    const age = this.lastFix ? (Date.now() - this.lastFixAt) / 1000 : Number.POSITIVE_INFINITY;
    const { state, reason } = classifyGnss({
      fix: this.lastFix,
      age: Number.isFinite(age) ? age : TUNING.FIX_TIMEOUT_S,
      available: this.available,
    });
    return { state, fix: this.lastFix, age: Number.isFinite(age) ? age : 0, reason, satellites: null };
  }

  private emit() {
    this.onStatus?.(this.status());
  }

  stop() {
    this.sub?.remove();
    this.sub = null;
  }
}

/** Great-circle distance in metres. */
export function haversineM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const R = 6378137;
  const p1 = (a.latitude * Math.PI) / 180;
  const p2 = (b.latitude * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b.longitude - a.longitude) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from `a` to `b`, degrees clockwise from north. */
export function bearingDeg(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const p1 = (a.latitude * Math.PI) / 180;
  const p2 = (b.latitude * Math.PI) / 180;
  const dl = ((b.longitude - a.longitude) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
