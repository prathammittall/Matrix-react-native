import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';
import { Platform, RefreshControl, View } from 'react-native';
import Constants from 'expo-constants';

import { DiagnosticRow, SystemHealthCard } from '@/components/diagnostics-card';
import { Screen, ScreenHeader } from '@/components/screen';
import { Badge, Button, Card, Divider, Section, Txt } from '@/components/ui';
import { useEngine } from '@/hooks/use-engine';
import { useSettings } from '@/hooks/use-settings';
import { api, getApiBaseUrl } from '@/services/api';
import { FROZEN } from '@/services/config';
import { GnssService } from '@/services/gnss';
import { manifestMatchesFrozenContract, MANIFEST, onDevice } from '@/services/ondevice-inference';
import { SensorService } from '@/services/sensors';
import { Spacing, useColors } from '@/theme';
import type { ComponentHealth, HealthStatus, ModelInfo, SystemHealth } from '@/types';

/**
 * System diagnostics.
 *
 * Everything a developer or a judge needs to answer "why is it doing that?" in
 * one screen: permissions, sensor availability, actual sample rate, service
 * reachability, model identity, inference latency and the current mode.
 */
export default function DiagnosticsScreen() {
  const c = useColors();
  const { settings } = useSettings();
  const state = useEngine();

  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [sensors, setSensors] = useState({ accelerometer: false, gyroscope: false });
  const [locationPerm, setLocationPerm] = useState<string>('checking…');
  const [servicesOn, setServicesOn] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);

  const probe = useCallback(async () => {
    const t0 = Date.now();
    const [h, m, avail, perm, svc] = await Promise.allSettled([
      api.health(),
      api.modelInfo(),
      SensorService.availability(),
      GnssService.permissionStatus(),
      Location.hasServicesEnabledAsync(),
    ]);
    setLatency(Date.now() - t0);
    if (h.status === 'fulfilled') {
      setHealth(h.value);
      setHealthError(null);
    } else {
      setHealth(null);
      setHealthError(h.reason instanceof Error ? h.reason.message : 'unreachable');
    }
    setModel(m.status === 'fulfilled' ? m.value : null);
    if (avail.status === 'fulfilled') setSensors(avail.value);
    setLocationPerm(perm.status === 'fulfilled' ? perm.value : 'unknown');
    setServicesOn(svc.status === 'fulfilled' ? svc.value : null);
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const imuOk = sensors.accelerometer && sensors.gyroscope;
  const apiHealth: ComponentHealth = health ? (health.status === 'ok' ? 'READY' : 'WARNING') : 'OFFLINE';
  const manifestOk = manifestMatchesFrozenContract();
  const localModelOk = settings.inferenceMode !== 'service' && manifestOk;
  const health4: SystemHealth = {
    gnss:
      locationPerm !== 'granted'
        ? 'OFFLINE'
        : state.gnss.state === 'ACTIVE'
          ? 'ACTIVE'
          : state.gnss.state === 'WEAK'
            ? 'WARNING'
            : state.mode === 'IDLE'
              ? 'READY'
              : 'WARNING',
    imu: state.mode !== 'IDLE' ? 'ACTIVE' : imuOk ? 'READY' : 'OFFLINE',
    model:
      state.mode === 'DEAD_RECKONING'
        ? 'ACTIVE'
        : localModelOk || health?.model_loaded
          ? 'READY'
          : 'OFFLINE',
    api: apiHealth,
  };

  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  const mapProvider = typeof extra.mapProvider === 'string' ? extra.mapProvider : 'maplibre-osm';

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await probe();
            setRefreshing(false);
          }}
          tintColor={c.accent}
        />
      }>
      <ScreenHeader title="Diagnostics" subtitle="Live system state" back />

      <SystemHealthCard health={health4} />

      <Section title="Permissions">
        <Card style={{ gap: 2 }}>
          <DiagnosticRow
            label="Location permission"
            value={locationPerm}
            status={locationPerm === 'granted' ? 'READY' : 'OFFLINE'}
          />
          <DiagnosticRow
            label="Location services"
            value={servicesOn === null ? 'unknown' : servicesOn ? 'on' : 'off'}
            status={servicesOn ? 'READY' : 'OFFLINE'}
          />
          <DiagnosticRow
            label="Motion sensors"
            value={Platform.OS === 'ios' ? 'requested at start' : 'implicit on Android'}
            status="READY"
          />
          {locationPerm !== 'granted' ? (
            <>
              <Divider />
              <Button
                label="Request location permission"
                variant="secondary"
                onPress={async () => {
                  await GnssService.requestPermission();
                  await probe();
                }}
              />
            </>
          ) : null}
        </Card>
      </Section>

      <Section title="Sensors">
        <Card style={{ gap: 2 }}>
          <DiagnosticRow
            label="Accelerometer"
            value={sensors.accelerometer ? 'available' : 'unavailable'}
            status={sensors.accelerometer ? 'READY' : 'OFFLINE'}
          />
          <DiagnosticRow
            label="Gyroscope"
            value={sensors.gyroscope ? 'available' : 'unavailable'}
            status={sensors.gyroscope ? 'READY' : 'OFFLINE'}
          />
          <DiagnosticRow
            label="IMU stream"
            value={state.mode === 'IDLE' ? 'stopped' : 'running'}
            status={state.mode === 'IDLE' ? 'READY' : 'ACTIVE'}
          />
          <DiagnosticRow
            label="Required rate"
            value={`${FROZEN.SAMPLE_RATE_HZ} Hz (frozen)`}
          />
          <DiagnosticRow
            label="Window buffer"
            value={`${state.windowFill}/${state.windowRequired} samples`}
            status={state.windowFill >= state.windowRequired ? 'READY' : 'WARNING'}
          />
          <DiagnosticRow
            label="Rejected windows"
            value={String(state.serviceState?.rejected_windows ?? 0)}
            status={(state.serviceState?.rejected_windows ?? 0) > 0 ? 'WARNING' : 'READY'}
          />
        </Card>
        {(state.serviceState?.rejected_windows ?? 0) > 0 ? (
          <Txt variant="caption" color="textSecondary">
            Rejected windows are IMU windows whose timing fell outside the frozen 10 Hz
            specification. They are dropped rather than resampled, so the model never sees
            out-of-distribution input.
          </Txt>
        ) : null}
      </Section>

      <Section title="GNSS">
        <Card style={{ gap: 2 }}>
          <DiagnosticRow label="State" value={state.gnss.state} />
          <DiagnosticRow label="Reason" value={state.gnss.reason} />
          <DiagnosticRow
            label="Fix age"
            value={state.gnss.fix ? `${state.gnss.age.toFixed(1)} s` : 'no fix'}
          />
          <DiagnosticRow
            label="Accuracy"
            value={state.gnss.fix?.accuracy != null ? `${state.gnss.fix.accuracy.toFixed(0)} m` : '—'}
          />
          <DiagnosticRow
            label="Position"
            value={
              state.gnss.fix
                ? `${state.gnss.fix.latitude.toFixed(5)}, ${state.gnss.fix.longitude.toFixed(5)}`
                : '—'
            }
          />
          <DiagnosticRow
            label="Satellites"
            value={state.gnss.satellites != null ? String(state.gnss.satellites) : 'not exposed by OS'}
          />
        </Card>
      </Section>

      <Section title="Inference service">
        <Card style={{ gap: 2 }}>
          <DiagnosticRow label="Base URL" value={getApiBaseUrl()} status={health ? 'READY' : 'OFFLINE'} />
          <DiagnosticRow
            label="Reachable"
            value={health ? `yes (${latency} ms round trip)` : (healthError ?? 'no')}
            status={health ? 'READY' : 'OFFLINE'}
          />
          <DiagnosticRow
            label="Model loaded"
            value={health?.model_loaded ? 'yes' : 'no'}
            status={health?.model_loaded ? 'READY' : 'OFFLINE'}
          />
          <DiagnosticRow label="Compute device" value={health?.device?.toUpperCase() ?? '—'} />
          <DiagnosticRow label="Active sessions" value={String(health?.active_sessions ?? 0)} />
          <DiagnosticRow label="Demo sessions" value={String(health?.demo_sessions ?? 0)} />
          <DiagnosticRow
            label="Last inference"
            value={state.lastInferenceMs != null ? `${state.lastInferenceMs.toFixed(1)} ms` : '—'}
          />
          <DiagnosticRow
            label="Last inference at"
            value={
              state.lastInferenceAt
                ? `${((Date.now() - state.lastInferenceAt) / 1000).toFixed(1)} s ago`
                : '—'
            }
          />
          <DiagnosticRow label="Windows inferred" value={String(state.serviceState?.windows_inferred ?? 0)} />
        </Card>
      </Section>

      <Section title="On-device model">
        <Card style={{ gap: 2 }}>
          <DiagnosticRow
            label="Inference mode"
            value={
              settings.inferenceMode === 'ondevice'
                ? 'on device'
                : settings.inferenceMode === 'service'
                  ? 'server'
                  : 'auto (prefer on device)'
            }
          />
          <DiagnosticRow
            label="Active backend"
            value={
              state.backendLabel ??
              (state.mode === 'IDLE' ? 'not started' : 'none')
            }
            status={state.backend ? 'ACTIVE' : undefined}
          />
          <DiagnosticRow
            label="Works with no network"
            value={state.backend ? (state.offlineCapable ? 'yes' : 'no') : '—'}
            status={state.backend ? (state.offlineCapable ? 'READY' : 'WARNING') : undefined}
          />
          <DiagnosticRow
            label="Bundled graphs"
            value={`${MANIFEST.delta_v.file}, ${MANIFEST.abs_v.file}`}
          />
          <DiagnosticRow
            label="Graph loaded"
            value={onDevice.isReady ? 'yes' : 'not yet'}
            status={onDevice.isReady ? 'READY' : undefined}
          />
          <DiagnosticRow
            label="ONNX opset"
            value={String(MANIFEST.opset)}
          />
          <DiagnosticRow
            label="Matches frozen contract"
            value={manifestOk ? 'yes' : 'MISMATCH'}
            status={manifestOk ? 'READY' : 'WARNING'}
          />
          <DiagnosticRow
            label="Export accuracy"
            value={`max |onnx − torch| = ${Math.max(
              ...Object.values(MANIFEST.verification.results).map((r) => r.max_abs_diff),
            ).toExponential(2)}`}
            status="READY"
          />
          <DiagnosticRow
            label="Δv graph sha256"
            value={MANIFEST.delta_v.onnx_sha256.slice(0, 12)}
          />
          <DiagnosticRow
            label="Anchor graph sha256"
            value={MANIFEST.abs_v.onnx_sha256.slice(0, 12)}
          />
        </Card>
        {!manifestOk ? (
          <Txt variant="caption" color="textSecondary">
            The bundled model manifest does not match the frozen contract this build expects.
            Re-run backend/tools/export_onnx.py and rebuild.
          </Txt>
        ) : null}
      </Section>

      <Section title="Frozen model (service)">
        <Card style={{ gap: 2 }}>
          <DiagnosticRow label="Name" value={model ? `${model.name} v${model.version}` : '—'} />
          <DiagnosticRow
            label="Input"
            value={model ? `${model.window_samples} × ${model.features.length} @ ${model.sampling_rate_hz} Hz` : '—'}
          />
          <DiagnosticRow label="Prediction" value={model ? model.prediction.join(' + ') : '—'} />
          <DiagnosticRow label="Fusion" value={model ? `${model.fusion}, τ = ${model.tau_s} s` : '—'} />
          <DiagnosticRow label="Δv horizon" value={model ? `k = ${model.k}` : '—'} />
          <DiagnosticRow
            label="Parameters"
            value={model ? `${(model.n_params_delta_v + model.n_params_abs_v).toLocaleString()}` : '—'}
          />
          <DiagnosticRow
            label="Δv checkpoint"
            value={checkpointLine(model, 'delta_v')}
          />
          <DiagnosticRow label="Anchor checkpoint" value={checkpointLine(model, 'abs_v')} />
        </Card>
      </Section>

      <Section title="App">
        <Card style={{ gap: 2 }}>
          <DiagnosticRow label="Navigation mode" value={state.mode} />
          <DiagnosticRow label="Inference state" value={state.inference} />
          <DiagnosticRow label="Platform" value={`${Platform.OS} ${Platform.Version}`} />
          <DiagnosticRow
            label="Map renderer"
            value={mapProvider}
            status="READY"
          />
          <DiagnosticRow label="Map API key required" value="no" status="READY" />
          <DiagnosticRow label="Units" value={settings.units} />
        </Card>
        <Txt variant="caption" color="textSecondary">
          Maps come from MapLibre with OpenStreetMap tiles — no key, no billing. Basemap tiles are
          fetched over the network and cached; with no connection the overlays still draw over a
          plain background, and AI navigation is unaffected because inference is on-device.
        </Txt>
      </Section>

      <View style={{ alignItems: 'center', gap: Spacing.sm }}>
        <Badge label="model frozen" tone="ok" />
        <Txt variant="micro" color="textTertiary" style={{ textAlign: 'center' }}>
          The app reads the model's configuration; it cannot modify it.
        </Txt>
      </View>
    </Screen>
  );
}

function checkpointLine(model: ModelInfo | null, key: 'delta_v' | 'abs_v'): string {
  if (!model) return '—';
  const ck = model.checkpoints as Record<string, { file?: string; sha256?: string }>;
  const entry = ck[key];
  if (!entry?.file) return '—';
  return `${entry.file} · ${entry.sha256?.slice(0, 12) ?? '?'}`;
}
