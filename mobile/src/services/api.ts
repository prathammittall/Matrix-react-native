/**
 * Client for the MATRIX inference API.
 *
 * Every response is parsed through an explicit validator before it reaches the
 * rest of the app. A malformed or partial response raises `ApiError` rather than
 * flowing into the navigation state — the spec's rule is that the app must say
 * "AI service unavailable" rather than display a position it cannot justify.
 */
import { DEFAULT_API_URL, TUNING } from './config';
import type {
  DemoSession,
  DemoSessionSummary,
  HealthStatus,
  InferenceResponse,
  ModelInfo,
  OutageAnchor,
  SensorSample,
  ServiceSessionState,
} from '@/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'timeout' | 'http' | 'schema',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let baseUrl = DEFAULT_API_URL;

export function setApiBaseUrl(url: string) {
  baseUrl = url.replace(/\/+$/, '');
}
export function getApiBaseUrl() {
  return baseUrl;
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  validate: (raw: unknown) => T,
  timeoutMs: number = TUNING.REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ApiError(
      aborted ? `Request to ${path} timed out after ${timeoutMs} ms` : `Cannot reach ${baseUrl}`,
      aborted ? 'timeout' : 'network',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      /* body was not JSON — keep the status text */
    }
    throw new ApiError(`${path} failed: ${detail}`, 'http', res.status);
  }

  if (res.status === 204) return validate(undefined);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new ApiError(`${path} returned a body that is not JSON`, 'schema');
  }
  return validate(raw);
}

// ---------------------------------------------------------------- validators
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function num(o: Record<string, unknown>, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ApiError(`${path}: field "${key}" is not a finite number`, 'schema');
  }
  return v;
}

