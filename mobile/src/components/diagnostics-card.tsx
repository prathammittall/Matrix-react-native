import { StyleSheet, View } from 'react-native';

import { Radius, Spacing, useColors } from '@/theme';
import type { ComponentHealth, SystemHealth } from '@/types';
import { Card, Row, StatusDot, Txt, type Tone } from './ui/primitives';
import { IconChip, IconSatellite, IconWave } from './ui/icons';

export const HEALTH_TONE: Record<ComponentHealth, Tone> = {
  READY: 'ok',
  ACTIVE: 'ai',
  WARNING: 'warn',
  OFFLINE: 'danger',
};

/** Compact four-up system health card for the dashboard. */
export function SystemHealthCard({ health, detail }: { health: SystemHealth; detail?: Partial<Record<keyof SystemHealth, string>> }) {
  const items: { key: keyof SystemHealth; label: string; icon: React.ReactNode }[] = [
    { key: 'gnss', label: 'GNSS', icon: <IconSatellite size={16} color="textSecondary" /> },
    { key: 'imu', label: 'IMU', icon: <IconWave size={16} color="textSecondary" /> },
    { key: 'model', label: 'AI model', icon: <IconChip size={16} color="textSecondary" /> },
    { key: 'api', label: 'Inference API', icon: <IconChip size={16} color="textSecondary" /> },
  ];

  return (
    <Card style={{ gap: Spacing.md }}>
      <Txt variant="label" color="textSecondary">
        SYSTEM HEALTH
      </Txt>
      <View style={styles.grid}>
        {items.map((it) => (
          <HealthTile
            key={it.key}
            label={it.label}
            icon={it.icon}
            status={health[it.key]}
            detail={detail?.[it.key]}
          />
        ))}
      </View>
    </Card>
  );
}

function HealthTile({
  label,
  icon,
  status,
  detail,
}: {
  label: string;
  icon: React.ReactNode;
  status: ComponentHealth;
  detail?: string;
}) {
  const c = useColors();
  const tone = HEALTH_TONE[status];
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${status}${detail ? `. ${detail}` : ''}`}
      style={[styles.tile, { backgroundColor: c.surfaceSunken, borderColor: c.border }]}>
      <Row justify="space-between">
        {icon}
        <StatusDot tone={tone} size={8} />
      </Row>
      <Txt variant="caption" color="textSecondary" numberOfLines={1}>
        {label}
      </Txt>
      <Txt variant="label" style={{ color: c[tone] }} numberOfLines={1}>
        {status}
      </Txt>
      {detail ? (
        <Txt variant="micro" color="textTertiary" numberOfLines={1}>
          {detail}
        </Txt>
      ) : null}
    </View>
  );
}

/** A single diagnostics line: label, value, and a status dot. */
export function DiagnosticRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: ComponentHealth;
}) {
  const c = useColors();
  return (
    <Row justify="space-between" gap={Spacing.md} style={styles.row}>
      <Txt variant="body" color="textSecondary" style={{ flex: 1 }} numberOfLines={1}>
        {label}
      </Txt>
      <Row gap={Spacing.sm} style={{ flexShrink: 1 }}>
        <Txt variant="bodyStrong" tabular numberOfLines={1} style={{ textAlign: 'right' }}>
          {value}
        </Txt>
        {status ? <StatusDot tone={HEALTH_TONE[status]} size={8} /> : null}
      </Row>
    </Row>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  tile: {
    flexGrow: 1,
    flexBasis: '46%',
    gap: 3,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: { minHeight: 40 },
});
