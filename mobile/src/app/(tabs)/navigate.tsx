import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AIStatusCard } from '@/components/ai-status-card';
import { GuidanceBanner, TripSummaryBar } from '@/components/guidance-banner';
import { MapLegend } from '@/components/map-legend';
import { MatrixMap, type MapMarkerSpec, type MapTrack, type MatrixMapHandle } from '@/components/matrix-map';
import { NavigationStatusBar } from '@/components/navigation-status';
import { OutageBanner } from '@/components/outage-banner';
import { RoutePlanner } from '@/components/route-planner';
import { SensorPanel } from '@/components/sensor-panel';
import {
  Button,
  Card,
  IconCrosshair,
  IconLayers,
  IconButton,
  Row,
  Txt,
} from '@/components/ui';
import { MetricsCard } from '@/components/metrics-card';
import { BottomSheet } from '@/components/ui/sheet';
import { useEngine } from '@/hooks/use-engine';
import { useRouteGuidance, useSmoothVehicle } from '@/hooks/use-guidance';
import { useSettings } from '@/hooks/use-settings';
import { useVoiceGuidance } from '@/hooks/use-voice-guidance';
import { api } from '@/services/api';
import { formatDistance, formatDuration, formatSpeed } from '@/services/format';
import { splitRoute } from '@/services/guidance';
import { engine } from '@/services/navigation-engine';
import { storage, type Units } from '@/services/storage';
import { stopSpeaking } from '@/services/voice';
import { Spacing, useColors } from '@/theme';
import type { GuidanceState, ModelInfo, Route } from '@/types';

const MAP_TYPES = ['standard', 'terrain'] as const;
const KEEP_AWAKE_TAG = 'matrix-navigation';

