import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Radius, Spacing, useColors } from '@/theme';
import { useSensorSnapshot } from '@/hooks/use-engine';
import { FROZEN } from '@/services/config';
import type { GnssStatus, MlTelemetry } from '@/types';
import { Card, Divider, Row, Txt } from './ui/primitives';
import { Collapsible } from './ui/sheet';

/**
 * Live sensor dashboard.
 *
 * Mounted collapsed. The raw IMU values are polled from the ring buffer only
 * while this panel is expanded (`useSensorSnapshot(open)`), so a collapsed panel
 * costs nothing and an expanded one costs four renders a second rather than ten.
 */
export function SensorPanel({
  gnss,
  telemetry,
  velocityMps,
  headingDeg,
  defaultOpen = false,
}: {
  gnss: GnssStatus;
  telemetry: MlTelemetry | null;
  velocityMps: number | null;
  headingDeg: number | null;
  defaultOpen?: boolean;
}) {
  const c = useColors();
  const [open, setOpen] = useState(defaultOpen);
  const snap = useSensorSnapshot(open);
  const rateOk = snap.rateHz >= FROZEN.SAMPLE_RATE_HZ - 1;

  return (
    <Card>
      <Collapsible
        title="Sensors"
        subtitle={
          snap.running
            ? `IMU ${snap.rateHz} Hz · ${snap.count.toLocaleString()} samples`
            : 'IMU stream stopped'
        }
        defaultOpen={defaultOpen}
        onToggle={setOpen}
        right={
          <View
            style={[
              styles.pill,
              {
                backgroundColor: snap.running ? (rateOk ? `${c.ok}1F` : `${c.warn}1F`) : c.surfaceSunken,
              },
            ]}>
            <Txt variant="micro" style={{ color: snap.running ? (rateOk ? c.ok : c.warn) : c.textTertiary }}>
              {snap.running ? `${snap.rateHz} HZ` : 'OFF'}
            </Txt>
          </View>
        }>
        <View style={{ gap: Spacing.lg }}>
          <Group title="Accelerometer" unit="m/s²">
            <Axis label="X" value={snap.acc.x * 9.80665} />
            <Axis label="Y" value={snap.acc.y * 9.80665} />
            <Axis label="Z" value={snap.acc.z * 9.80665} />
          </Group>

          <Divider />

          <Group title="Gyroscope" unit="rad/s">
            <Axis label="X" value={snap.gyro.x} digits={3} />
            <Axis label="Y" value={snap.gyro.y} digits={3} />
            <Axis label="Z" value={snap.gyro.z} digits={3} />
          </Group>

          <Divider />

          <Group title="GNSS" unit={gnss.state.toLowerCase()}>
            <Pair label="Latitude" value={gnss.fix ? gnss.fix.latitude.toFixed(6) : '—'} />
            <Pair label="Longitude" value={gnss.fix ? gnss.fix.longitude.toFixed(6) : '—'} />
            <Pair
              label="Speed"
              value={gnss.fix?.speed != null ? `${gnss.fix.speed.toFixed(1)} m/s` : '—'}
            />
            <Pair
              label="Accuracy"
              value={gnss.fix?.accuracy != null ? `${gnss.fix.accuracy.toFixed(0)} m` : '—'}
            />
            <Pair
              label="Satellites"
              value={gnss.satellites != null ? String(gnss.satellites) : 'not reported'}
            />
            <Pair label="Fix age" value={gnss.fix ? `${gnss.age.toFixed(1)} s` : '—'} />
          </Group>

          <Divider />

          <Group title="Model output" unit="frozen">
            <Pair label="Δv (0.5 s)" value={telemetry ? `${telemetry.delta_v.toFixed(3)} m/s` : '—'} />
            <Pair label="Yaw rate" value={telemetry ? `${telemetry.yaw_rate.toFixed(3)} rad/s` : '—'} />
            <Pair
              label="Estimated velocity"
              value={velocityMps != null ? `${velocityMps.toFixed(2)} m/s` : '—'}
            />
            <Pair label="Heading" value={headingDeg != null ? `${headingDeg.toFixed(0)}°` : '—'} />
          </Group>
        </View>
      </Collapsible>
    </Card>
  );
}

function Group({ title, unit, children }: { title: string; unit: string; children: ReactNode }) {
  return (
    <View style={{ gap: Spacing.sm }}>
      <Row justify="space-between">
        <Txt variant="label" color="textSecondary">
          {title}
        </Txt>
        <Txt variant="micro" color="textTertiary">
          {unit.toUpperCase()}
        </Txt>
      </Row>
      <View style={styles.grid}>{children}</View>
    </View>
  );
}

function Axis({ label, value, digits = 2 }: { label: string; value: number; digits?: number }) {
  const c = useColors();
  const magnitude = Math.min(Math.abs(value) / (digits === 3 ? 2 : 12), 1);
  return (
    <View style={styles.axis} accessible accessibilityLabel={`${label}: ${value.toFixed(digits)}`}>
      <Row justify="space-between">
        <Txt variant="micro" color="textTertiary">
          {label}
        </Txt>
        <Txt variant="caption" tabular>
          {value >= 0 ? ' ' : ''}
          {value.toFixed(digits)}
        </Txt>
      </Row>
      <View style={[styles.meterTrack, { backgroundColor: c.surfaceSunken }]}>
        <View
          style={[
            styles.meterFill,
            { width: `${magnitude * 100}%`, backgroundColor: value >= 0 ? c.accent : c.warn },
          ]}
        />
      </View>
    </View>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.pair}>
      <Txt variant="micro" color="textTertiary" numberOfLines={1}>
        {label.toUpperCase()}
      </Txt>
      <Txt variant="caption" tabular numberOfLines={1}>
        {value}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: Spacing.sm, columnGap: Spacing.md },
  axis: { flex: 1, minWidth: 74, gap: 4 },
  pair: { width: '47%', gap: 2 },
  meterTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2 },
  pill: { paddingHorizontal: Spacing.sm, paddingVertical: 2, borderRadius: Radius.pill },
});
