import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  LayoutAnimation,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  UIManager,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Elevation, HIT_SLOP, Radius, Spacing, useColors } from '@/theme';
import { Row, Txt } from './primitives';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * A draggable bottom sheet with discrete snap points.
 *
 * Built on RN's own Animated + PanResponder rather than a gesture library so it
 * behaves identically on every platform the app targets and adds no dependency.
 * The drag runs on the native driver, so it stays smooth while the map and the
 * sensor stream are both busy.
 */
export function BottomSheet({
  children,
  snapPoints,
  initialSnap = 0,
  onSnapChange,
  style,
}: {
  children: ReactNode;
  /** heights in points, smallest first */
  snapPoints: number[];
  initialSnap?: number;
  onSnapChange?: (index: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const points = useMemo(() => [...snapPoints].sort((a, b) => a - b), [snapPoints]);
  const [index, setIndex] = useState(Math.min(initialSnap, points.length - 1));
  const height = useRef(new Animated.Value(points[Math.min(initialSnap, points.length - 1)])).current;
  const current = useRef(points[Math.min(initialSnap, points.length - 1)]);

  const snapTo = (i: number) => {
    const clamped = Math.max(0, Math.min(points.length - 1, i));
    setIndex(clamped);
    onSnapChange?.(clamped);
    current.current = points[clamped];
    Animated.spring(height, {
      toValue: points[clamped],
      useNativeDriver: false,
      damping: 22,
      stiffness: 220,
      mass: 0.7,
    }).start();
  };

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6,
      onPanResponderMove: (_, g) => {
        const next = Math.max(points[0], Math.min(points[points.length - 1], current.current - g.dy));
        height.setValue(next);
      },
      onPanResponderRelease: (_, g) => {
        const target = current.current - g.dy - g.vy * 90;
        let best = 0;
        for (let i = 1; i < points.length; i += 1) {
          if (Math.abs(points[i] - target) < Math.abs(points[best] - target)) best = i;
        }
        snapTo(best);
      },
    }),
  ).current;

  return (
    <Animated.View
      style={[
        styles.sheet,
        Elevation.sheet,
        { height, backgroundColor: c.surface, borderColor: c.border },
        style,
      ]}>
      <View {...responder.panHandlers} style={styles.grabArea}>
        <Pressable
          onPress={() => snapTo(index >= points.length - 1 ? 0 : index + 1)}
          hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={index >= points.length - 1 ? 'Collapse panel' : 'Expand panel'}>
          <View style={[styles.grabber, { backgroundColor: c.borderStrong }]} />
        </Pressable>
      </View>
      <View style={styles.sheetBody}>{children}</View>
    </Animated.View>
  );
}

export function Collapsible({
  title,
  subtitle,
  right,
  children,
  defaultOpen = false,
  onToggle,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  const c = useColors();
  const [open, setOpen] = useState(defaultOpen);
  const spin = useRef(new Animated.Value(defaultOpen ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(spin, { toValue: open ? 1 : 0, duration: 180, useNativeDriver: true }).start();
  }, [open, spin]);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));
    setOpen((v) => {
      onToggle?.(!v);
      return !v;
    });
  };

  return (
    <View>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        accessibilityHint={open ? 'Collapses this section' : 'Expands this section'}
        style={({ pressed }) => [styles.collapseHead, { opacity: pressed ? 0.75 : 1 }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="bodyStrong">{title}</Txt>
          {subtitle ? (
            <Txt variant="caption" color="textSecondary">
              {subtitle}
            </Txt>
          ) : null}
        </View>
        <Row gap={Spacing.sm}>
          {right}
          <Animated.View
            style={{
              transform: [
                { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) },
              ],
            }}>
            <View style={[styles.chevron, { borderTopColor: c.textSecondary }]} />
          </Animated.View>
        </Row>
      </Pressable>
      {open ? <View style={{ paddingTop: Spacing.md }}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  grabArea: {
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xs,
    alignItems: 'center',
  },
  grabber: { width: 38, height: 4, borderRadius: 2 },
  sheetBody: { flex: 1, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg },
  collapseHead: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: Spacing.md,
  },
  chevron: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});
