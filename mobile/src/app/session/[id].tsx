import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';

import { MapLegend } from '@/components/map-legend';
import { MatrixMap, type MapTrack, type MatrixMapHandle } from '@/components/matrix-map';
import { MetricsGrid } from '@/components/metrics-card';
import { Screen, ScreenHeader } from '@/components/screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconChevronRight,
  ListRow,
  Section,
  SkeletonCard,
  Txt,
} from '@/components/ui';
import { useSettings } from '@/hooks/use-settings';
import {
  formatDate,
  formatDistance,
  formatDuration,
  formatPercent,
  formatSpeed,
  formatTime,
} from '@/services/format';
import { regionFor } from '@/services/track';
import { storage } from '@/services/storage';
import { Spacing, useColors } from '@/theme';
import type { NavigationSession } from '@/types';

/** One saved drive: its trajectory on the map, its totals, and its outages. */
export default function SessionDetailScreen() {
  const c = useColors();
  const { settings } = useSettings();
  const { id } = useLocalSearchParams<{ id: string }>();
  const mapRef = useRef<MatrixMapHandle>(null);
  const [session, setSession] = useState<NavigationSession | null | undefined>(undefined);

  useEffect(() => {
    void storage.loadSessions().then((all) => setSession(all.find((s) => s.id === id) ?? null));
  }, [id]);

  const tracks = useMemo<MapTrack[]>(() => {
    if (!session) return [];
    const out: MapTrack[] = [];
    if (session.gnssPath.length > 1)
      out.push({ id: 'gnss', points: session.gnssPath, color: c.trackGnss, width: 5 });
    if (session.drPath.length > 1)
      out.push({ id: 'dr', points: session.drPath, color: c.trackDr, width: 5, dashed: true });
    return out;
  }, [session, c]);

  const region = useMemo(
    () => (session ? regionFor([...session.gnssPath, ...session.drPath]) : null),
    [session],
  );

  if (session === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Session" back />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={3} />
      </Screen>
    );
  }

  if (session === null) {
    return (
      <Screen>
        <ScreenHeader title="Session" back />
        <EmptyState
          title="Session not found"
          message="It may have been deleted from this device."
          action={{ label: 'Back to history', onPress: () => router.replace('/history') }}
        />
      </Screen>
    );
  }

  const remove = () =>
    Alert.alert('Delete session?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await storage.deleteSession(session.id);
          router.replace('/history');
        },
      },
    ]);

  return (
    <Screen scroll={false}>
      <View style={{ paddingHorizontal: Spacing.lg }}>
        <ScreenHeader
          title={formatDate(session.startedAt)}
          subtitle={`${formatTime(session.startedAt)} · ${formatDistance(session.distanceM, settings.units)} · ${formatDuration(session.durationS)}`}
          back
          right={session.source === 'DEMO' ? <Badge label="demo" tone="ai" /> : undefined}
        />
      </View>

      <View style={styles.mapWrap}>
        {tracks.length ? (
          <>
            <MatrixMap
              ref={mapRef}
              tracks={tracks}
              initialRegion={region}
              mapType={settings.mapStyle}
              followVehicle={false}
              markers={session.outages.flatMap((o, i) => [
                {
                  id: `start-${o.id}`,
                  coordinate: { latitude: o.anchor.latitude, longitude: o.anchor.longitude },
                  title: `Outage ${i + 1} start`,
                  description: `Last GNSS fix before ${formatDuration(o.durationS)} of dead reckoning`,
                  color: c.trackGnss,
                  hollow: true,
                },
                ...(o.recovery
                  ? [
                      {
                        id: `end-${o.id}`,
                        coordinate: o.recovery,
                        title: `Outage ${i + 1} recovery`,
                        description:
                          o.recoveryErrorM != null
                            ? `${o.recoveryErrorM.toFixed(0)} m from the AI estimate`
                            : 'GNSS returned',
                        color: c.trackTruth,
                      },
                    ]
                  : []),
              ])}
            />
            <View style={styles.legend} pointerEvents="box-none">
              <MapLegend
                entries={[
                  { label: 'GNSS', color: c.trackGnss },
                  { label: 'AI dead reckoning', color: c.trackDr, dashed: true },
                ]}
              />
            </View>
          </>
        ) : (
          <View style={[styles.noMap, { backgroundColor: c.surfaceSunken }]}>
            <Txt variant="caption" color="textTertiary">
              No track was recorded for this session
            </Txt>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.xl, paddingBottom: Spacing.xxxl }}
        showsVerticalScrollIndicator={false}>
        <Section title="Summary">
          <Card>
            <MetricsGrid
              columns={3}
              small
              metrics={[
                { label: 'Distance', value: formatDistance(session.distanceM, settings.units) },
                { label: 'Duration', value: formatDuration(session.durationS) },
                { label: 'Avg speed', value: formatSpeed(session.avgSpeedMps, settings.units) },
                {
                  label: 'GNSS uptime',
                  value: formatPercent(session.gnssAvailability),
                  tone: session.gnssAvailability > 0.9 ? 'ok' : 'warn',
                },
                { label: 'On AI', value: formatDuration(session.totalOutageS), tone: 'ai' },
                { label: 'Longest outage', value: formatDuration(session.longestOutageS) },
              ]}
            />
          </Card>
        </Section>

        <Section title={`Outages (${session.outages.length})`}>
          {session.outages.length === 0 ? (
            <Card>
              <Txt variant="body" color="textSecondary">
                GNSS was available for the whole drive — the AI never had to take over.
              </Txt>
            </Card>
          ) : (
            <Card padded={false}>
              {session.outages.map((o, i) => (
                <ListRow
                  key={o.id}
                  first={i === 0}
                  last={i === session.outages.length - 1}
                  title={`Outage ${i + 1} · ${formatDuration(o.durationS)}`}
                  subtitle={
                    o.degraded
                      ? 'Dead reckoning unavailable — no estimate recorded'
                      : `${formatDistance(o.drDistanceM, settings.units)} dead reckoned${
                          o.recoveryErrorM != null
                            ? ` · ${o.recoveryErrorM.toFixed(0)} m recovery error`
                            : ''
                        }`
                  }
                  right={<IconChevronRight color="textTertiary" />}
                  onPress={() =>
                    router.push({
                      pathname: '/outage/[id]',
                      params: { id: o.id, sessionId: session.id },
                    })
                  }
                />
              ))}
            </Card>
          )}
        </Section>

        <Section title="Inference">
          <Card>
            <MetricsGrid
              columns={2}
              small
              metrics={[
                { label: 'Windows inferred', value: session.windowsInferred.toLocaleString() },
                { label: 'Max speed', value: formatSpeed(session.maxSpeedMps, settings.units) },
              ]}
            />
          </Card>
        </Section>

        <Button label="Delete session" variant="ghost" onPress={remove} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mapWrap: { height: 280, marginTop: Spacing.md },
  legend: { position: 'absolute', left: Spacing.lg, bottom: Spacing.md },
  noMap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
