import { useEffect, useRef, type ReactNode } from 'react';
import { ActivityIndicator, Animated, StyleSheet, View } from 'react-native';

import { Radius, Spacing, useColors } from '@/theme';
import { Button } from './controls';
import { Card, Txt } from './primitives';

export function EmptyState({
  title,
  message,
  action,
  icon,
}: {
  title: string;
  message: string;
  action?: { label: string; onPress: () => void };
  icon?: ReactNode;
}) {
  return (
    <Card style={styles.centered} raised>
      {icon}
      <Txt variant="heading" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      <Txt variant="body" color="textSecondary" style={{ textAlign: 'center' }}>
        {message}
      </Txt>
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" /> : null}
    </Card>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const c = useColors();
  return (
    <Card style={[styles.centered, { borderColor: `${c.danger}55` }]} raised>
      <View style={[styles.errorDot, { backgroundColor: `${c.danger}22` }]}>
        <Txt variant="heading" style={{ color: c.danger }}>
          !
        </Txt>
      </View>
      <Txt variant="heading" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      <Txt variant="body" color="textSecondary" style={{ textAlign: 'center' }}>
        {message}
      </Txt>
      {onRetry ? <Button label={retryLabel} onPress={onRetry} variant="secondary" /> : null}
    </Card>
  );
}

export function LoadingState({ message = 'Loading…' }: { message?: string }) {
  const c = useColors();
  return (
    <View style={styles.centered} accessibilityRole="progressbar" accessibilityLabel={message}>
      <ActivityIndicator color={c.accent} />
      <Txt variant="caption" color="textSecondary">
        {message}
      </Txt>
    </View>
  );
}

/** Shimmering placeholder used while a screen's real content is loading. */
export function Skeleton({ height = 16, width = '100%', radius = Radius.sm }: {
  height?: number;
  width?: number | `${number}%`;
  radius?: number;
}) {
  const c = useColors();
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ height, width, borderRadius: radius, backgroundColor: c.surfaceSunken, opacity: pulse }}
    />
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <Card style={{ gap: Spacing.md }}>
      <Skeleton height={20} width="55%" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? '70%' : '100%'} />
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    padding: Spacing.xl,
  },
  errorDot: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
