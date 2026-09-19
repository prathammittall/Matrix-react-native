/**
 * Parity test for the on-device port of the frozen fusion.
 *
 * The vectors in `fixtures/fusion_golden.json` were produced by running the
 * FROZEN Python functions over real outage segments of the test split
 * (`backend/tools/export_fusion_golden.py`). If the TypeScript port disagrees
 * with them by more than float noise, the offline path has diverged from the
 * model and this test fails.
 *
 * Regenerate the fixture with:
 *     python backend/tools/export_fusion_golden.py
 */
import golden from './fixtures/fusion_golden.json';

import {
  complementary,
  deadReckon,
  fuseAndDeadReckon,
  vAbsAnchored,
  type FusionConstants,
} from '@/services/frozen-fusion';

interface GoldenCase {
  name: string;
  length: number;
  v0: number;
  tau: number;
  input: { dv: number[]; va: number[]; yaw: number[] };
  expected: { va_anchored: number[]; v: number[]; x: number[]; y: number[]; h: number[] };
}

const cases = golden.cases as GoldenCase[];
const K: FusionConstants = { k: golden.k, dt: golden.dt, tau: golden.tau };

/**
 * Tolerance. The Python side accumulates in float64 and so does JavaScript, so
 * the only difference is summation order inside numpy's cumsum versus the
 * explicit loop here. Over a 3000-sample outage that stays far below a
 * millimetre, which is six orders of magnitude below the metre-scale errors the
 * model itself produces.
 */
const ABS_TOL = 1e-6;
const REL_TOL = 1e-9;

function expectSeries(actual: ArrayLike<number>, expected: number[], label: string) {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < expected.length; i += 1) {
    const tol = Math.max(ABS_TOL, Math.abs(expected[i]) * REL_TOL);
    const diff = Math.abs(actual[i] - expected[i]);
    if (diff / tol > worst) {
      worst = diff / tol;
      worstAt = i;
    }
  }
  if (worst > 1) {
    throw new Error(
      `${label}: diverged from the frozen implementation at index ${worstAt} — ` +
        `got ${actual[worstAt]}, frozen ${expected[worstAt]}`,
    );
  }
}

describe('frozen fusion — the on-device port must match the Python original', () => {
  it('has golden vectors covering every supported outage length', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(golden.tau).toBe(20);
    expect(golden.k).toBe(5);
    expect(golden.dt).toBeCloseTo(0.1, 12);
  });

  describe.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    it('reproduces v_abs_anchored', () => {
      expectSeries(vAbsAnchored(c.input.va, c.v0), c.expected.va_anchored, 'va_anchored');
    });

    it('reproduces the complementary filter', () => {
      const vaAnch = vAbsAnchored(c.input.va, c.v0);
      expectSeries(complementary(c.input.dv, vaAnch, c.v0, K), c.expected.v, 'v');
    });

    it('reproduces dead_reckon x, y and heading', () => {
      const dr = deadReckon(c.expected.v, c.input.yaw, K.dt);
      expectSeries(dr.h, c.expected.h, 'heading');
      expectSeries(dr.x, c.expected.x, 'x');
      expectSeries(dr.y, c.expected.y, 'y');
    });

    it('reproduces the whole pipeline end to end', () => {
      const out = fuseAndDeadReckon(c.input.dv, c.input.va, c.input.yaw, c.v0, K);
      expectSeries(out.v, c.expected.v, 'v');
      expectSeries(out.x, c.expected.x, 'x');
      expectSeries(out.y, c.expected.y, 'y');
    });
  });
});

describe('frozen fusion — invariants the frozen implementation guarantees', () => {
  it('anchors the filter exactly at v0', () => {
    const v = complementary([0.5, 0.5, 0.5], [9, 9, 9], 7.25, K);
    expect(v[0]).toBe(7.25);
  });

  it('floors velocity at zero and never returns a negative speed', () => {
    const c = cases.find((x) => x.name.startsWith('velocity floor'))!;
    const out = fuseAndDeadReckon(c.input.dv, c.input.va, c.input.yaw, c.v0, K);
    expect(Math.min(...out.v)).toBe(0);
    for (const value of out.v) expect(value).toBeGreaterThanOrEqual(0);
  });

  it('shifts the absolute-velocity series so it starts at the anchor', () => {
    const out = vAbsAnchored([12, 13, 14], 10);
    expect(out[0]).toBeCloseTo(10, 12);
    expect(out[1]).toBeCloseTo(11, 12);
  });

  it('clamps the anchored series at zero rather than going negative', () => {
    expect(Array.from(vAbsAnchored([12, 1, 0], 0))).toEqual([0, 0, 0]);
  });

  it('travels a straight line at constant speed with zero yaw', () => {
    const n = 100;
    const v = new Array(n).fill(10);
    const dr = deadReckon(v, new Array(n).fill(0), 0.1);
    expect(dr.x[n - 1]).toBeCloseTo(100, 9); // 10 m/s for 10 s
    expect(dr.y[n - 1]).toBeCloseTo(0, 12);
    expect(dr.h[n - 1]).toBe(0);
  });

  it('accumulates heading from the yaw rate', () => {
    const dr = deadReckon(new Array(10).fill(0), new Array(10).fill(0.5), 0.1);
    expect(dr.h[9]).toBeCloseTo(0.5, 9); // 0.5 rad/s for 1 s
  });

  it('returns empty series for empty input rather than throwing', () => {
    expect(complementary([], [], 5, K).length).toBe(0);
    expect(vAbsAnchored([], 5).length).toBe(0);
    expect(deadReckon([], [], 0.1).x.length).toBe(0);
  });
});
