import { FROZEN, G } from '@/services/config';
import { SampleBuffer, SensorService } from '@/services/sensors';
import type { SensorSample } from '@/types';

const sample = (t: number): SensorSample => ({
  t,
  acc_x: t,
  acc_y: 0,
  acc_z: 9.8,
  gyro_x: 0,
  gyro_y: 0,
  gyro_z: 0,
});

describe('SampleBuffer — the rolling window', () => {
  it('reports its fill level up to capacity, then stops growing', () => {
    const b = new SampleBuffer(5);
    expect(b.length).toBe(0);
    for (let i = 0; i < 5; i += 1) b.push(sample(i));
    expect(b.length).toBe(5);
    b.push(sample(5));
    expect(b.length).toBe(5);
  });

  it('keeps samples in oldest-to-newest order after wrapping', () => {
    const b = new SampleBuffer(3);
    [0, 1, 2, 3, 4].forEach((i) => b.push(sample(i)));
    expect(b.toArray().map((s) => s.t)).toEqual([2, 3, 4]);
  });

  it('drops the oldest sample when it wraps, never a middle one', () => {
    const b = new SampleBuffer(4);
    [0, 1, 2, 3, 4, 5].forEach((i) => b.push(sample(i)));
    expect(b.toArray().map((s) => s.t)).toEqual([2, 3, 4, 5]);
  });

  it('returns the most recent n samples in order', () => {
    const b = new SampleBuffer(10);
    [0, 1, 2, 3, 4].forEach((i) => b.push(sample(i)));
    expect(b.last(3).map((s) => s.t)).toEqual([2, 3, 4]);
  });

  it('clamps last(n) to what it actually holds', () => {
    const b = new SampleBuffer(10);
    b.push(sample(1));
    expect(b.last(50).map((s) => s.t)).toEqual([1]);
  });

  it('peeks the newest sample', () => {
    const b = new SampleBuffer(4);
    expect(b.peek()).toBeNull();
    b.push(sample(7));
    b.push(sample(8));
    expect(b.peek()?.t).toBe(8);
  });

  it('holds at least one full frozen window plus a 300 s outage', () => {
    const service = new SensorService();
    const needed = FROZEN.WINDOW_SAMPLES + 300 * FROZEN.SAMPLE_RATE_HZ;
    expect(service.buffer.capacity).toBeGreaterThanOrEqual(needed);
  });

  it('empties on clear', () => {
    const b = new SampleBuffer(3);
    b.push(sample(1));
    b.clear();
    expect(b.length).toBe(0);
    expect(b.peek()).toBeNull();
  });
});

describe('SensorService — upload queue', () => {
  it('drains pending samples exactly once', () => {
    const s = new SensorService();
    // drive the private queue through the public surface
    s.requeue([sample(1), sample(2)]);
    expect(s.pendingCount).toBe(2);
    expect(s.drain().map((x) => x.t)).toEqual([1, 2]);
    expect(s.drain()).toEqual([]);
  });

  it('requeues a failed batch AHEAD of newer samples, preserving order', () => {
    const s = new SensorService();
    s.requeue([sample(3)]);
    s.requeue([sample(1), sample(2)]);
    expect(s.drain().map((x) => x.t)).toEqual([1, 2, 3]);
  });

  it('ignores an empty requeue', () => {
    const s = new SensorService();
    s.requeue([]);
    expect(s.pendingCount).toBe(0);
  });
});

describe('frozen input contract', () => {
  it('pins the window, rate and channel order the model was trained on', () => {
    expect(FROZEN.WINDOW_SAMPLES).toBe(50);
    expect(FROZEN.SAMPLE_RATE_HZ).toBe(10);
    expect(FROZEN.SAMPLE_INTERVAL_MS).toBe(100);
    expect(FROZEN.K).toBe(5);
    expect(FROZEN.TAU_S).toBe(20);
    expect([...FROZEN.FEATURES]).toEqual([
      'acc_x',
      'acc_y',
      'acc_z',
      'gyro_x',
      'gyro_y',
      'gyro_z',
    ]);
  });

  it('uses standard gravity to convert accelerometer g to m/s^2', () => {
    expect(G).toBeCloseTo(9.80665, 5);
    // a phone at rest reads about 1 g on one axis -> about 9.81 m/s^2
    expect(1 * G).toBeGreaterThan(9.7);
    expect(1 * G).toBeLessThan(9.9);
  });
});
