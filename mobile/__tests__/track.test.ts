import { TUNING } from '@/services/config';
import { appendPoint, decimate, pathLengthM, regionFor, toLatLng } from '@/services/track';
import { defaultRate, sampleAt } from '@/services/demo-player';
import type { LatLng } from '@/types';

const p = (lat: number, lon: number): LatLng => ({ latitude: lat, longitude: lon });

describe('appendPoint — polyline growth', () => {
  it('appends the first point unconditionally', () => {
    expect(appendPoint([], p(52, -1.5))).toHaveLength(1);
  });

  it('drops a point that has barely moved, so a stationary vehicle does not bloat the track', () => {
    const path = [p(52, -1.5)];
    const next = appendPoint(path, p(52.000001, -1.5));
    expect(next).toBe(path); // same reference — no re-render is triggered
  });

  it('appends once the point has moved past the spacing threshold', () => {
    const path = [p(52, -1.5)];
    expect(appendPoint(path, p(52.0002, -1.5))).toHaveLength(2);
  });

  it('respects a caller-supplied spacing', () => {
    const path = [p(52, -1.5)];
    expect(appendPoint(path, p(52.00005, -1.5), 10)).toBe(path);
    expect(appendPoint(path, p(52.00005, -1.5), 1)).toHaveLength(2);
  });
});

describe('pathLengthM', () => {
  it('is zero for an empty or single-point path', () => {
    expect(pathLengthM([])).toBe(0);
    expect(pathLengthM([p(52, -1.5)])).toBe(0);
  });

  it('sums the legs of a multi-point path', () => {
    const len = pathLengthM([p(52, -1.5), p(52.01, -1.5), p(52.02, -1.5)]);
    expect(len).toBeGreaterThan(2200);
    expect(len).toBeLessThan(2240);
  });
});

describe('decimate — map performance', () => {
  it('leaves a short path untouched', () => {
    const path = Array.from({ length: 10 }, (_, i) => p(52 + i * 1e-4, -1.5));
    expect(decimate(path)).toBe(path);
  });

  it('caps a long path at the render budget', () => {
    const path = Array.from({ length: 9000 }, (_, i) => p(52 + i * 1e-6, -1.5));
    const out = decimate(path);
    expect(out.length).toBeLessThanOrEqual(TUNING.MAX_POLYLINE_POINTS + 1);
  });

  it('always keeps the first and last point so the line still spans the data', () => {
    const path = Array.from({ length: 5000 }, (_, i) => p(52 + i * 1e-6, -1.5));
    const out = decimate(path, 100);
    expect(out[0]).toBe(path[0]);
    expect(out[out.length - 1]).toBe(path[path.length - 1]);
  });

  it('handles a 300 s dead-reckoned outage (3000 points at 10 Hz)', () => {
    const outage = Array.from({ length: 3000 }, (_, i) => p(52 + i * 1e-5, -1.5 + i * 1e-5));
    const out = decimate(outage, 600);
    expect(out.length).toBeLessThanOrEqual(601);
    expect(out.length).toBeGreaterThan(100);
  });
});

describe('regionFor — camera framing', () => {
  it('returns null when there is nothing to frame', () => {
    expect(regionFor([])).toBeNull();
  });

  it('centres on the bounding box of the supplied points', () => {
    const r = regionFor([p(52, -1.5), p(52.02, -1.4)])!;
    expect(r.latitude).toBeCloseTo(52.01, 5);
    expect(r.longitude).toBeCloseTo(-1.45, 5);
    expect(r.latitudeDelta).toBeGreaterThan(0.02);
  });

  it('enforces a minimum zoom for a single point', () => {
    const r = regionFor([p(52, -1.5)])!;
    expect(r.latitudeDelta).toBeGreaterThan(0);
    expect(r.longitudeDelta).toBeGreaterThan(0);
  });

  it('ignores non-finite coordinates rather than producing a NaN region', () => {
    const r = regionFor([p(52, -1.5), p(NaN, -1.5), p(52.01, -1.49)])!;
    expect(Number.isFinite(r.latitude)).toBe(true);
    expect(Number.isFinite(r.latitudeDelta)).toBe(true);
  });
});

describe('toLatLng', () => {
  it('converts the demo payload [lat, lon] pairs to map coordinates', () => {
    expect(toLatLng([[52.4, -1.5]])).toEqual([{ latitude: 52.4, longitude: -1.5 }]);
  });
});

describe('demo playback helpers', () => {
  const series = [
    { t: 0, v: 0 },
    { t: 10, v: 100 },
    { t: 20, v: 300 },
  ];
  const at = (t: number) => sampleAt(series, t, (x) => x.t, (x) => x.v);

  it('interpolates between samples', () => {
    expect(at(5)).toBeCloseTo(50, 6);
    expect(at(15)).toBeCloseTo(200, 6);
  });

  it('clamps outside the series rather than extrapolating', () => {
    expect(at(-5)).toBe(0);
    expect(at(999)).toBe(300);
  });

  it('hits the sample points exactly', () => {
    expect(at(10)).toBe(100);
  });

  it('returns null for an empty series', () => {
    expect(sampleAt([], 1, () => 0, () => 0)).toBeNull();
  });

  it('speeds long outages up so a demo stays watchable', () => {
    expect(defaultRate(10)).toBe(1);
    expect(defaultRate(30)).toBe(2);
    expect(defaultRate(300)).toBe(10);
    // every supported duration plays in under a minute
    for (const d of [10, 30, 60, 120, 300]) {
      expect(d / defaultRate(d)).toBeLessThanOrEqual(30);
    }
  });
});
