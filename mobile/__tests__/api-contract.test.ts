import {
  ApiError,
  api,
  getApiBaseUrl,
  parseHealth,
  parseInferenceResponse,
  parseSessionState,
  setApiBaseUrl,
} from '@/services/api';
import { FROZEN } from '@/services/config';
import type { SensorSample } from '@/types';

const validSession = {
  session_id: 'abc',
  mode: 'GNSS',
  samples_ingested: 120,
  windows_inferred: 71,
  rejected_windows: 0,
  buffer_fill: 50,
  buffer_required: 50,
  last_inference_ms: 4.2,
  telemetry: { timestamp_s: 12.0, delta_v: -0.37, yaw_rate: -0.12, v_abs_pred: 8.58 },
  outage: null,
  completed_outages: 0,
  k: 5,
  tau_s: 20,
};

describe('parseInferenceResponse — response validation', () => {
  it('accepts a well-formed response', () => {
    const r = parseInferenceResponse({
      delta_v: -0.366,
      yaw_rate: -0.1228,
      v_abs_pred: 8.576,
      window_samples: 50,
      features: [...FROZEN.FEATURES],
      latency_ms: 3.1,
    });
    expect(r.delta_v).toBeCloseTo(-0.366, 3);
    expect(r.window_samples).toBe(FROZEN.WINDOW_SAMPLES);
  });

  it('rejects a missing field rather than defaulting it to zero', () => {
    expect(() => parseInferenceResponse({ yaw_rate: 0, v_abs_pred: 0, window_samples: 50, latency_ms: 1 }))
      .toThrow(ApiError);
  });

  it('rejects NaN and Infinity — a silent NaN would poison the track', () => {
    const base = { yaw_rate: 0, v_abs_pred: 1, window_samples: 50, latency_ms: 1 };
    expect(() => parseInferenceResponse({ ...base, delta_v: NaN })).toThrow(/finite number/);
    expect(() => parseInferenceResponse({ ...base, delta_v: Infinity })).toThrow(/finite number/);
  });

  it('rejects a string where a number is required', () => {
    expect(() =>
      parseInferenceResponse({ delta_v: '0.3', yaw_rate: 0, v_abs_pred: 1, window_samples: 50, latency_ms: 1 }),
    ).toThrow(ApiError);
  });

  it('rejects a non-object body', () => {
    expect(() => parseInferenceResponse(null)).toThrow(/expected an object/);
    expect(() => parseInferenceResponse([1, 2, 3])).toThrow(/expected an object/);
    expect(() => parseInferenceResponse('ok')).toThrow(/expected an object/);
  });
});

describe('parseSessionState — session validation', () => {
  it('accepts a GNSS-mode session with telemetry', () => {
    const s = parseSessionState(validSession);
    expect(s.mode).toBe('GNSS');
    expect(s.telemetry?.delta_v).toBeCloseTo(-0.37, 2);
    expect(s.outage).toBeNull();
  });

  it('accepts a dead-reckoning session and keeps the estimated position', () => {
    const s = parseSessionState({
      ...validSession,
      mode: 'DEAD_RECKONING',
      outage: {
        active: true,
        samples: 300,
        duration_s: 30,
        latitude: 52.4061,
        longitude: -1.5021,
        velocity_mps: 13.08,
        heading_deg: 271.2,
        distance_m: 402.5,
        delta_v: -0.2,
        yaw_rate: 0.01,
      },
    });
    expect(s.mode).toBe('DEAD_RECKONING');
    expect(s.outage?.latitude).toBeCloseTo(52.4061, 4);
    expect(s.outage?.distance_m).toBeCloseTo(402.5, 1);
  });

  it('rejects an unknown mode instead of guessing', () => {
    expect(() => parseSessionState({ ...validSession, mode: 'MAGIC' })).toThrow(/unknown mode/);
  });

  it('tolerates a null telemetry block before the window has filled', () => {
    const s = parseSessionState({ ...validSession, telemetry: null, buffer_fill: 12 });
    expect(s.telemetry).toBeNull();
    expect(s.buffer_fill).toBe(12);
  });

  it('rejects an outage block missing its position', () => {
    expect(() =>
      parseSessionState({
        ...validSession,
        outage: { active: true, samples: 1, duration_s: 1, velocity_mps: 1, heading_deg: 1, distance_m: 1 },
      }),
    ).toThrow(ApiError);
  });

  it('maps a null last_inference_ms rather than throwing', () => {
    expect(parseSessionState({ ...validSession, last_inference_ms: null }).last_inference_ms).toBeNull();
  });
});

describe('parseHealth', () => {
  it('normalises anything that is not "ok" to degraded', () => {
    const raw = { status: 'weird', model_loaded: false, detail: 'x', uptime_s: 1, active_sessions: 0 };
    expect(parseHealth(raw).status).toBe('degraded');
    expect(parseHealth(raw).model_loaded).toBe(false);
  });

  it('defaults demo_sessions to 0 when the field is absent', () => {
    expect(
      parseHealth({ status: 'ok', model_loaded: true, detail: null, uptime_s: 5, active_sessions: 1 })
        .demo_sessions,
    ).toBe(0);
  });
});

describe('request formatting and transport errors', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    setApiBaseUrl('http://127.0.0.1:8000');
  });

  const samples: SensorSample[] = Array.from({ length: FROZEN.WINDOW_SAMPLES }, (_, i) => ({
    t: i / FROZEN.SAMPLE_RATE_HZ,
    acc_x: 0.1,
    acc_y: 0.2,
    acc_z: 9.8,
    gyro_x: 0.01,
    gyro_y: 0.02,
    gyro_z: 0.03,
  }));

  it('posts exactly one frozen window, in channel order, to /api/v1/inference', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          delta_v: 0,
          yaw_rate: 0,
          v_abs_pred: 1,
          window_samples: 50,
          features: [...FROZEN.FEATURES],
          latency_ms: 1,
        }),
      };
    }) as unknown as typeof fetch;

    setApiBaseUrl('http://example.test:8000/');
    await api.inference(samples);

    expect(getApiBaseUrl()).toBe('http://example.test:8000');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://example.test:8000/api/v1/inference');
    expect(calls[0].init.method).toBe('POST');

    const body = JSON.parse(String(calls[0].init.body)) as { samples: SensorSample[] };
    expect(body.samples).toHaveLength(FROZEN.WINDOW_SAMPLES);
    expect(Object.keys(body.samples[0])).toEqual(['t', ...FROZEN.FEATURES]);
    // 10 Hz cadence preserved end to end
    expect(body.samples[49].t - body.samples[0].t).toBeCloseTo(4.9, 6);
  });

  it('raises a network ApiError when the service is unreachable', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(api.health()).rejects.toMatchObject({ kind: 'network' });
  });

  it('surfaces the service detail on an HTTP error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ detail: 'window spans 3.100 s' }),
    })) as unknown as typeof fetch;
    await expect(api.health()).rejects.toThrow(/window spans 3\.100 s/);
  });

  it('raises a schema ApiError when the body is not JSON', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    await expect(api.health()).rejects.toMatchObject({ kind: 'schema' });
  });
});