function numOrNull(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(o: Record<string, unknown>, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ApiError(`${path}: field "${key}" is not a string`, 'schema');
  return v;
}

function obj(raw: unknown, path: string): Record<string, unknown> {
  if (!isObj(raw)) throw new ApiError(`${path}: expected an object`, 'schema');
  return raw;
}

export function parseInferenceResponse(raw: unknown): InferenceResponse {
  const o = obj(raw, 'inference');
  return {
    delta_v: num(o, 'delta_v', 'inference'),
    yaw_rate: num(o, 'yaw_rate', 'inference'),
    v_abs_pred: num(o, 'v_abs_pred', 'inference'),
    window_samples: num(o, 'window_samples', 'inference'),
    features: Array.isArray(o.features) ? (o.features as string[]) : [],
    latency_ms: num(o, 'latency_ms', 'inference'),
  };
}

export function parseSessionState(raw: unknown): ServiceSessionState {
  const o = obj(raw, 'session');
  const mode = str(o, 'mode', 'session');
  if (mode !== 'GNSS' && mode !== 'DEAD_RECKONING') {
    throw new ApiError(`session: unknown mode ${mode}`, 'schema');
  }

  let telemetry: ServiceSessionState['telemetry'] = null;
  if (isObj(o.telemetry)) {
    const t = o.telemetry;
    telemetry = {
      timestamp_s: num(t, 'timestamp_s', 'session.telemetry'),
      delta_v: num(t, 'delta_v', 'session.telemetry'),
      yaw_rate: num(t, 'yaw_rate', 'session.telemetry'),
      v_abs_pred: num(t, 'v_abs_pred', 'session.telemetry'),
    };
  }

  let outage: ServiceSessionState['outage'] = null;
  if (isObj(o.outage)) {
    const u = o.outage;
    outage = {
      active: true,
      samples: num(u, 'samples', 'session.outage'),
      duration_s: num(u, 'duration_s', 'session.outage'),
      latitude: num(u, 'latitude', 'session.outage'),
      longitude: num(u, 'longitude', 'session.outage'),
      velocity_mps: num(u, 'velocity_mps', 'session.outage'),
      heading_deg: num(u, 'heading_deg', 'session.outage'),
      distance_m: num(u, 'distance_m', 'session.outage'),
      delta_v: numOrNull(u, 'delta_v'),
      yaw_rate: numOrNull(u, 'yaw_rate'),
    };
  }

  return {
    session_id: str(o, 'session_id', 'session'),
    mode,
    samples_ingested: num(o, 'samples_ingested', 'session'),
    windows_inferred: num(o, 'windows_inferred', 'session'),
    rejected_windows: num(o, 'rejected_windows', 'session'),
    buffer_fill: num(o, 'buffer_fill', 'session'),
    buffer_required: num(o, 'buffer_required', 'session'),
    last_inference_ms: numOrNull(o, 'last_inference_ms'),
    telemetry,
    outage,
    completed_outages: num(o, 'completed_outages', 'session'),
    k: num(o, 'k', 'session'),
    tau_s: num(o, 'tau_s', 'session'),
  };
}

export function parseHealth(raw: unknown): HealthStatus {
  const o = obj(raw, 'health');
  const s = str(o, 'status', 'health');
  return {
    status: s === 'ok' ? 'ok' : 'degraded',
    model_loaded: o.model_loaded === true,
    detail: typeof o.detail === 'string' ? o.detail : null,
    uptime_s: num(o, 'uptime_s', 'health'),
    active_sessions: num(o, 'active_sessions', 'health'),
    device: typeof o.device === 'string' ? o.device : null,
    demo_sessions: numOrNull(o, 'demo_sessions') ?? 0,
  };
}

function parseModelInfo(raw: unknown): ModelInfo {
  const o = obj(raw, 'model');
  return {
    name: str(o, 'name', 'model'),
    version: str(o, 'version', 'model'),
    device: str(o, 'device', 'model'),
    window_samples: num(o, 'window_samples', 'model'),
    sampling_rate_hz: num(o, 'sampling_rate_hz', 'model'),
    features: Array.isArray(o.features) ? (o.features as string[]) : [],
    prediction: Array.isArray(o.prediction) ? (o.prediction as string[]) : [],
    fusion: str(o, 'fusion', 'model'),
    tau_s: num(o, 'tau_s', 'model'),
    k: num(o, 'k', 'model'),
    dt_s: num(o, 'dt_s', 'model'),
    n_params_abs_v: num(o, 'n_params_abs_v', 'model'),
    n_params_delta_v: num(o, 'n_params_delta_v', 'model'),
    checkpoints: isObj(o.checkpoints) ? o.checkpoints : {},
    frozen: o.frozen === true,
  };
}

// ------------------------------------------------------------------ endpoints
export const api = {
  health: () => request('/health', undefined, parseHealth, 4000),
  modelInfo: () => request('/model/info', undefined, parseModelInfo),
  benchmarks: () => request('/benchmarks', undefined, (r) => obj(r, 'benchmarks')),

  inference: (samples: SensorSample[]) =>
    request(
      '/inference',
      { method: 'POST', body: JSON.stringify({ samples }) },
      parseInferenceResponse,
    ),

  createSession: () => request('/sessions', { method: 'POST', body: '{}' }, parseSessionState),

  pushSamples: (sid: string, samples: SensorSample[]) =>
    request(
      `/sessions/${sid}/samples`,
      { method: 'POST', body: JSON.stringify({ samples }) },
      parseSessionState,
    ),

  startOutage: (sid: string, anchor: OutageAnchor) =>
    request(
      `/sessions/${sid}/outage/start`,
      { method: 'POST', body: JSON.stringify(anchor) },
      parseSessionState,
    ),

  endOutage: (sid: string, recovery: { latitude: number; longitude: number; speed_mps?: number | null; bearing_deg?: number | null } | null) =>
    request(
      `/sessions/${sid}/outage/end`,
      { method: 'POST', body: JSON.stringify({ recovery }) },
      (raw) => {
        const o = obj(raw, 'outage/end');
        return { outage: obj(o.outage, 'outage/end.outage'), state: parseSessionState(o.state) };
      },
    ),

  deleteSession: (sid: string) =>
    request(`/sessions/${sid}`, { method: 'DELETE' }, () => undefined as void),

  demoSessions: () =>
    request('/demo/sessions', undefined, (raw) => {
      const o = obj(raw, 'demo');
      return Array.isArray(o.sessions) ? (o.sessions as DemoSessionSummary[]) : [];
    }),

  demoSession: (id: string) =>
    request(`/demo/sessions/${encodeURIComponent(id)}`, undefined, (raw) => {
      const o = obj(raw, 'demo session');
      if (!Array.isArray(o.outages) || !Array.isArray(o.track)) {
        throw new ApiError('demo session: missing track or outages', 'schema');
      }
      return o as unknown as DemoSession;
    }, 20000),
};
