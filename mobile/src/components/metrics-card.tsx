import { StyleSheet, View } from 'react-native';

import { Spacing } from '@/theme';
import { Card, Divider, Stat, type Tone } from './ui/primitives';

export interface MetricSpec {
  label: string;
  value: string;
  unit?: string;
  tone?: Tone;
}

/**
 * A grid of labelled numbers.
 *
 * Two per row by default so the figures stay large enough to read at a glance
 * while driving; three per row for denser analytics screens.
 */
export function MetricsCard({
  metrics,
  columns = 2,
  small,
}: {
  metrics: MetricSpec[];
  columns?: 2 | 3;
  small?: boolean;
}) {
  const width = `${100 / columns}%` as const;
  return (
    <Card style={{ gap: Spacing.lg }}>
      <View style={styles.grid}>
        {metrics.map((m) => (
          <View key={m.label} style={[styles.cell, { width }]}>
            <Stat label={m.label} value={m.value} unit={m.unit} tone={m.tone} small={small} />
          </View>
        ))}
      </View>
    </Card>
  );
}

/** Same grid without the card chrome, for use inside an existing card. */
export function MetricsGrid({ metrics, columns = 2, small }: { metrics: MetricSpec[]; columns?: 2 | 3; small?: boolean }) {
  const width = `${100 / columns}%` as const;
  return (
    <View style={styles.grid}>
      {metrics.map((m) => (
        <View key={m.label} style={[styles.cell, { width }]}>
          <Stat label={m.label} value={m.value} unit={m.unit} tone={m.tone} small={small} />
        </View>
      ))}
    </View>
  );
}

export { Divider };

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: Spacing.lg },
  cell: { paddingRight: Spacing.md },
});