/**
 * Live navigation.
 *
 * Layout is map-first: the map fills the screen and everything else lives in a
 * draggable sheet, so the trajectory is never covered by more than it has to be.
 * The status bar floats at the top because the GNSS -> AI transition is the one
 * thing that must be visible at all times.
 *
 * With a route loaded the screen becomes turn-by-turn: the manoeuvre banner
 * takes the top slot and the engine's status bar moves under it. Nothing about
 * the guidance layer changes when GNSS drops — it reads `state.position`, and
 * the engine has already switched that field to the dead-reckoned estimate — so
 * the handover costs one frame and the instruction never blanks.
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

  const trip = useRouteGuidance(state);
  const { route, guidance } = trip;
  const announced = useRef<number | null>(null);

  // The drawn position is eased between updates so the puck glides instead of
  // hopping once a second. It only ever moves towards a position the engine has
  // published — nothing on screen is extrapolated ahead of the data.
  const vehicle = useSmoothVehicle(state.position, state.headingDeg, state.mode !== 'IDLE');

  useVoiceGuidance(route, guidance, state.mode, settings.units, settings.voiceGuidance);

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

  // One buzz as a manoeuvre comes up, once per manoeuvre. Especially useful
  // during an outage, when the driver has a reason to be watching the road
  // rather than the screen.
  useEffect(() => {
    if (!guidance?.nextStep || !settings.hapticsOnModeChange) return;
    const index = guidance.nextStep.index;
    if (guidance.distanceToManeuverM > 120) {
      if (announced.current === index) announced.current = null;
      return;
    }
    if (announced.current === index) return;
    announced.current = index;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [guidance?.nextStep, guidance?.distanceToManeuverM, settings.hapticsOnModeChange]);

  const onStart = useCallback(async () => {
    setStarting(true);
    // where the frozen model runs is the user's choice; it takes effect here
    engine.setInferenceMode(settings.inferenceMode);
    const res = await engine.start();
    setStarting(false);
    if (res.error) Alert.alert('Navigation started with limits', res.error);
  }, [settings.inferenceMode]);

  const onStop = useCallback(async () => {
    stopSpeaking();
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

  const onPlanned = useCallback(
    (planned: Route) => {
      trip.setRoute(planned);
      setFollowing(true);
      mapRef.current?.fitTo(planned.geometry);
      // A route is useless without a position stream, so planning one starts
      // the drive if it is not already running.
      if (state.mode === 'IDLE') void onStart();
    },
    [trip, state.mode, onStart],
  );

  const onEndTrip = useCallback(() => {
    Alert.alert('End guidance?', 'The route is removed. The drive itself keeps recording.', [
      { text: 'Keep guiding', style: 'cancel' },
      { text: 'End', style: 'destructive', onPress: () => trip.clearRoute() },
    ]);
  }, [trip]);

  const navigating = state.mode !== 'IDLE';
  const outageSeconds = state.activeOutage ? state.activeOutage.durationS : null;

  const tracks = useMemo<MapTrack[]>(() => {
    const out: MapTrack[] = [];
    if (route) {
      // Drawn first so the GNSS and dead-reckoning tracks sit on top of it:
      // the route is the plan, those two are what actually happened.
      const { travelled, remaining } = splitRoute(route, guidance?.distanceAlongM ?? 0);
      if (travelled.length > 1) {
        out.push({ id: 'route-done', points: travelled, color: c.textTertiary, width: 7, opacity: 0.5 });
      }
      if (remaining.length > 1) {
        out.push({ id: 'route', points: remaining, color: c.accent, width: 8, opacity: 0.85 });
      }
    }
    if (settings.showGnssTrack && state.gnssPath.length > 1) {
      out.push({ id: 'gnss', points: state.gnssPath, color: c.trackGnss, width: 5 });
    }
    if (settings.showDrTrack && state.drPath.length > 1) {
      out.push({ id: 'dr', points: state.drPath, color: c.trackDr, width: 5, dashed: true });
    }
    return out;
  }, [
    route,
    guidance?.distanceAlongM,
    settings.showGnssTrack,
    settings.showDrTrack,
    state.gnssPath,
    state.drPath,
    c,
  ]);

  const markers = useMemo<MapMarkerSpec[]>(() => {
    const out: MapMarkerSpec[] = [];
    if (route) {
      out.push({
        id: 'destination',
        coordinate: { latitude: route.destination.latitude, longitude: route.destination.longitude },
        title: route.destination.name,
        description: 'Destination',
        color: c.accent,
      });
    }
    if (state.activeOutage) {
      out.push({
        id: 'anchor',
        coordinate: {
          latitude: state.activeOutage.anchor.latitude,
          longitude: state.activeOutage.anchor.longitude,
        },
        title: 'Last GNSS fix',
        description: 'Anchor for the dead-reckoning estimate',
        color: c.trackGnss,
        hollow: true,
      });
    }
    return out;
  }, [route, state.activeOutage, c]);

  const legend = useMemo(() => {
    const l = [];
    if (route) l.push({ label: 'Planned route', color: c.accent });
    if (settings.showGnssTrack && state.gnssPath.length > 1)
      l.push({ label: 'GNSS track', color: c.trackGnss });
    if (settings.showDrTrack && state.drPath.length > 1)
      l.push({ label: 'AI dead reckoning', color: c.trackDr, dashed: true });
    return l;
  }, [route, settings.showGnssTrack, settings.showDrTrack, state.gnssPath.length, state.drPath.length, c]);

  const vehicleTone =
    state.mode === 'DEAD_RECKONING' ? c.ai : state.mode === 'DEGRADED' ? c.danger : c.accent;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <MatrixMap
        ref={mapRef}
        tracks={tracks}
        markers={markers}
        mapType={settings.mapStyle}
        followVehicle={following}
        onPanDrag={() => setFollowing(false)}
        accuracyM={state.mode === 'GNSS' ? (state.gnss.fix?.accuracy ?? null) : null}
        vehicle={
          vehicle && state.mode !== 'DEGRADED'
            ? { coordinate: vehicle.coordinate, headingDeg: vehicle.headingDeg, tone: vehicleTone }
            : null
        }
      />

      {/* floating top layer */}
      <View style={[styles.top, { paddingTop: insets.top + Spacing.sm }]} pointerEvents="box-none">
        {guidance ? (
          <GuidanceBanner
            guidance={guidance}
            mode={state.mode}
            offRoute={trip.offRoute}
            rerouting={trip.rerouting}
            units={settings.units}
            stale={state.mode === 'DEGRADED'}
            outageSeconds={outageSeconds ?? 0}
          />
        ) : null}
        <NavigationStatusBar
          mode={state.mode}
          gnssState={state.gnss.state}
          gnssReason={state.gnss.reason}
          speedMps={state.speedMps}
          headingDeg={state.headingDeg}
          outageSeconds={outageSeconds}
          units={settings.units}
        />
        {!guidance && (state.mode === 'DEAD_RECKONING' || state.mode === 'DEGRADED') ? (
          <OutageBanner
            visible
            mode={state.mode}
            seconds={state.activeOutage?.durationS ?? 0}
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
      <BottomSheet snapPoints={[188, 360, 620]} initialSnap={route ? 0 : 1}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: Spacing.md, paddingTop: Spacing.xs, paddingBottom: Spacing.xl }}>
          {guidance ? (
            <TripSummaryBar
              guidance={guidance}
              units={settings.units}
              onEnd={onEndTrip}
              onOverview={() => {
                setFollowing(false);
                if (route) mapRef.current?.fitTo(route.geometry);
              }}
            />
          ) : null}

          {route ? null : (
            <RoutePlanner here={state.position} units={settings.units} onPlanned={onPlanned} />
          )}

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

          {route && trip.rerouteError ? (
            <Card style={{ gap: Spacing.sm, borderColor: `${c.warn}55` }}>
              <Txt variant="caption" style={{ color: c.warn }}>
                {trip.rerouteError}
              </Txt>
              <Button label="Try re-planning" variant="secondary" onPress={() => void trip.reroute()} />
            </Card>
          ) : null}

          {route && guidance ? <StepList route={route} guidance={guidance} units={settings.units} /> : null}

          <MetricsCard
            columns={3}
            small
            metrics={[
              { label: 'Distance', value: formatDistance(state.distanceM, settings.units) },
              {
                label: 'Elapsed',
                value: state.startedAt ? formatDuration((Date.now() - state.startedAt) / 1000) : '—',
              },
              { label: 'Speed', value: formatSpeed(state.speedMps, settings.units) },
              { label: 'Outages', value: String(state.outages.length) },
              {
                label: 'On AI',
                value: formatDuration(
                  state.outages.reduce((a, o) => a + o.durationS, 0) +
                  (state.activeOutage?.durationS ?? 0),
                ),
                tone: state.mode === 'DEAD_RECKONING' ? 'ai' : undefined,
              },
              { label: 'Windows', value: String(state.serviceState?.windows_inferred ?? 0) },
            ]}
          />

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

          <SensorPanel
            gnss={state.gnss}
            telemetry={state.telemetry}
            velocityMps={state.speedMps}
            headingDeg={state.headingDeg}
          />

          <Txt variant="micro" color="textTertiary" style={{ textAlign: 'center' }}>
            Dead-reckoned positions come from the frozen MATRIX model on the inference service.
            They are an estimate, not a measured fix.
          </Txt>
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

