import { StyleSheet, View } from 'react-native';

import { Radius, Spacing, useColors } from '@/theme';
import { Row, Txt } from './ui/primitives';

export interface LegendEntry {
  label: string;
  color: string;
  dashed?: boolean;
}

/**
 * Map legend.
 *
 * Three trajectories on one map is the maximum a reader can follow, so the
 * legend is always visible when more than one is drawn — colour alone never
 * has to carry the meaning.
 */
export function MapLegend({ entries }: { entries: LegendEntry[] }) {
  const c = useColors();
  if (entries.length < 2) return null;
  return (
    <View
      accessible
      accessibilityLabel={`Map legend: ${entries.map((e) => e.label).join(', ')}`}
      style={[styles.wrap, { backgroundColor: c.overlay, borderColor: c.border }]}>
      {entries.map((e) => (
        <Row key={e.label} gap={6}>
          <View
            style={[
              styles.swatch,
              { backgroundColor: e.dashed ? 'transparent' : e.color, borderColor: e.color },
              e.dashed && styles.swatchDashed,
            ]}
          />
          <Txt variant="micro" color="textSecondary">
            {e.label}
          </Txt>
        </Row>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  swatch: { width: 14, height: 3, borderRadius: 2 },
  swatchDashed: { borderWidth: 1.5, borderStyle: 'dashed', height: 0 },
});
