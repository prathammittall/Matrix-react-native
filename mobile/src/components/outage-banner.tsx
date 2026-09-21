import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { Radius, Spacing, useColors } from '@/theme';
import { formatClock, formatDistance } from '@/services/format';
import type { Units } from '@/services/storage';
import { Row, Txt } from './ui/primitives';
import { IconWarning } from './ui/icons';

/**
 * The banner that appears the moment GNSS drops.
 *
 * It slides in from the top and states plainly which of the two things has
 * happened: the AI has taken over, or there is no position at all.
 */
export function OutageBanner({
  visible,
  mode,
  seconds,
  distanceM,
  units,
}: {
  visible: boolean;
  mode: 'DEAD_RECKONING' | 'DEGRADED';
  seconds: number;
  distanceM: number;
  units: Units;
}) {
  const c = useColors();
  const slide = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(slide, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      damping: 18,
      stiffness: 180,
    }).start();
  }, [visible, slide]);

  const ai = mode === 'DEAD_RECKONING';
  const tone = ai ? c.ai : c.danger;

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      accessibilityLiveRegion="assertive"
      style={[
        styles.wrap,
        {
          backgroundColor: c.surface,
          borderColor: `${tone}77`,
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) }],
        },
      ]}>
      <View style={[styles.glyph, { backgroundColor: `${tone}1F` }]}>
        <IconWarning size={18} tint={tone} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="label" style={{ color: tone }}>
          {ai ? 'GNSS LOST — AI DEAD RECKONING ACTIVE' : 'GNSS LOST — POSITION HELD'}
        </Txt>
        <Txt variant="caption" color="textSecondary">
          {ai
            ? `Position estimated from IMU for ${formatClock(seconds)} · ${formatDistance(distanceM, units)}`
            : `Showing the last known position, ${formatClock(seconds)} ago. The AI could not take over.`}
        </Txt>
      </View>
      {ai || seconds > 0 ? (
        <Row gap={0} style={{ alignItems: 'flex-end', flexDirection: 'column' }}>
          <Txt variant="metricSm" tabular style={{ color: tone }}>
            {formatClock(seconds)}
          </Txt>
        </Row>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  glyph: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
