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

  it('is ACQUIRING, not OUTAGE, before the first fix ever arrives', () => {
    // "we have not found it yet" and "we lost it" are different events and the
    // driver is told different things about them
    const r = classifyGnss({ fix: null, age: 0, available: true, acquiring: true });
    expect(r.state).toBe('ACQUIRING');
    expect(r.reason).toMatch(/Acquiring/);
  });

  it('is OUTAGE when the fix disappears after one has been seen', () => {
    expect(classifyGnss({ fix: null, age: 30, available: true, acquiring: false }).state).toBe(
      'OUTAGE',
    );
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

  it('does not call an ordinary urban fix an outage', () => {
    // a phone falling back to cell/Wi-Fi positioning reports 50-100 m. That is
    // a usable position, and calling it an outage is what produced "GNSS lost"
    // out of nowhere on a clear road.
    for (const accuracy of [35, 50, 80, 100]) {
      expect(classifyGnss({ fix: fix({ accuracy }), age: 0, available: true }).state).not.toBe(
        'OUTAGE',
      );
    }
  });

  it('applies hysteresis so a receiver on the boundary cannot oscillate', () => {
    const onBoundary = TUNING.ACCURACY_WEAK_CLEAR_M + 1; // between clear and enter
    // coming from ACTIVE this is still ACTIVE — it has not reached the enter value
    expect(
      classifyGnss({ fix: fix({ accuracy: onBoundary }), age: 0, available: true, previous: 'ACTIVE' })
        .state,
    ).toBe('ACTIVE');
    // but having already gone WEAK, it stays WEAK until it clears the lower value
    expect(
      classifyGnss({ fix: fix({ accuracy: onBoundary }), age: 0, available: true, previous: 'WEAK' })
        .state,
    ).toBe('WEAK');
  });

  it('the enter and clear thresholds are ordered, or hysteresis is a no-op', () => {
    expect(TUNING.ACCURACY_WEAK_CLEAR_M).toBeLessThan(TUNING.ACCURACY_WEAK_M);
    expect(TUNING.ACCURACY_OUTAGE_CLEAR_M).toBeLessThan(TUNING.ACCURACY_OUTAGE_M);
    expect(TUNING.ACCURACY_WEAK_M).toBeLessThan(TUNING.ACCURACY_OUTAGE_M);
    expect(TUNING.FIX_STALE_S).toBeLessThan(TUNING.FIX_TIMEOUT_S);
  });

  it('always explains itself', () => {
    for (const input of [
      { fix: null, age: 0, available: true },
      { fix: null, age: 0, available: true, acquiring: true },
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
