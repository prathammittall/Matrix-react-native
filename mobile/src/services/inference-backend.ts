/**
 * Pluggable inference backend.
 *
 * The navigation layer does not care where the frozen model runs. Two
 * implementations satisfy this interface and produce the same numbers, because
 * they run the same frozen weights and the same frozen filter:
 *
 *   OnDeviceBackend   ONNX Runtime on the phone. Works with NO network.
 *   ServiceBackend    the FastAPI inference service, calling the Python
 *                     originals directly.
 *
 * `resolveBackend()` picks one from the user's setting, with 'auto' preferring
 * on-device and falling back to the service only if the models cannot load.
 */
import { ApiError, api } from './api';
import { bearingFromFrozenHeading } from './geo';
import { haversineM } from './gnss';
import { onDevice } from './ondevice-inference';
import type { GnssSample, LatLng, OutageAnchor, SensorSample, ServiceSessionState } from '@/types';

export type InferenceMode = 'auto' | 'ondevice' | 'service';
export type BackendKind = 'ONDEVICE' | 'SERVICE';

export interface OutageResult {
  duration_s: number;
  dr_distance_m: number;
  path: LatLng[];
  estimated: LatLng | null;
  recovery_error_m: number | null;
  heading_error_deg: number | null;
}

export interface InferenceBackend {
  readonly kind: BackendKind;
  /** human-readable, shown in Diagnostics and the AI panel */
  readonly label: string;
  /** true when this backend keeps working with no network */
  readonly offlineCapable: boolean;
  open(): Promise<ServiceSessionState>;
  push(samples: SensorSample[]): Promise<ServiceSessionState>;
  startOutage(anchor: OutageAnchor): Promise<ServiceSessionState>;
  endOutage(recovery: GnssSample | null): Promise<OutageResult>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ on-device
export class OnDeviceBackend implements InferenceBackend {
  readonly kind = 'ONDEVICE' as const;
  readonly label = 'On-device (ONNX Runtime)';
  readonly offlineCapable = true;

  async open() {
    await onDevice.init();
    onDevice.reset();
    return onDevice.state();
  }

  push(samples: SensorSample[]) {
    return onDevice.ingest(samples);
  }

  async startOutage(anchor: OutageAnchor) {
    return onDevice.startOutage(anchor);
  }

  async endOutage(recovery: GnssSample | null): Promise<OutageResult> {
    const o = onDevice.endOutage();
    let recoveryErrorM: number | null = null;
    let headingErrorDeg: number | null = null;
    if (recovery && o.estimated) {
      recoveryErrorM = haversineM(o.estimated, recovery);
      if (recovery.bearing !== null) {
        headingErrorDeg = (((recovery.bearing - o.heading_deg + 180) % 360) + 360) % 360 - 180;
      }
    }
    return {
      duration_s: o.duration_s,
      dr_distance_m: o.dr_distance_m,
      path: o.path,
      estimated: o.estimated,
      recovery_error_m: recoveryErrorM,
      heading_error_deg: headingErrorDeg,
    };
  }

  async close() {
    onDevice.reset();
  }
}

// -------------------------------------------------------------------- service
export class ServiceBackend implements InferenceBackend {
  readonly kind = 'SERVICE' as const;
  readonly label = 'Inference service';
  readonly offlineCapable = false;
  private sessionId: string | null = null;

  async open() {
    const s = await api.createSession();
    this.sessionId = s.session_id;
    return s;
  }

  private id() {
    if (!this.sessionId) throw new ApiError('no inference session is open', 'http');
    return this.sessionId;
  }

  push(samples: SensorSample[]) {
    return api.pushSamples(this.id(), samples);
  }

  startOutage(anchor: OutageAnchor) {
    return api.startOutage(this.id(), anchor);
  }

  async endOutage(recovery: GnssSample | null): Promise<OutageResult> {
    const { outage } = await api.endOutage(
      this.id(),
      recovery
        ? {
            latitude: recovery.latitude,
            longitude: recovery.longitude,
            speed_mps: recovery.speed,
            bearing_deg: recovery.bearing,
          }
        : null,
    );
    const est = outage.estimated as { latitude?: number; longitude?: number } | undefined;
    const rawPath = Array.isArray(outage.path) ? (outage.path as LatLng[]) : [];
    return {
      duration_s: Number(outage.duration_s) || 0,
      dr_distance_m: Number(outage.dr_distance_m) || 0,
      path: rawPath,
      estimated:
        est && typeof est.latitude === 'number' && typeof est.longitude === 'number'
          ? { latitude: est.latitude, longitude: est.longitude }
          : null,
      recovery_error_m:
        typeof outage.recovery_error_m === 'number' ? outage.recovery_error_m : null,
      heading_error_deg:
        typeof outage.heading_error_deg === 'number' ? outage.heading_error_deg : null,
    };
  }

  async close() {
    const id = this.sessionId;
    this.sessionId = null;
    if (id) await api.deleteSession(id).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ selection
export interface BackendSelection {
  backend: InferenceBackend;
  state: ServiceSessionState;
  /** set when 'auto' wanted on-device but had to fall back */
  fallbackReason?: string;
}

/**
 * Open a backend according to the user's setting.
 *
 * 'auto' prefers on-device — it is the only option that survives a tunnel with
 * no signal, which is the whole point of the product — and falls back to the
 * service only if the bundled models cannot be loaded.
 */
export async function resolveBackend(mode: InferenceMode): Promise<BackendSelection> {
  if (mode === 'service') {
    const backend = new ServiceBackend();
    return { backend, state: await backend.open() };
  }

  const local = new OnDeviceBackend();
  try {
    return { backend: local, state: await local.open() };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'on-device models failed to load';
    if (mode === 'ondevice') throw err;
    const remote = new ServiceBackend();
    return { backend: remote, state: await remote.open(), fallbackReason: reason };
  }
}

export { bearingFromFrozenHeading };
