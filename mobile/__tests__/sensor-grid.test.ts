/**
 * The 10 Hz sampling grid.
 *
 * These tests exist because of a real, silent failure: the emitter used a
 * `setInterval(100)` and stamped each sample with the wall clock at the moment
 * the timer happened to fire. React Native's timers drift under load, so the
 * span of a 50-sample window reached 5.3-5.5 s against a nominal 4.9 s. The
 * on-device model rejects any window more than 10 % off nominal, so EVERY
 * window was rejected: `windows_inferred` stayed 0, the dead-reckoned path
 * never advanced, and the app sat on "AI DEAD RECKONING ACTIVE — 00:00 · 0 m"
 * while the vehicle drove away.
 *
 * The contract asserted here is the one the frozen model was trained against:
 * consecutive samples are exactly `dt` apart, whatever the timer does.
 */
import { FROZEN } from '@/services/config';
import { SensorService } from '@/services/sensors';

const DT = FROZEN.SAMPLE_INTERVAL_MS / 1000;
/** the same rule `OnDeviceInference.ingest` applies to a window */
const SPAN_NOMINAL = (FROZEN.WINDOW_SAMPLES - 1) * DT;
const SPAN_TOL = 0.1 * SPAN_NOMINAL;

/** A service with both sensors already reporting, so ticks actually emit. */
function primed() {
  const s = new SensorService();
  // `emit` waits for one reading from each sensor before producing anything
  const inner = s as unknown as { accSeen: boolean; gyroSeen: boolean; t0: number };
  inner.accSeen = true;
  inner.gyroSeen = true;
  inner.t0 = 0;
  return s;
}

function spanOf(samples: { t: number }[]) {
  return samples[samples.length - 1].t - samples[0].t;
}

describe('SensorService — the fixed 10 Hz grid', () => {
  it('stamps samples exactly dt apart when the timer is perfectly on time', () => {
    const s = primed();
    for (let now = 0; now <= 1000; now += 100) s.tick(now);
    const out = s.buffer.toArray();
    expect(out.length).toBe(11);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i].t - out[i - 1].t).toBeCloseTo(DT, 9);
    }
  });

  it('keeps the timeline exact even when every tick is late — the real bug', () => {
    const s = primed();
    // a 130 ms period is ordinary under load; the old emitter turned this into
    // a 6.4 s window span and dropped all 50 samples on the floor
    for (let now = 0, i = 0; i < 80; i += 1, now += 130) s.tick(now);
    const window = s.buffer.last(FROZEN.WINDOW_SAMPLES);
    expect(window.length).toBe(FROZEN.WINDOW_SAMPLES);
    expect(Math.abs(spanOf(window) - SPAN_NOMINAL)).toBeLessThan(SPAN_TOL);
  });

  it('produces windows the frozen contiguity check accepts, across jitter', () => {
    const s = primed();
    let now = 0;
    // pseudo-random jitter in [45, 165] ms, deterministic so a failure is
    // reproducible rather than flaky
    let seed = 7;
    for (let i = 0; i < 400; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      now += 45 + (seed % 120);
      s.tick(now);
    }
    const all = s.buffer.toArray();
    expect(all.length).toBeGreaterThan(FROZEN.WINDOW_SAMPLES);
    // walk every window the ingest path would form
    for (let end = FROZEN.WINDOW_SAMPLES; end <= all.length; end += 1) {
      const w = all.slice(end - FROZEN.WINDOW_SAMPLES, end);
      expect(Math.abs(spanOf(w) - SPAN_NOMINAL)).toBeLessThan(SPAN_TOL);
    }
  });

  it('never emits ahead of the clock', () => {
    const s = primed();
    for (let now = 0; now <= 2000; now += 100) s.tick(now);
    const out = s.buffer.toArray();
    // the grid is causal: sample n is due at n * 100 ms and stamped n * 0.1 s
    expect(out[out.length - 1].t).toBeLessThanOrEqual(2000 / 1000 + 1e-9);
  });

  it('resynchronises rather than fabricating history across a long stall', () => {
    const s = primed();
    for (let now = 0; now < 1000; now += 100) s.tick(now);
    const before = s.snapshot().count;
    // the app was backgrounded for 30 s: holding the last reading across that
    // would invent half a kilometre of motion that was never measured
    s.tick(31_000);
    const after = s.snapshot().count;
    expect(after - before).toBe(1);
    expect(s.snapshot().gaps).toBe(1);
  });

  it('leaves a visible discontinuity after a stall, so the window is rejected', () => {
    const s = primed();
    for (let now = 0; now < 6000; now += 100) s.tick(now);
    s.tick(40_000);
    const all = s.buffer.toArray();
    const last = all[all.length - 1];
    const previous = all[all.length - 2];
    // the gap is in the timestamps, which is what makes the straddling windows
    // fail the contiguity check instead of being silently stitched together
    expect(last.t - previous.t).toBeGreaterThan(SPAN_TOL);
  });

  it('emits nothing until both sensors have reported at least once', () => {
    const s = new SensorService();
    for (let now = 0; now <= 1000; now += 100) s.tick(now);
    expect(s.buffer.length).toBe(0);
  });
});
