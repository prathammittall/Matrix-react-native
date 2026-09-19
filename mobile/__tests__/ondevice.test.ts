/**
 * Offline inference path.
 *
 * Covers the parts of on-device inference that are ours: the bundled manifest
 * still matching the frozen contract, window formation and rejection, the
 * scaler being applied in the frozen channel order, geodetic projection, and
 * backend selection.
 *
 * Numerical fidelity of the ONNX graphs themselves is NOT asserted here — it is
 * verified against PyTorch on real test windows by
 * `backend/tools/export_onnx.py`, which refuses to write the files unless they
 * match (measured max |onnx − torch| = 1.9e-6). The frozen filter is pinned by
 * `frozen-fusion.test.ts`.
 */
import { FROZEN } from '@/services/config';
import { bearingFromFrozenHeading, localToLatLng, YAW_SIGN } from '@/services/geo';
import { haversineM } from '@/services/gnss';
import {
  MANIFEST,
  OnDeviceInference,
  manifestMatchesFrozenContract,
} from '@/services/ondevice-inference';
import { OnDeviceBackend, ServiceBackend, resolveBackend } from '@/services/inference-backend';
import type { SensorSample } from '@/types';

const imu = (n: number, t0 = 0, dt = 0.1): SensorSample[] =>
  Array.from({ length: n }, (_, i) => ({
    t: Number((t0 + i * dt).toFixed(3)),
    acc_x: 0.2,
    acc_y: 0.05,
    acc_z: 9.81,
    gyro_x: 0,
    gyro_y: 0,
    gyro_z: 0.03,
  }));

describe('bundled model manifest', () => {
  it('matches the frozen input contract this build expects', () => {
    expect(manifestMatchesFrozenContract()).toBe(true);
  });

  it('carries the frozen window, rate, k and τ', () => {
    expect(MANIFEST.window_samples).toBe(FROZEN.WINDOW_SAMPLES);
    expect(MANIFEST.sampling_rate_hz).toBeCloseTo(FROZEN.SAMPLE_RATE_HZ, 9);
    expect(MANIFEST.dt_s).toBeCloseTo(0.1, 12);
    expect(MANIFEST.k).toBe(FROZEN.K);
    expect(MANIFEST.tau_s).toBe(FROZEN.TAU_S);
  });

  it('carries the frozen feature order', () => {
    expect(MANIFEST.features).toEqual([...FROZEN.FEATURES]);
  });

  it('carries a 6-channel scaler, not the 11-channel superset', () => {
    expect(MANIFEST.feature_mean).toHaveLength(6);
    expect(MANIFEST.feature_std).toHaveLength(6);
    // acc_z retains gravity, so its mean sits near 9.81
    expect(MANIFEST.feature_mean[2]).toBeGreaterThan(9.5);
    expect(MANIFEST.feature_mean[2]).toBeLessThan(10.2);
    for (const sd of MANIFEST.feature_std) expect(sd).toBeGreaterThan(0);
  });

  it('records an export that reproduced PyTorch', () => {
    const worst = Math.max(
      ...Object.values(MANIFEST.verification.results).map((r) => r.max_abs_diff),
    );
    expect(worst).toBeLessThan(MANIFEST.verification.tolerance);
  });

  it('records the source checkpoints it was exported from', () => {
    expect(MANIFEST.delta_v.source_sha256).toHaveLength(64);
    expect(MANIFEST.abs_v.source_sha256).toHaveLength(64);
    expect(MANIFEST.delta_v.onnx_sha256).toHaveLength(64);
  });
});

