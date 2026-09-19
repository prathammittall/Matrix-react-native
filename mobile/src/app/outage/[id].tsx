import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { BarChart } from '@/components/charts';
import { MapLegend } from '@/components/map-legend';
import { MatrixMap, type MapTrack } from '@/components/matrix-map';
import { MetricsGrid } from '@/components/metrics-card';
import { Screen, ScreenHeader } from '@/components/screen';
import { Badge, Card, Divider, EmptyState, Row, Section, SkeletonCard, Txt } from '@/components/ui';
import { useSettings } from '@/hooks/use-settings';
import { api } from '@/services/api';
import { formatDistance, formatDuration, formatSigned } from '@/services/format';
import { regionFor } from '@/services/track';
import { storage } from '@/services/storage';
import { Spacing, useColors } from '@/theme';
import type { OutageEvent } from '@/types';

/**
 * Outage analytics.
 *
 * Two different things are shown and they are labelled as such:
 *   1. what happened in THIS outage (measured on this device), and
 *   2. the frozen benchmark from the research test split, which is where the
 *      10/30/60/120/300 s numbers come from and which is explicitly not a
 *      promise about this device.
 */
export default function OutageDetailScreen() {
  const c = useColors();
  const { settings } = useSettings();
  const { id, sessionId } = useLocalSearchParams<{ id: string; sessionId: string }>();

  const [outage, setOutage] = useState<OutageEvent | null | undefined>(undefined);
  const [benchmark, setBenchmark] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    void storage.loadSessions().then((all) => {
      const s = all.find((x) => x.id === sessionId);
      setOutage(s?.outages.find((o) => o.id === id) ?? null);
    });
  }, [id, sessionId]);

  useEffect(() => {
    api
      .benchmarks()
      .then((b) => {
        const v = (b as { validation_median_final_err_by_outage?: Record<string, number> })
          .validation_median_final_err_by_outage;
        setBenchmark(v ?? null);
      })
      .catch(() => setBenchmark(null));
  }, []);

  const tracks = useMemo<MapTrack[]>(() => {
    if (!outage || outage.path.length < 2) return [];
    return [{ id: 'dr', points: outage.path, color: c.trackDr, width: 5, dashed: true }];
  }, [outage, c]);

  if (outage === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Outage" back />
        <SkeletonCard lines={3} />
      </Screen>
    );
  }

  if (outage === null) {
    return (
      <Screen>
        <ScreenHeader title="Outage" back />
        <EmptyState
          title="Outage not found"
          message="The session it belonged to may have been deleted."
          action={{ label: 'Back to history', onPress: () => router.replace('/history') }}
        />
      </Screen>
    );
  }

  const points = [
    ...outage.path,
    { latitude: outage.anchor.latitude, longitude: outage.anchor.longitude },
    ...(outage.recovery ? [outage.recovery] : []),
  ];

  return (
    <Screen scroll={false}>
      <View style={{ paddingHorizontal: Spacing.lg }}>
        <ScreenHeader
          title={`Outage · ${formatDuration(outage.durationS)}`}
          subtitle={new Date(outage.startedAt).toLocaleString()}
          back
          right={outage.degraded ? <Badge label="degraded" tone="danger" /> : <Badge label="AI DR" tone="ai" />}
        />
      </View>

      {tracks.length ? (
        <View style={styles.mapWrap}>
          <MatrixMap
            tracks={tracks}
            initialRegion={regionFor(points)}
            mapType={settings.mapStyle}
            followVehicle={false}
            markers={[
              {
                id: 'anchor',
                coordinate: { latitude: outage.anchor.latitude, longitude: outage.anchor.longitude },
                title: 'Last GNSS fix',
                description: `Anchor speed ${outage.anchor.speed_mps.toFixed(1)} m/s`,
                color: c.trackGnss,
                hollow: true,
              },
              ...(outage.estimated
                ? [
                    {
                      id: 'estimated',
                      coordinate: outage.estimated,
                      title: 'AI estimate at recovery',
                      color: c.trackDr,
                    },
                  ]
                : []),
              ...(outage.recovery
                ? [
                    {
                      id: 'recovered',
                      coordinate: outage.recovery,
                      title: 'Recovered GNSS fix',
                      description:
                        outage.recoveryErrorM != null
                          ? `${outage.recoveryErrorM.toFixed(0)} m from the estimate`
                          : undefined,
                      color: c.trackTruth,
                    },
                  ]
                : []),
            ]}
          />
          <View style={styles.legend} pointerEvents="box-none">
            <MapLegend
              entries={[
                { label: 'AI dead reckoning', color: c.trackDr, dashed: true },
                { label: 'Recovered GNSS', color: c.trackTruth },
              ]}
            />
          </View>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.xl, paddingBottom: Spacing.xxxl }}
        showsVerticalScrollIndicator={false}>
        {outage.degraded ? (
          <Card style={{ borderColor: `${c.danger}55` }}>
            <Txt variant="bodyStrong" style={{ color: c.danger }}>
              No estimate was produced
            </Txt>
            <Txt variant="caption" color="textSecondary">
              GNSS was lost while the inference service was unavailable, so the app showed no
              position rather than an unverified one.
            </Txt>
          </Card>
        ) : null}

        <Section title="This outage">
          <Card>
            <MetricsGrid
              columns={2}
              small
              metrics={[
                { label: 'GNSS outage', value: formatDuration(outage.durationS) },
                { label: 'AI DR distance', value: formatDistance(outage.drDistanceM, settings.units) },
                {
                  label: 'Recovery error',
                  value:
                    outage.recoveryErrorM != null
                      ? formatDistance(outage.recoveryErrorM, settings.units)
                      : 'no GNSS recovery',
                  tone: 'ai',
                },
                {
                  label: 'Heading drift',
                  value: formatSigned(outage.headingErrorDeg, 1, '°'),
                },
                {
                  label: 'Drift rate',
                  value:
                    outage.recoveryErrorM != null && outage.durationS > 0
                      ? `${((outage.recoveryErrorM / outage.durationS) * 60).toFixed(0)} m/min`
                      : '—',
                },
                { label: 'Anchor speed', value: `${outage.anchor.speed_mps.toFixed(1)} m/s` },
              ]}
            />
            <Divider />
            <Txt variant="micro" color="textTertiary">
              Recovery error is the distance between the AI&apos;s estimated position at the moment
              GNSS returned and the first recovered fix. The recovered fix carries its own accuracy,
              so this is an approximate check, not a laboratory measurement.
            </Txt>
          </Card>
        </Section>

        {benchmark ? (
          <Section title="Benchmark reference">
            <Card style={{ gap: Spacing.md }}>
              <Row justify="space-between">
                <Txt variant="bodyStrong">Median final error by outage length</Txt>
                <Badge label="research" tone="idle" />
              </Row>
              <BarChart
                unit="m"
                bars={Object.entries(benchmark)
                  .sort((a, b) => Number(a[0]) - Number(b[0]))
                  .map(([k, v]) => ({
                    label: `${k}s`,
                    value: v,
                    color: Math.abs(Number(k) - outage.durationS) < 15 ? c.ai : c.accent,
                  }))}
              />
              <Txt variant="micro" color="textTertiary">
                Measured on the held-out research split (one unseen driver, one phone, one vehicle)
                with a ground-truth velocity anchor. These are benchmark results, not a guarantee of
                accuracy on this device, and they are not comparable one-to-one with the figure
                above, which uses a live GNSS anchor.
              </Txt>
            </Card>
          </Section>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mapWrap: { height: 260, marginTop: Spacing.md },
  legend: { position: 'absolute', left: Spacing.lg, bottom: Spacing.md },
});
