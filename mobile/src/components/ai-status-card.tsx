import { StyleSheet, View } from 'react-native';

import { Radius, Spacing, useColors } from '@/theme';
import { FROZEN } from '@/services/config';
import type { BackendKind } from '@/services/inference-backend';
import { MANIFEST } from '@/services/ondevice-inference';
import type { InferenceState, ModelInfo, MlTelemetry } from '@/types';
import { Badge, Card, Divider, Row, StatusDot, Txt, type Tone } from './ui/primitives';
import { Collapsible } from './ui/sheet';
import { IconChip } from './ui/icons';

const TONE: Record<InferenceState, Tone> = {
  IDLE: 'idle',
  WARMING: 'warn',
  READY: 'ok',
  ERROR: 'warn',
  OFFLINE: 'danger',
};

const LABEL: Record<InferenceState, string> = {
  IDLE: 'Idle',
  WARMING: 'Filling window',
  READY: 'Active',
  ERROR: 'Retrying',
  OFFLINE: 'Unavailable',
};

/**
 * The AI panel.
 *
 * The top half is written for a driver — what the AI is, and whether it is
 * working. Everything a judge or engineer would want (checkpoint hashes, tau,
 * window semantics, latency) is behind "Technical details", off by default.
 */
export function AIStatusCard({
  state,
  error,
  telemetry,
  model,
  latencyMs,
  windowFill,
  windowRequired,
  showTechnical,
  backend = null,
  backendLabel = null,
  offlineCapable = false,
  fallbackReason = null,
}: {
  state: InferenceState;
  error: string | null;
  telemetry: MlTelemetry | null;
  model: ModelInfo | null;
  latencyMs: number | null;
  windowFill: number;
  windowRequired: number;
  showTechnical: boolean;
  backend?: BackendKind | null;
  backendLabel?: string | null;
  offlineCapable?: boolean;
  fallbackReason?: string | null;
}) {
  const c = useColors();
  const tone = TONE[state];

  return (
    <Card style={{ gap: Spacing.md }}>
      <Row justify="space-between">
        <Row gap={Spacing.sm}>
          <View style={[styles.glyph, { backgroundColor: c.accentSoft }]}>
            <IconChip size={18} tint={c.accent} />
          </View>
          <View style={{ gap: 1 }}>
            <Txt variant="bodyStrong">AI Navigation</Txt>
            <Txt variant="caption" color="textSecondary">
              {model?.name ?? 'MATRIX DR'} ·{' '}
              {backend === 'ONDEVICE'
                ? 'on this phone'
                : backend === 'SERVICE'
                  ? `service · ${model?.device?.toUpperCase() ?? 'cpu'}`
                  : 'not started'}
            </Txt>
          </View>
        </Row>
        <Row gap={Spacing.sm}>
          <StatusDot tone={tone} />
          <Txt variant="label" style={{ color: c[tone] }}>
            {LABEL[state]}
          </Txt>
        </Row>
      </Row>

      {backend ? (
        <Row gap={Spacing.sm}>
          <Badge label={offlineCapable ? 'works offline' : 'needs network'} tone={offlineCapable ? 'ok' : 'warn'} />
          <Txt variant="caption" color="textSecondary" style={{ flex: 1 }} numberOfLines={1}>
            {backendLabel}
          </Txt>
        </Row>
      ) : null}

      {fallbackReason ? (
        <View style={[styles.notice, { backgroundColor: `${c.warn}14`, borderColor: `${c.warn}44` }]}>
          <Txt variant="caption" style={{ color: c.warn }}>
            On-device models unavailable, using the service instead — {fallbackReason}
          </Txt>
        </View>
      ) : null}

      {error ? (
        <View style={[styles.notice, { backgroundColor: `${c.danger}14`, borderColor: `${c.danger}44` }]}>
          <Txt variant="caption" style={{ color: c.danger }}>
            {state === 'OFFLINE' ? 'AI service unavailable' : 'AI service degraded'} — {error}
          </Txt>
        </View>
      ) : null}

      {state === 'WARMING' && windowRequired > 0 ? (
        <Txt variant="caption" color="textSecondary">
          Collecting the {windowRequired}-sample window — {windowFill}/{windowRequired}
        </Txt>
      ) : null}

      <Divider />

      <View style={styles.grid}>
        <Field label="Input" value="6-axis IMU" />
        <Field label="Prediction" value="Δv + yaw rate" />
        <Field label="Fusion" value="Complementary" />
        <Field label="τ" value={`${model?.tau_s ?? FROZEN.TAU_S} s`} />
      </View>

      {telemetry ? (
        <>
          <Divider />
          <View style={styles.grid}>
            <Field label="Δv (0.5 s)" value={`${telemetry.delta_v.toFixed(3)} m/s`} mono />
            <Field label="Yaw rate" value={`${telemetry.yaw_rate.toFixed(3)} rad/s`} mono />
            <Field
              label="Velocity anchor"
              value={`${telemetry.v_abs_pred.toFixed(2)} m/s`}
              mono
            />
            <Field label="Latency" value={latencyMs === null ? '—' : `${latencyMs.toFixed(1)} ms`} mono />
          </View>
        </>
      ) : null}

      {showTechnical ? (
        <>
          <Divider />
          <Collapsible
            title="Technical details"
            subtitle="Frozen model configuration"
            right={<Badge label="frozen" tone="ok" />}>
            <View style={{ gap: Spacing.sm }}>
              <Tech label="Window" value={`${model?.window_samples ?? FROZEN.WINDOW_SAMPLES} samples × 6 channels, causal`} />
              <Tech label="Rate" value={`${model?.sampling_rate_hz ?? FROZEN.SAMPLE_RATE_HZ} Hz (dt = ${model?.dt_s ?? 0.1} s)`} />
              <Tech label="Features" value={(model?.features ?? [...FROZEN.FEATURES]).join(', ')} />
              <Tech label="Δv horizon" value={`k = ${model?.k ?? FROZEN.K} (0.5 s)`} />
              <Tech label="Filter" value={`v ← (1−dt/τ)(v+Δv/k) + (dt/τ)·v_abs, τ = ${model?.tau_s ?? FROZEN.TAU_S} s`} />
              <Tech
                label="Parameters"
                value={
                  model
                    ? `${model.n_params_delta_v.toLocaleString()} (Δv) + ${model.n_params_abs_v.toLocaleString()} (anchor)`
                    : '—'
                }
              />
              <Tech label="Checkpoints" value={checkpointSummary(model)} />
              {backend === 'ONDEVICE' ? (
                <>
                  <Tech
                    label="On-device graphs"
                    value={`${MANIFEST.delta_v.file} (${MANIFEST.delta_v.onnx_sha256.slice(0, 8)}), ${MANIFEST.abs_v.file} (${MANIFEST.abs_v.onnx_sha256.slice(0, 8)}) · opset ${MANIFEST.opset}`}
                  />
                  <Tech
                    label="Export verified"
                    value={`max |onnx − torch| = ${Math.max(
                      ...Object.values(MANIFEST.verification.results).map((r) => r.max_abs_diff),
                    ).toExponential(2)} (tolerance ${MANIFEST.verification.tolerance.toExponential(0)})`}
                  />
                </>
              ) : null}
              <Txt variant="caption" color="textTertiary">
                Model, scaler, feature order and fusion are frozen. The app adapts to them; it
                cannot change them.
              </Txt>
            </View>
          </Collapsible>
        </>
      ) : null}
    </Card>
  );
}

function checkpointSummary(model: ModelInfo | null): string {
  if (!model) return '—';
  const ck = model.checkpoints as Record<string, { file?: string; sha256?: string }>;
  const dv = ck.delta_v;
  const abs = ck.abs_v;
  if (!dv?.file) return '—';
  return `${dv.file} (${dv.sha256?.slice(0, 8) ?? '?'}), ${abs?.file ?? '?'} (${abs?.sha256?.slice(0, 8) ?? '?'})`;
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.cell}>
      <Txt variant="micro" color="textTertiary">
        {label.toUpperCase()}
      </Txt>
      <Txt variant="bodyStrong" tabular={mono} numberOfLines={1}>
        {value}
      </Txt>
    </View>
  );
}

function Tech({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Txt variant="micro" color="textTertiary">
        {label.toUpperCase()}
      </Txt>
      <Txt variant="caption" color="textSecondary">
        {value}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  glyph: { width: 34, height: 34, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: Spacing.md },
  cell: { width: '50%', gap: 2, paddingRight: Spacing.sm },
  notice: { padding: Spacing.sm, borderRadius: Radius.sm, borderWidth: StyleSheet.hairlineWidth },
});
