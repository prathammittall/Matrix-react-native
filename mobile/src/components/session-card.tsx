import { Pressable, StyleSheet, View } from 'react-native';

import { Radius, Spacing, useColors } from '@/theme';
import { formatDate, formatDistance, formatDuration, formatPercent, formatTime } from '@/services/format';
import type { Units } from '@/services/storage';
import type { NavigationSession } from '@/types';
import { Badge, ProgressBar, Row, Txt } from './ui/primitives';
import { IconChevronRight } from './ui/icons';

/**
 * One row in History.
 *
 * The GNSS-availability bar is the point of the card: at a glance you can see
 * how much of the drive the AI was carrying.
 */
export function SessionCard({
  session,
  units,
  onPress,
  first,
  last,
}: {
  session: NavigationSession;
  units: Units;
  onPress: () => void;
  first?: boolean;
  last?: boolean;
}) {
  const c = useColors();
  const drShare = session.durationS > 0 ? session.totalOutageS / session.durationS : 0;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Session on ${formatDate(session.startedAt)}, ${formatDistance(session.distanceM, units)}, ${session.outages.length} outages`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? c.surfaceRaised : c.surface,
          borderColor: c.border,
          borderTopLeftRadius: first ? Radius.lg : 0,
          borderTopRightRadius: first ? Radius.lg : 0,
          borderBottomLeftRadius: last ? Radius.lg : 0,
          borderBottomRightRadius: last ? Radius.lg : 0,
        },
      ]}>
      <Row justify="space-between" gap={Spacing.md}>
        <View style={{ flex: 1, gap: 2 }}>
          <Row gap={Spacing.sm}>
            <Txt variant="bodyStrong">{formatDate(session.startedAt)}</Txt>
            <Txt variant="caption" color="textTertiary">
              {formatTime(session.startedAt)}
            </Txt>
            {session.source === 'DEMO' ? <Badge label="demo" tone="ai" /> : null}
          </Row>
          <Txt variant="caption" color="textSecondary">
            {formatDistance(session.distanceM, units)} · {formatDuration(session.durationS)} ·{' '}
            {session.outages.length} outage{session.outages.length === 1 ? '' : 's'}
          </Txt>
        </View>
        <IconChevronRight color="textTertiary" />
      </Row>

      <View style={{ gap: 6 }}>
        <ProgressBar
          value={session.gnssAvailability}
          tone={session.gnssAvailability > 0.9 ? 'ok' : session.gnssAvailability > 0.6 ? 'warn' : 'danger'}
          label={`GNSS availability ${formatPercent(session.gnssAvailability)}`}
        />
        <Row justify="space-between">
          <Txt variant="micro" color="textTertiary">
            GNSS {formatPercent(session.gnssAvailability)}
          </Txt>
          <Txt variant="micro" style={{ color: drShare > 0 ? c.ai : c.textTertiary }}>
            AI DR {formatDuration(session.totalOutageS)}
            {session.longestOutageS > 0 ? ` · longest ${formatDuration(session.longestOutageS)}` : ''}
          </Txt>
        </Row>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.lg,
    gap: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
