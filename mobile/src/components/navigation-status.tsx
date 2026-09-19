import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { Radius, Spacing, useColors } from '@/theme';
import { formatClock, formatSpeed } from '@/services/format';
import type { Units } from '@/services/storage';
import type { GnssState, NavigationMode } from '@/types';
import { Row, StatusDot, Txt, type Tone } from './ui/primitives';

export interface StatusDescriptor {
  label: string;
  detail: string;
  tone: Tone;
  /** true while the AI is producing the position */
  ai: boolean;
}

/**
 * The single source of truth for what the status indicator says.
 *
 * Pure, so the four states in the spec can be asserted directly in tests and
 * cannot drift between the navigation screen, the dashboard and the tab badge.
 */
export function describeStatus(
  mode: NavigationMode,
  gnss: GnssState,
  gnssReason: string,
): StatusDescriptor {
  if (mode === 'DEAD_RECKONING') {
    return { label: 'AI DEAD RECKONING', detail: 'Active — GNSS unavailable', tone: 'ai', ai: true };
  }
  if (mode === 'DEGRADED') {
    return {
      label: 'POSITION UNAVAILABLE',
      detail: 'GNSS lost and the AI service is unavailable',
      tone: 'danger',
      ai: false,
    };
  }
  if (mode === 'IDLE') {
    return { label: 'STANDBY', detail: 'Navigation not started', tone: 'idle', ai: false };
  }
  if (gnss === 'ACTIVE') return { label: 'GNSS ACTIVE', detail: gnssReason, tone: 'ok', ai: false };
  if (gnss === 'WEAK') return { label: 'GNSS WEAK', detail: gnssReason, tone: 'warn', ai: false };
  if (gnss === 'OUTAGE') return { label: 'GNSS OUTAGE', detail: gnssReason, tone: 'danger', ai: false };
  return { label: 'GNSS UNAVAILABLE', detail: gnssReason, tone: 'idle', ai: false };
}

/**
 * The prominent navigation status banner.
 *
 * The mode change is the most important event in the product, so it gets a
 * colour, a label, a moving indicator and — during dead reckoning — the live
 * numbers that justify the position being shown.
 */
export function NavigationStatusBar({
  mode,
  gnssState,
  gnssReason,
  speedMps,
  headingDeg,
  outageSeconds,
  units,
}: {
  mode: NavigationMode;
  gnssState: GnssState;
  gnssReason: string;
  speedMps: number | null;
  headingDeg: number | null;
  outageSeconds: number | null;
  units: Units;
}) {
  const c = useColors();
  const status = describeStatus(mode, gnssState, gnssReason);
  const color = c[status.tone];
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!status.ai) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status.ai, pulse]);

  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`Navigation status: ${status.label}. ${status.detail}`}
      style={[styles.bar, { backgroundColor: c.surface, borderColor: `${color}66` }]}>
      <Animated.View
        style={[
          styles.stripe,
          { backgroundColor: color, opacity: status.ai ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) : 1 },
        ]}
      />
      <View style={styles.content}>
        <Row justify="space-between" gap={Spacing.md}>
          <Row gap={Spacing.sm} style={{ flex: 1 }}>
            <StatusDot tone={status.tone} size={9} pulse={status.ai} />
            <Txt variant="label" style={{ color, flexShrink: 1 }} numberOfLines={1}>
              {status.label}
            </Txt>
          </Row>
          {outageSeconds !== null ? (
            <Txt variant="label" tabular style={{ color }}>
              {formatClock(outageSeconds)}
            </Txt>
          ) : null}
        </Row>
        <Txt variant="caption" color="textSecondary" numberOfLines={1}>
          {status.detail}
        </Txt>
        {mode === 'GNSS' || mode === 'DEAD_RECKONING' ? (
          <Row gap={Spacing.xl} style={{ marginTop: 2 }}>
            <Metric label="Speed" value={formatSpeed(speedMps, units)} />
            <Metric
              label="Heading"
              value={headingDeg === null ? '—' : `${Math.round(headingDeg)}°`}
            />
            <Metric label="Source" value={status.ai ? 'AI model' : 'GNSS'} />
          </Row>
        ) : null}
      </View>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 1 }}>
      <Txt variant="micro" color="textTertiary">
        {label.toUpperCase()}
      </Txt>
      <Txt variant="bodyStrong" tabular>
        {value}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  stripe: { width: 4 },
  content: { flex: 1, padding: Spacing.md, gap: 3 },
});
