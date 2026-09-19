import { router } from 'expo-router';
import { type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { HIT_SLOP, MIN_TOUCH, Radius, Spacing, useColors } from '@/theme';
import { Row, Txt } from './ui/primitives';

/** Standard screen frame: safe area, background, consistent horizontal gutter. */
export function Screen({
  children,
  scroll = true,
  style,
  contentStyle,
  edges = ['top'],
  refreshControl,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl'];
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  if (!scroll) {
    return (
      <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: c.background }, style]}>
        {children}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: c.background }, style]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Spacing.xxxl + insets.bottom },
          contentStyle,
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  back,
  right,
  large,
}: {
  title: string;
  subtitle?: string;
  back?: boolean;
  right?: ReactNode;
  large?: boolean;
}) {
  const c = useColors();
  return (
    <Row justify="space-between" gap={Spacing.md} style={styles.header}>
      <Row gap={Spacing.md} style={{ flex: 1 }}>
        {back ? (
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={({ pressed }) => [
              styles.back,
              { borderColor: c.border, backgroundColor: pressed ? c.surfaceRaised : c.surface },
            ]}>
            <View style={[styles.chevron, { borderRightColor: c.text }]} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant={large ? 'display' : 'title'} accessibilityRole="header" numberOfLines={1}>
            {title}
          </Txt>
          {subtitle ? (
            <Txt variant="caption" color="textSecondary" numberOfLines={2}>
              {subtitle}
            </Txt>
          ) : null}
        </View>
      </Row>
      {right}
    </Row>
  );
}

export const SCREEN_GUTTER = Spacing.lg;

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    gap: Spacing.xl,
  },
  header: { minHeight: MIN_TOUCH },
  back: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: {
    width: 0,
    height: 0,
    marginLeft: -3,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderRightWidth: 7,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
});
