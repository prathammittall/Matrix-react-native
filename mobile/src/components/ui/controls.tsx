import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Switch,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { HIT_SLOP, MIN_TOUCH, Radius, Spacing, useColors } from '@/theme';
import { IconChevronDown, IconChevronRight } from './icons';
import { Row, Txt, type Tone } from './primitives';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  fullWidth,
  style,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const c = useColors();
  const bg = {
    primary: c.accent,
    secondary: c.surfaceRaised,
    ghost: 'transparent',
    danger: c.danger,
  }[variant];
  const fg = variant === 'primary' || variant === 'danger' ? '#FFFFFF' : c.text;
  const borderColor = variant === 'secondary' || variant === 'ghost' ? c.border : 'transparent';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor, opacity: disabled ? 0.45 : pressed ? 0.82 : 1 },
        fullWidth && { alignSelf: 'stretch' },
        style,
      ]}>
      {loading ? <ActivityIndicator color={fg} size="small" /> : icon}
      <Txt variant="bodyStrong" style={{ color: fg }}>
        {label}
      </Txt>
    </Pressable>
  );
}

export function IconButton({
  label,
  icon,
  onPress,
  active,
}: {
  label: string;
  icon: ReactNode;
  onPress: () => void;
  active?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      style={({ pressed }) => [
        styles.iconButton,
        {
          backgroundColor: active ? c.accentSoft : c.surface,
          borderColor: active ? c.accent : c.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}>
      {icon}
    </Pressable>
  );
}

export function ListRow({
  title,
  subtitle,
  right,
  onPress,
  tone,
  first,
  last,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  tone?: Tone;
  first?: boolean;
  last?: boolean;
}) {
  const c = useColors();
  const body = (
    <Row justify="space-between" gap={Spacing.md} style={styles.listRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="body" style={tone ? { color: c[tone] } : undefined}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt variant="caption" color="textSecondary">
            {subtitle}
          </Txt>
        ) : null}
      </View>
      {right}
    </Row>
  );

  const radius = {
    borderTopLeftRadius: first ? Radius.lg : 0,
    borderTopRightRadius: first ? Radius.lg : 0,
    borderBottomLeftRadius: last ? Radius.lg : 0,
    borderBottomRightRadius: last ? Radius.lg : 0,
  };

  if (!onPress) {
    return <View style={[{ backgroundColor: c.surface }, radius]}>{body}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      style={({ pressed }) => [{ backgroundColor: pressed ? c.surfaceRaised : c.surface }, radius]}>
      {body}
    </Pressable>
  );
}

export function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
  first,
  last,
  disabled,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  first?: boolean;
  last?: boolean;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      first={first}
      last={last}
      right={
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          accessibilityLabel={title}
          trackColor={{ true: c.accent, false: c.borderStrong }}
          thumbColor="#FFFFFF"
        />
      }
    />
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  const c = useColors();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={[styles.segment, { backgroundColor: c.surfaceSunken, borderColor: c.border }]}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={o.label}
            style={[
              styles.segmentItem,
              selected && { backgroundColor: c.surfaceRaised, borderColor: c.borderStrong },
            ]}>
            <Txt variant="caption" color={selected ? 'text' : 'textSecondary'} numberOfLines={1}>
              {o.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: MIN_TOUCH,
    paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.md,
  },
  button: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  iconButton: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listRow: {
    minHeight: MIN_TOUCH + 8,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  segment: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 3,
  },
  segmentItem: {
    flex: 1,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
    paddingHorizontal: Spacing.xs,
  },
});

/**
 * Progressive disclosure.
 *
 * The navigation screen has one job while the vehicle is moving: say where it
 * is and which source says so. Everything else — raw IMU channels, inference
 * latency, window fill, backend identity — is diagnostic detail that a driver
 * never needs and an engineer always does. Putting it behind a disclosure lets
 * both be true without two builds of the app.
 *
 * Collapsed content is not rendered at all, so a closed section costs nothing
 * per frame. That matters here: the panels inside re-render at 4 Hz.
 */
export function Disclosure({
  title,
  subtitle,
  children,
  initiallyOpen = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  initiallyOpen?: boolean;
}) {
  const c = useColors();
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <View style={{ gap: Spacing.md }}>
      <Pressable
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        accessibilityHint={open ? 'Collapses this section' : 'Expands this section'}
        hitSlop={HIT_SLOP}
        style={({ pressed }) => [
          styles.disclosure,
          { borderColor: c.border, opacity: pressed ? 0.6 : 1 },
        ]}>
        <View style={{ flex: 1, gap: 1 }}>
          <Txt variant="label">{title}</Txt>
          {subtitle ? (
            <Txt variant="caption" color="textTertiary" numberOfLines={1}>
              {subtitle}
            </Txt>
          ) : null}
        </View>
        {open ? <IconChevronDown size={18} color="textSecondary" /> : <IconChevronRight size={18} color="textSecondary" />}
      </Pressable>
      {open ? <View style={{ gap: Spacing.md }}>{children}</View> : null}
    </View>
  );
}