describe('OnDeviceInference — window formation', () => {
  let engine: OnDeviceInference;

  beforeEach(async () => {
    engine = new OnDeviceInference();
    await engine.init();
  });

  it('loads and reports ready', () => {
    expect(engine.isReady).toBe(true);
  });

  it('runs no inference until the 50-sample window is full', async () => {
    const s = await engine.ingest(imu(49));
    expect(s.windows_inferred).toBe(0);
    expect(s.telemetry).toBeNull();
    expect(s.buffer_fill).toBe(49);
  });

  it('infers one window per sample once the buffer is full', async () => {
    await engine.ingest(imu(49));
    const s = await engine.ingest(imu(1, 4.9));
    expect(s.windows_inferred).toBe(1);
    expect(s.telemetry).not.toBeNull();
    expect(s.buffer_fill).toBe(FROZEN.WINDOW_SAMPLES);

    const later = await engine.ingest(imu(10, 5.0));
    expect(later.windows_inferred).toBe(11);
  });

  it('un-scales each model with ITS OWN frozen target scaler', async () => {
    // The two models use different target scalers (the Δv model carries its own
    // inside the checkpoint; the anchor model uses scaler.json). Mixing them
    // produces plausible-looking but wrong velocities, so this is asserted.
    const SCALED = 0.5; // what the ORT stub returns, in scaled space
    await engine.ingest(imu(50));
    const t = engine.state().telemetry!;
    expect(t.delta_v).toBeCloseTo(
      SCALED * MANIFEST.delta_v.target_std[0] + MANIFEST.delta_v.target_mean[0], 5);
    expect(t.yaw_rate).toBeCloseTo(
      -SCALED * MANIFEST.delta_v.target_std[1] + MANIFEST.delta_v.target_mean[1], 5);
    expect(t.v_abs_pred).toBeCloseTo(
      SCALED * MANIFEST.abs_v.target_std[0] + MANIFEST.abs_v.target_mean[0], 4);
    expect(MANIFEST.delta_v.target_std[0]).not.toBeCloseTo(MANIFEST.abs_v.target_std[0], 3);
  });

  it('rejects out-of-spec cadence rather than resampling it', async () => {
    const s = await engine.ingest(imu(60, 0, 0.2)); // 5 Hz
    expect(s.windows_inferred).toBe(0);
    expect(s.rejected_windows).toBeGreaterThan(0);
  });

  it('rejects a window containing a non-finite sample', async () => {
    const bad = imu(50);
    bad[20].acc_x = Number.NaN;
    const s = await engine.ingest(bad);
    expect(s.windows_inferred).toBe(0);
    expect(s.rejected_windows).toBeGreaterThanOrEqual(1);
  });

  it('reports GNSS mode until an outage is opened', async () => {
    await engine.ingest(imu(50));
    expect(engine.state().mode).toBe('GNSS');
    expect(engine.state().outage).toBeNull();
  });

  it('produces a dead-reckoned position during an outage', async () => {
    await engine.ingest(imu(50));
    engine.startOutage({
      latitude: 52.4,
      longitude: -1.5,
      speed_mps: 12,
      bearing_deg: 0,
      timestamp_s: 5,
    });
    const s = await engine.ingest(imu(100, 5));
    expect(s.mode).toBe('DEAD_RECKONING');
    expect(s.outage).not.toBeNull();
    expect(s.outage!.samples).toBe(100);
    expect(s.outage!.distance_m).toBeGreaterThan(0);
    // heading 0 and positive speed ⇒ the track moves north of the anchor
    expect(s.outage!.latitude).toBeGreaterThan(52.4);
  });

  it('closes an outage and returns its full path', async () => {
    await engine.ingest(imu(50));
    engine.startOutage({ latitude: 52.4, longitude: -1.5, speed_mps: 12, bearing_deg: 0, timestamp_s: 5 });
    await engine.ingest(imu(30, 5));
    const out = engine.endOutage();
    expect(out.samples).toBe(30);
    expect(out.path).toHaveLength(30);
    expect(engine.state().mode).toBe('GNSS');
    expect(engine.state().completed_outages).toBe(1);
  });

  it('refuses two overlapping outages', async () => {
    const anchor = { latitude: 52.4, longitude: -1.5, speed_mps: 12, bearing_deg: 0, timestamp_s: 0 };
    engine.startOutage(anchor);
    expect(() => engine.startOutage(anchor)).toThrow(/already active/);
  });

  it('refuses to end an outage that never started', () => {
    expect(() => engine.endOutage()).toThrow(/no outage/);
  });

  it('reports τ and k from the frozen manifest, not from a local guess', async () => {
    const s = engine.state();
    expect(s.tau_s).toBe(FROZEN.TAU_S);
    expect(s.k).toBe(FROZEN.K);
  });

  it('clears state on reset', async () => {
    await engine.ingest(imu(50));
    engine.reset();
    const s = engine.state();
    expect(s.samples_ingested).toBe(0);
    expect(s.buffer_fill).toBe(0);
    expect(s.telemetry).toBeNull();
  });
});

describe('geo — map projection for the offline path', () => {
  it('uses the empirically validated yaw convention', () => {
    expect(YAW_SIGN).toBe(1);
  });

  it('moves north for a north-facing anchor', () => {
    const p = localToLatLng(1000, 0, { lat0: 52, lon0: -1.5, heading0Deg: 0 });
    expect(p.latitude).toBeGreaterThan(52);
    expect(p.longitude).toBeCloseTo(-1.5, 9);
    expect(haversineM({ latitude: 52, longitude: -1.5 }, p)).toBeCloseTo(1000, 0);
  });

  it('moves east for an east-facing anchor', () => {
    const p = localToLatLng(1000, 0, { lat0: 52, lon0: -1.5, heading0Deg: 90 });
    expect(p.longitude).toBeGreaterThan(-1.5);
    expect(p.latitude).toBeCloseTo(52, 9);
  });

  it('returns the anchor itself for zero displacement', () => {
    const p = localToLatLng(0, 0, { lat0: 52.4, lon0: -1.5, heading0Deg: 137 });
    expect(p.latitude).toBeCloseTo(52.4, 12);
    expect(p.longitude).toBeCloseTo(-1.5, 12);
  });

  it('converts a frozen heading to a compass bearing, wrapping at 360', () => {
    expect(bearingFromFrozenHeading(10, (20 * Math.PI) / 180)).toBeCloseTo(350, 6);
    const wrapped = bearingFromFrozenHeading(0, -4 * Math.PI);
    expect(wrapped).toBeGreaterThanOrEqual(0);
    expect(wrapped).toBeLessThan(360);
  });
});

describe('backend selection', () => {
  it('opens the on-device backend in ondevice mode', async () => {
    const { backend } = await resolveBackend('ondevice');
    expect(backend.kind).toBe('ONDEVICE');
    expect(backend.offlineCapable).toBe(true);
  });

  it('prefers on-device in auto mode', async () => {
    const { backend, fallbackReason } = await resolveBackend('auto');
    expect(backend.kind).toBe('ONDEVICE');
    expect(fallbackReason).toBeUndefined();
  });

  it('marks the on-device backend as network-free and the service as not', () => {
    expect(new OnDeviceBackend().offlineCapable).toBe(true);
    expect(new ServiceBackend().offlineCapable).toBe(false);
  });
});
