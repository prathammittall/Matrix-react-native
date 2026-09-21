import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AIStatusCard } from '@/components/ai-status-card';
import { MapLegend } from '@/components/map-legend';
import { MatrixMap, type MapTrack, type MatrixMapHandle } from '@/components/matrix-map';
import { NavigationStatusBar } from '@/components/navigation-status';
import { OutageBanner } from '@/components/outage-banner';
import { SensorPanel } from '@/components/sensor-panel';
import {
  Button,
  Disclosure,
  IconCrosshair,
  IconLayers,
  IconButton,
  Row,
  Txt,
} from '@/components/ui';
import { MetricsCard } from '@/components/metrics-card';
import { BottomSheet } from '@/components/ui/sheet';
import { useEngine } from '@/hooks/use-engine';
import { useSettings } from '@/hooks/use-settings';
import { api } from '@/services/api';
import { formatDistance, formatDuration, formatSpeed } from '@/services/format';
import { engine } from '@/services/navigation-engine';
import { storage } from '@/services/storage';
import { Spacing, useColors } from '@/theme';
import type { ModelInfo } from '@/types';

const MAP_TYPES = ['standard', 'terrain'] as const;
const KEEP_AWAKE_TAG = 'matrix-navigation';

/**
 * Live navigation.
 *
 * Layout is map-first: the map fills the screen and everything else lives in a
 * draggable sheet, so the trajectory is never covered by more than it has to be.
 * The status bar floats at the top because the GNSS -> AI transition is the one
 * thing that must be visible at all times.
 */
