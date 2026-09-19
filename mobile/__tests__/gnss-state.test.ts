import { bearingDeg, classifyGnss, haversineM } from '@/services/gnss';
import { TUNING } from '@/services/config';
import type { GnssSample } from '@/types';

const fix = (over: Partial<GnssSample> = {}): GnssSample => ({
  latitude: 52.4,
  longitude: -1.5,
  speed: 12,
  bearing: 90,
  accuracy: 5,
  altitude: null,
  timestamp: Date.now(),
  t: 0,
  ...over,
});

describe('classifyGnss — GNSS sensor state transitions', () => {
  it('is UNAVAILABLE when the OS denies location, whatever the last fix was', () => {
    expect(classifyGnss({ fix: fix(), age: 0, available: false }).state).toBe('UNAVAILABLE');
  });

  it('is OUTAGE before the first fix arrives', () => {
    expect(classifyGnss({ fix: null, age: 0, available: true }).state).toBe('OUTAGE');
  });

  it('is ACTIVE for a fresh, accurate fix', () => {
    const r = classifyGnss({ fix: fix({ accuracy: 4 }), age: 0.4, available: true });
    expect(r.state).toBe('ACTIVE');
    expect(r.reason).toContain('4 m');
  });

  it('degrades to WEAK as accuracy worsens', () => {
    expect(classifyGnss({ fix: fix({ accuracy: TUNING.ACCURACY_WEAK_M }), age: 0, available: true }).state)
      .toBe('WEAK');
  });

  it('declares an OUTAGE once accuracy passes the outage threshold', () => {
    expect(
      classifyGnss({ fix: fix({ accuracy: TUNING.ACCURACY_OUTAGE_M + 1 }), age: 0, available: true })
        .state,
    ).toBe('OUTAGE');
  });

  it('declares an OUTAGE on a stale fix even when its accuracy was good', () => {
    const r = classifyGnss({ fix: fix({ accuracy: 3 }), age: TUNING.FIX_TIMEOUT_S, available: true });
    expect(r.state).toBe('OUTAGE');
    expect(r.reason).toMatch(/No fix for/);
  });

  it('warns while a fix is ageing but not yet timed out', () => {
    expect(classifyGnss({ fix: fix({ accuracy: 3 }), age: TUNING.FIX_STALE_S, available: true }).state)
      .toBe('WEAK');
  });

  it('treats a missing accuracy estimate as WEAK, not ACTIVE', () => {
    expect(classifyGnss({ fix: fix({ accuracy: null }), age: 0, available: true }).state).toBe('WEAK');
  });

  it('always explains itself', () => {
    for (const input of [
      { fix: null, age: 0, available: true },
      { fix: fix(), age: 0, available: true },
      { fix: fix(), age: 99, available: true },
      { fix: fix(), age: 0, available: false },
    ]) {
      expect(classifyGnss(input).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('geodesy helpers', () => {
  it('measures a known short distance', () => {
    // one degree of latitude is ~111.3 km
    const d = haversineM({ latitude: 52.0, longitude: -1.5 }, { latitude: 52.01, longitude: -1.5 });
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });

  it('returns zero for identical points', () => {
    expect(haversineM({ latitude: 1, longitude: 2 }, { latitude: 1, longitude: 2 })).toBeCloseTo(0, 6);
  });

  it('computes north and east bearings', () => {
    expect(bearingDeg({ latitude: 52, longitude: -1.5 }, { latitude: 52.01, longitude: -1.5 })).toBeCloseTo(0, 1);
    expect(bearingDeg({ latitude: 52, longitude: -1.5 }, { latitude: 52, longitude: -1.49 })).toBeCloseTo(90, 1);
  });
});
