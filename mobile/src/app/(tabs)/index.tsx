import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { SystemHealthCard } from '@/components/diagnostics-card';
import { describeStatus } from '@/components/navigation-status';
import { Screen, ScreenHeader } from '@/components/screen';
import {
  Badge,
  Card,
  IconChevronRight,
  IconChip,
  IconHistory,
  IconNavigate,
  IconPlay,
  IconStethoscope,
  Row,
  Section,
  StatusDot,
  Txt,
} from '@/components/ui';
import { useEngine } from '@/hooks/use-engine';
import { useSettings } from '@/hooks/use-settings';
import { api } from '@/services/api';
import { formatDistance, formatDuration } from '@/services/format';
import { manifestMatchesFrozenContract, MANIFEST } from '@/services/ondevice-inference';
import { SensorService } from '@/services/sensors';
import { storage } from '@/services/storage';
import { Radius, Spacing, useColors } from '@/theme';
import type { ComponentHealth, HealthStatus, NavigationSession, SystemHealth } from '@/types';

/**
 * Dashboard.
 *
 * The one screen that answers "is the system ready, and what do I do next?".
 * It polls health on focus only — nothing here runs while the screen is not
 * visible.
 */
export default function DashboardScreen() {
  const c = useColors();
  const { settings } = useSettings();
  const engine = useEngine();

  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [sensors, setSensors] = useState({ accelerometer: false, gyroscope: false });
  const [sessions, setSessions] = useState<NavigationSession[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [h, avail, hist] = await Promise.allSettled([
      api.health(),
      SensorService.availability(),
      storage.loadSessions(),
    ]);
    if (h.status === 'fulfilled') {
      setHealth(h.value);
      setHealthError(null);
    } else {
      setHealth(null);
      setHealthError(h.reason instanceof Error ? h.reason.message : 'Inference service unreachable');
    }
    if (avail.status === 'fulfilled') setSensors(avail.value);
    if (hist.status === 'fulfilled') setSessions(hist.value);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const imuOk = sensors.accelerometer && sensors.gyroscope;
  const apiState: ComponentHealth = health ? (health.status === 'ok' ? 'READY' : 'WARNING') : 'OFFLINE';
  // The on-device models ship inside the app, so the model is READY whether or
  // not a backend is reachable — that is the point of running it offline.
  const localModelOk = settings.inferenceMode !== 'service' && manifestMatchesFrozenContract();
  const health4: SystemHealth = {
    gnss:
      engine.gnss.state === 'ACTIVE'
        ? 'ACTIVE'
        : engine.gnss.state === 'WEAK'
          ? 'WARNING'
          : engine.gnss.state === 'UNAVAILABLE'
            ? 'OFFLINE'
            : 'WARNING',
    imu: engine.mode !== 'IDLE' ? 'ACTIVE' : imuOk ? 'READY' : 'OFFLINE',
    model:
      engine.mode === 'DEAD_RECKONING'
        ? 'ACTIVE'
        : localModelOk || health?.model_loaded
          ? 'READY'
          : 'OFFLINE',
    api: apiState,
  };

  const status = describeStatus(engine.mode, engine.gnss.state, engine.gnss.reason);
  const recent = sessions[0];

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />
      }>
      <ScreenHeader
        title="MATRIX"
        subtitle="AI dead reckoning for GNSS-denied navigation"
        large
        right={<Badge label={engine.mode === 'IDLE' ? 'standby' : 'live'} tone={engine.mode === 'IDLE' ? 'idle' : 'ok'} />}
      />

      {/* current status */}
      <Card style={{ gap: Spacing.md }} raised>
        <Row justify="space-between">
          <Txt variant="label" color="textSecondary">
            CURRENT STATUS
          </Txt>
          <Row gap={Spacing.sm}>
            <StatusDot tone={status.tone} pulse={status.ai} />
            <Txt variant="label" style={{ color: c[status.tone] }}>
              {status.label}
            </Txt>
          </Row>
        </Row>
        <Txt variant="body" color="textSecondary">
          {status.detail}
        </Txt>
        {engine.mode === 'IDLE' ? (
          <Txt variant="caption" color="textTertiary">
            Start navigation to stream the IMU to the frozen model and see the AI take over when
            GNSS drops.
          </Txt>
        ) : null}
      </Card>

      {/* quick actions */}
      <Section title="Quick actions">
        <View style={styles.actions}>
          <Action
            title="Start Navigation"
            caption="Live GNSS + AI dead reckoning"
            icon={<IconNavigate size={20} tint={c.accent} />}
            primary
            onPress={() => router.push('/navigate')}
          />
          <Action
            title="Demo Mode"
            caption="Replay a recorded drive with a real outage"
            icon={<IconPlay size={20} tint={c.ai} />}
            onPress={() => router.push('/demo')}
          />
          <Action
            title="History"
            caption={
              sessions.length
                ? `${sessions.length} saved session${sessions.length === 1 ? '' : 's'}`
                : 'No sessions yet'
            }
            icon={<IconHistory size={20} tint={c.textSecondary} />}
            onPress={() => router.push('/history')}
          />
          <Action
            title="System Diagnostics"
            caption="Sensors, permissions, model, latency"
            icon={<IconStethoscope size={20} tint={c.textSecondary} />}
            onPress={() => router.push('/diagnostics')}
          />
        </View>
      </Section>

      <Section title="System health">
        <SystemHealthCard
          health={health4}
          detail={{
            gnss: engine.gnss.fix ? `${engine.gnss.fix.accuracy?.toFixed(0) ?? '—'} m` : 'no fix',
            imu: imuOk ? 'acc + gyro' : 'unavailable',
            model: localModelOk
              ? 'on device'
              : health?.device
                ? health.device.toUpperCase()
                : 'not loaded',
            api: health ? `${health.active_sessions} session(s)` : 'unreachable',
          }}
        />
        {healthError && !localModelOk ? (
          <Card style={{ borderColor: `${c.danger}55` }}>
            <Row gap={Spacing.sm}>
              <IconChip size={18} tint={c.danger} />
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="bodyStrong" style={{ color: c.danger }}>
                  AI service unavailable
                </Txt>
                <Txt variant="caption" color="textSecondary">
                  {healthError}. Live navigation will still show GNSS, but dead reckoning cannot
                  run. Switch Settings → AI inference to &quot;On device&quot;, or check the backend
                  URL.
                </Txt>
              </View>
            </Row>
          </Card>
        ) : localModelOk ? (
          <Card>
            <Row gap={Spacing.sm}>
              <IconChip size={18} tint={c.ok} />
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="bodyStrong">Dead reckoning runs on this phone</Txt>
                <Txt variant="caption" color="textSecondary">
                  The frozen model is bundled in the app ({MANIFEST.features.length}-channel input,
                  τ = {MANIFEST.tau_s} s). No network is needed for navigation or Demo Mode.
                </Txt>
              </View>
            </Row>
          </Card>
        ) : null}
      </Section>

      {recent ? (
        <Section
          title="Last session"
          action={
            <Pressable onPress={() => router.push('/history')} accessibilityRole="button" accessibilityLabel="See all sessions">
              <Txt variant="caption" style={{ color: c.accent }}>
                See all
              </Txt>
            </Pressable>
          }>
          <Card>
            <Pressable
              onPress={() => router.push({ pathname: '/session/[id]', params: { id: recent.id } })}
              accessibilityRole="button"
              accessibilityLabel="Open last session">
              <Row justify="space-between">
                <View style={{ gap: 2, flex: 1 }}>
                  <Txt variant="bodyStrong">
                    {formatDistance(recent.distanceM, settings.units)} ·{' '}
                    {formatDuration(recent.durationS)}
                  </Txt>
                  <Txt variant="caption" color="textSecondary">
                    {recent.outages.length} outage{recent.outages.length === 1 ? '' : 's'} ·{' '}
                    {formatDuration(recent.totalOutageS)} on AI
                  </Txt>
                </View>
                <IconChevronRight color="textTertiary" />
              </Row>
            </Pressable>
          </Card>
        </Section>
      ) : null}
    </Screen>
  );
}

function Action({
  title,
  caption,
  icon,
  onPress,
  primary,
}: {
  title: string;
  caption: string;
  icon: React.ReactNode;
  onPress: () => void;
  primary?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={caption}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: pressed ? c.surfaceRaised : c.surface,
          borderColor: primary ? `${c.accent}66` : c.border,
        },
      ]}>
      <View style={[styles.actionGlyph, { backgroundColor: primary ? c.accentSoft : c.surfaceSunken }]}>
        {icon}
      </View>
      <View style={{ gap: 2 }}>
        <Txt variant="bodyStrong" numberOfLines={1}>
          {title}
        </Txt>
        <Txt variant="micro" color="textTertiary" numberOfLines={2}>
          {caption}
        </Txt>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  action: {
    flexGrow: 1,
    flexBasis: '46%',
    minHeight: 116,
    padding: Spacing.lg,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  actionGlyph: {
    width: 38,
    height: 38,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