/** The next few manoeuvres, so the driver can look ahead. */
function StepList({
  route,
  guidance,
  units,
}: {
  route: Route;
  guidance: GuidanceState;
  units: Units;
}) {
  const c = useColors();
  const from = guidance.nextStep?.index ?? route.steps.length;
  const upcoming = route.steps.slice(from, from + 4);
  if (!upcoming.length) return null;
  return (
    <Card style={{ gap: Spacing.sm }}>
      <Txt variant="micro" color="textTertiary">
        UPCOMING
      </Txt>
      {upcoming.map((s, i) => (
        <Row key={s.index} gap={Spacing.md} justify="space-between">
          <Txt variant="body" numberOfLines={1} style={{ flex: 1, opacity: i === 0 ? 1 : 0.7 }}>
            {s.instruction}
          </Txt>
          <Txt variant="caption" color="textSecondary" tabular>
            {formatDistance(
              i === 0
                ? guidance.distanceToManeuverM
                : s.startOffsetM - (guidance.nextStep?.startOffsetM ?? 0) + guidance.distanceToManeuverM,
              units,
            )}
          </Txt>
        </Row>
      ))}
      <Txt variant="micro" color="textTertiary">
        {route.steps.length} manoeuvres · {route.provider} · stored on device
      </Txt>
      <View style={{ height: 1, backgroundColor: c.border }} />
    </Card>
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
