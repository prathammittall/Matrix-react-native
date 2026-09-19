import { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextProps, type ViewStyle } from 'react-native';

import { Elevation, Radius, Spacing, Type, useColors, type ThemeColors } from '@/theme';

type TypeKey = keyof typeof Type;
type ColorKey = keyof ThemeColors;

export type TxtProps = TextProps & {
  variant?: TypeKey;
  color?: ColorKey;
  /** number rendering that must not reflow as digits change */
  tabular?: boolean;
};

/** The single text primitive. Every string in the app goes through it. */
export function Txt({ variant = 'body', color = 'text', tabular, style, ...rest }: TxtProps) {
  const c = useColors();
  return (
    <Text
      style={[
        Type[variant] as object,
        { color: c[color] },
        tabular && { fontVariant: ['tabular-nums'] },
        style,
      ]}
      {...rest}
    />
  );
}

export function Card({
  children,
  style,
  padded = true,
  raised = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  raised?: boolean;
}) {
  const c = useColors();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: raised ? c.surfaceRaised : c.surface,
          borderColor: c.border,
        },
        raised && Elevation.card,
        padded && { padding: Spacing.lg },
        style,
      ]}>
      {children}
    </View>
  );
}

export function Section({
  title,
  action,
  children,
  style,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ gap: Spacing.md }, style]}>
      <View style={styles.sectionHead}>
        <Txt variant="label" color="textSecondary" accessibilityRole="header">
          {title.toUpperCase()}
        </Txt>
        {action}
      </View>
      {children}
    </View>
  );
}

export function Row({
  children,
  gap = Spacing.md,
  align = 'center',
  justify = 'flex-start',
  style,
}: {
  children: ReactNode;
  gap?: number;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ flexDirection: 'row', gap, alignItems: align, justifyContent: justify }, style]}>
      {children}
    </View>
  );
}

export function Divider() {
  const c = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

export type Tone = 'ok' | 'warn' | 'danger' | 'ai' | 'idle' | 'accent';

export function Badge({ label, tone = 'idle' }: { label: string; tone?: Tone }) {
  const c = useColors();
  const color = c[tone];
  return (
    <View
      style={[styles.badge, { backgroundColor: `${color}1F`, borderColor: `${color}55` }]}
      accessible
      accessibilityLabel={label}>
      <Txt variant="micro" style={{ color }}>
        {label.toUpperCase()}
      </Txt>
    </View>
  );
}

/** Status dot. Always rendered beside a text label — never colour alone. */
export function StatusDot({ tone, size = 10, pulse = false }: { tone: Tone; size?: number; pulse?: boolean }) {
  const c = useColors();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: c[tone],
        borderWidth: pulse ? size / 2.5 : 0,
        borderColor: `${c[tone]}33`,
      }}
    />
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
  height = 6,
  label,
}: {
  /** 0..1 */
  value: number;
  tone?: Tone;
  height?: number;
  label?: string;
}) {
  const c = useColors();
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
      style={{ height, borderRadius: height / 2, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}>
      <View style={{ width: `${pct * 100}%`, height, backgroundColor: c[tone] }} />
    </View>
  );
}

/** A labelled number. The workhorse of every metrics card. */
export function Stat({
  label,
  value,
  unit,
  tone,
  small,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: Tone;
  small?: boolean;
}) {
  const c = useColors();
  return (
    <View style={{ gap: 2, flexShrink: 1 }} accessible accessibilityLabel={`${label}: ${value}${unit ? ` ${unit}` : ''}`}>
      <Txt variant="micro" color="textTertiary" numberOfLines={1}>
        {label.toUpperCase()}
      </Txt>
      <Row gap={4} align="baseline">
        <Txt
          variant={small ? 'metricSm' : 'metric'}
          tabular
          style={tone ? { color: c[tone] } : undefined}>
          {value}
        </Txt>
        {unit ? (
          <Txt variant="caption" color="textSecondary">
            {unit}
          </Txt>
        ) : null}
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
  badge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
});