export default function NavigateScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { settings, update } = useSettings();
  const state = useEngine();
  const mapRef = useRef<MatrixMapHandle>(null);

  const [starting, setStarting] = useState(false);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [following, setFollowing] = useState(settings.followVehicle);
  const lastMode = useRef(state.mode);

  // Hold the screen on only while a drive is actually running and the user
  // asked for it — an always-on `useKeepAwake` would drain the battery on every
  // other visit to this tab.
  useEffect(() => {
    const navigating = state.mode !== 'IDLE';
    if (!settings.keepAwake || !navigating) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [settings.keepAwake, state.mode]);

  useEffect(() => {
    api
      .modelInfo()
      .then(setModel)
      .catch(() => setModel(null));
  }, []);

  // Haptic + camera response to a mode change — the moment that matters most.
  useEffect(() => {
    if (state.mode === lastMode.current) return;
    const was = lastMode.current;
    lastMode.current = state.mode;
    if (settings.hapticsOnModeChange) {
      if (state.mode === 'DEAD_RECKONING') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } else if (state.mode === 'GNSS' && was === 'DEAD_RECKONING') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else if (state.mode === 'DEGRADED') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    }
  }, [state.mode, settings.hapticsOnModeChange]);

  // Keep the camera on the vehicle while following.
  useEffect(() => {
    if (!following || !state.position) return;
    mapRef.current?.center(state.position);
  }, [following, state.position]);

  const onStart = useCallback(async () => {
    setStarting(true);
    // where the frozen model runs is the user's choice; it takes effect here
    engine.setInferenceMode(settings.inferenceMode);
    engine.setMotionConstraints(settings.motionConstraints);
    const res = await engine.start();
    setStarting(false);
    if (res.error) Alert.alert('Navigation started with limits', res.error);
  }, [settings.inferenceMode, settings.motionConstraints]);

  const onStop = useCallback(async () => {
    const session = await engine.stop();
    if (session && (session.gnssPath.length > 1 || session.outages.length)) {
      await storage.saveSession(session);
      Alert.alert('Session saved', 'The drive is now available in History.', [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Open',
          onPress: () => router.push({ pathname: '/session/[id]', params: { id: session.id } }),
        },
      ]);
    }
  }, []);

  const navigating = state.mode !== 'IDLE';
  // Wall-clock, driven by the engine heartbeat. Reading `Date.now()` here
  // instead froze both clocks whenever the engine stopped emitting — which is
  // exactly what happens during an outage, the one time they matter.
  const outageSeconds = state.activeOutage ? state.outageElapsedS : null;
  const onAiSeconds =
    state.outages.reduce((a, o) => a + o.durationS, 0) + state.outageElapsedS;

  const tracks = useMemo<MapTrack[]>(() => {
    const out: MapTrack[] = [];
    if (settings.showGnssTrack && state.gnssPath.length > 1) {
      out.push({ id: 'gnss', points: state.gnssPath, color: c.trackGnss, width: 5 });
    }
    if (settings.showDrTrack && state.drPath.length > 1) {
      out.push({ id: 'dr', points: state.drPath, color: c.trackDr, width: 5, dashed: true });
    }
    return out;
  }, [settings.showGnssTrack, settings.showDrTrack, state.gnssPath, state.drPath, c]);

  const legend = useMemo(() => {
    const l = [];
    if (settings.showGnssTrack && state.gnssPath.length > 1)
      l.push({ label: 'GNSS track', color: c.trackGnss });
    if (settings.showDrTrack && state.drPath.length > 1)
      l.push({ label: 'AI dead reckoning', color: c.trackDr, dashed: true });
    return l;
  }, [settings.showGnssTrack, settings.showDrTrack, state.gnssPath.length, state.drPath.length, c]);

  const vehicleTone =
    state.mode === 'DEAD_RECKONING' ? c.ai : state.mode === 'DEGRADED' ? c.danger : c.accent;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <MatrixMap
        ref={mapRef}
        tracks={tracks}
        mapType={settings.mapStyle}
        followVehicle={following}
        onPanDrag={() => setFollowing(false)}
        accuracyM={state.mode === 'GNSS' ? (state.gnss.fix?.accuracy ?? null) : null}
        vehicle={
          // In DEGRADED there is no trustworthy position, but blanking the map
          // is worse than an honest stale one: the driver loses all context at
          // the exact moment they need it. Show the last position the app could
          // justify, in the danger tone, with the banner naming it as held.
          state.position ?? state.lastKnown
            ? {
                coordinate: (state.position ?? state.lastKnown)!,
                headingDeg: state.headingDeg,
                tone: vehicleTone,
                stale: state.mode === 'DEGRADED',
              }
            : null
        }
        markers={
          state.activeOutage
            ? [
                {
                  id: 'anchor',
                  coordinate: {
                    latitude: state.activeOutage.anchor.latitude,
                    longitude: state.activeOutage.anchor.longitude,
                  },
                  title: 'Last GNSS fix',
                  description: 'Anchor for the dead-reckoning estimate',
                  color: c.trackGnss,
                  hollow: true,
                },
              ]
            : []
        }
      />

      {/* floating top layer */}
      <View style={[styles.top, { paddingTop: insets.top + Spacing.sm }]} pointerEvents="box-none">
        <NavigationStatusBar
          mode={state.mode}
          gnssState={state.gnss.state}
          gnssReason={state.gnss.reason}
          speedMps={state.speedMps}
          headingDeg={state.headingDeg}
          outageSeconds={outageSeconds}
          units={settings.units}
        />
        {state.mode === 'DEAD_RECKONING' || state.mode === 'DEGRADED' ? (
          <OutageBanner
            visible
            mode={state.mode}
            seconds={state.activeOutage ? state.outageElapsedS : state.heldS}
            distanceM={state.activeOutage?.drDistanceM ?? 0}
            units={settings.units}
          />
        ) : null}
        <Row justify="space-between" style={{ marginTop: Spacing.xs }}>
          <MapLegend entries={legend} />
          <Row gap={Spacing.sm}>
            <IconButton
              label="Change map style"
              active={settings.mapStyle !== 'standard'}
              icon={<IconLayers size={20} color={settings.mapStyle !== 'standard' ? 'accent' : 'text'} />}
              onPress={() => {
                const i = MAP_TYPES.indexOf(settings.mapStyle);
                update('mapStyle', MAP_TYPES[(i + 1) % MAP_TYPES.length]);
              }}
            />
            <IconButton
              label={following ? 'Stop following the vehicle' : 'Follow the vehicle'}
              active={following}
              icon={<IconCrosshair size={20} color={following ? 'accent' : 'text'} />}
              onPress={() => {
                setFollowing((v) => !v);
                if (state.position) mapRef.current?.center(state.position);
              }}
            />
          </Row>
        </Row>
      </View>

      {/* bottom sheet */}
      <BottomSheet snapPoints={[188, 360, 620]} initialSnap={0}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: Spacing.md, paddingTop: Spacing.xs, paddingBottom: Spacing.xl }}>
          <Row gap={Spacing.md}>
            <Button
              label={navigating ? 'Stop' : 'Start Navigation'}
              variant={navigating ? 'danger' : 'primary'}
              loading={starting}
              onPress={navigating ? onStop : onStart}
              style={{ flex: 1 }}
              accessibilityHint={
                navigating
                  ? 'Ends the drive and saves it to history'
                  : 'Starts the IMU stream and GNSS tracking'
              }
            />
            {navigating ? (
              <Button
                label={engine.gnss.isSimulatingOutage ? 'Restore GNSS' : 'Simulate outage'}
                variant="secondary"
                onPress={() => engine.simulateOutage(!engine.gnss.isSimulatingOutage)}
                accessibilityHint="Suppresses GNSS fixes so the AI takes over. Used for demonstration."
              />
            ) : null}
          </Row>

          {/* Three numbers, always. A driver checking the screen at speed can
              read three; they cannot read nine. Everything else is one tap
              away and nothing is hidden — it is ranked. */}
          <MetricsCard
            columns={3}
            small
            metrics={[
              { label: 'Distance', value: formatDistance(state.distanceM, settings.units) },
              { label: 'Elapsed', value: navigating ? formatDuration(state.elapsedS) : '—' },
              { label: 'Speed', value: formatSpeed(state.speedMps, settings.units) },
            ]}
          />

          <Disclosure
            title="Drive detail"
            subtitle={`${state.outages.length} outage${state.outages.length === 1 ? '' : 's'} · ${formatDuration(onAiSeconds)} on AI`}>
            <MetricsCard
              columns={3}
              small
              metrics={[
                { label: 'Outages', value: String(state.outages.length) },
                {
                  label: 'On AI',
                  value: formatDuration(onAiSeconds),
                  tone: state.mode === 'DEAD_RECKONING' ? 'ai' : undefined,
                },
                { label: 'Windows', value: String(state.serviceState?.windows_inferred ?? 0) },
              ]}
            />
          </Disclosure>

          <Disclosure
            title="AI engine"
            subtitle={state.backendLabel ?? 'Frozen MATRIX model'}
            initiallyOpen={state.mode === 'DEAD_RECKONING' || state.mode === 'DEGRADED'}>
            <AIStatusCard
              state={state.inference}
              error={state.inferenceError}
              telemetry={state.telemetry}
              model={model}
              latencyMs={state.lastInferenceMs}
              windowFill={state.windowFill}
              windowRequired={state.windowRequired}
              showTechnical={settings.technicalDetails}
              backend={state.backend}
              backendLabel={state.backendLabel}
              offlineCapable={state.offlineCapable}
              fallbackReason={state.backendFallbackReason}
            />
          </Disclosure>

          <Disclosure title="Sensors" subtitle="GNSS receiver and live IMU channels">
            <SensorPanel
              gnss={state.gnss}
              telemetry={state.telemetry}
              velocityMps={state.speedMps}
              headingDeg={state.headingDeg}
            />
            <Txt variant="micro" color="textTertiary">
              Dead-reckoned positions come from the frozen MATRIX model running on this device.
              They are an estimate, not a measured fix.
            </Txt>
          </Disclosure>
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    top: 0,
    gap: Spacing.sm,
  },
});
