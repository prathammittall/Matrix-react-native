import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, RefreshControl, View } from 'react-native';

import { Screen, ScreenHeader } from '@/components/screen';
import { SessionCard } from '@/components/session-card';
import { Button, Card, EmptyState, IconHistory, Section, SkeletonCard, Txt } from '@/components/ui';
import { MetricsGrid } from '@/components/metrics-card';
import { useSettings } from '@/hooks/use-settings';
import { formatDistance, formatDuration, formatPercent } from '@/services/format';
import { storage } from '@/services/storage';
import { Spacing, useColors } from '@/theme';
import type { NavigationSession } from '@/types';

/** Navigation history: every saved drive, newest first, with lifetime totals. */
export default function HistoryScreen() {
  const c = useColors();
  const { settings } = useSettings();
  const [sessions, setSessions] = useState<NavigationSession[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setSessions(await storage.loadSessions());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const totals = useMemo(() => {
    const list = sessions ?? [];
    const duration = list.reduce((a, s) => a + s.durationS, 0);
    const outage = list.reduce((a, s) => a + s.totalOutageS, 0);
    return {
      distance: list.reduce((a, s) => a + s.distanceM, 0),
      duration,
      outage,
      outages: list.reduce((a, s) => a + s.outages.length, 0),
      availability: duration > 0 ? 1 - outage / duration : 1,
      longest: list.reduce((a, s) => Math.max(a, s.longestOutageS), 0),
    };
  }, [sessions]);

  const confirmClear = () =>
    Alert.alert('Clear history?', 'All saved sessions will be deleted from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete all',
        style: 'destructive',
        onPress: async () => {
          await storage.clearSessions();
          await load();
        },
      },
    ]);

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
          tintColor={c.accent}
        />
      }>
      <ScreenHeader
        title="History"
        subtitle={
          sessions === null
            ? undefined
            : `${sessions.length} session${sessions.length === 1 ? '' : 's'} stored on this device`
        }
      />

      {sessions === null ? (
        <View style={{ gap: Spacing.md }}>
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </View>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<IconHistory size={32} color="textTertiary" />}
          title="No sessions yet"
          message="Finish a live navigation run and it will be saved here with its outage statistics."
          action={{ label: 'Start navigating', onPress: () => router.push('/navigate') }}
        />
      ) : (
        <>
          <Section title="Lifetime">
            <Card>
              <MetricsGrid
                columns={3}
                small
                metrics={[
                  { label: 'Distance', value: formatDistance(totals.distance, settings.units) },
                  { label: 'Driving', value: formatDuration(totals.duration) },
                  { label: 'GNSS uptime', value: formatPercent(totals.availability) },
                  { label: 'Outages', value: String(totals.outages) },
                  { label: 'On AI', value: formatDuration(totals.outage), tone: 'ai' },
                  { label: 'Longest', value: formatDuration(totals.longest) },
                ]}
              />
            </Card>
          </Section>

          <Section title="Sessions">
            <Card padded={false}>
              {sessions.map((s, i) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  units={settings.units}
                  first={i === 0}
                  last={i === sessions.length - 1}
                  onPress={() => router.push({ pathname: '/session/[id]', params: { id: s.id } })}
                />
              ))}
            </Card>
          </Section>

          <Button label="Clear history" variant="ghost" onPress={confirmClear} />
          <Txt variant="micro" color="textTertiary" style={{ textAlign: 'center' }}>
            Sessions are stored only on this device. Nothing is uploaded.
          </Txt>
        </>
      )}
    </Screen>
  );
}
