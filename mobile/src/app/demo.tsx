import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { LineChart } from '@/components/charts';
import { MapLegend } from '@/components/map-legend';
import { MatrixMap, type MapTrack, type MatrixMapHandle } from '@/components/matrix-map';
import { MetricsGrid } from '@/components/metrics-card';
import { Screen, ScreenHeader } from '@/components/screen';
import {
  Badge,
  Button,
  Card,
  Divider,
  ErrorState,
  IconPause,
  IconPlay,
  IconReset,
  IconButton,
  ListRow,
  ProgressBar,
  Row,
  Section,
  SegmentedControl,
  SkeletonCard,
  StatusDot,
  Txt,
} from '@/components/ui';
import { useSettings } from '@/hooks/use-settings';
import { ApiError } from '@/services/api';
import { listDemoSessions, loadDemoSession, type DemoOrigin } from '@/services/demo-source';
import { DemoPlayer, defaultRate, LEAD_IN_S, type DemoFrame } from '@/services/demo-player';
import { formatClock, formatDistance, formatSpeed } from '@/services/format';
import { toLatLng } from '@/services/track';
import { Radius, Spacing, useColors } from '@/theme';
import type { DemoSession, DemoSessionSummary } from '@/types';

const TICK_MS = 80;

/**
 * Demo Mode.
 *
 * Plays a real recorded drive, drops GNSS, and shows the trajectory the frozen
 * model actually produced for that stretch of road against the recorded VBOX
 * ground truth. Every coordinate and every error figure comes from the exported
 * frozen predictions — nothing here is generated to look good.
 */
export default function DemoScreen() {
  const c = useColors();
  const { settings } = useSettings();
  const mapRef = useRef<MatrixMapHandle>(null);

  const [catalogue, setCatalogue] = useState<DemoSessionSummary[] | null>(null);
  const [origin, setOrigin] = useState<DemoOrigin>('bundled');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<DemoSession | null>(null);
  const [outageIndex, setOutageIndex] = useState(0);
  const [duration, setDuration] = useState(60);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // ------------------------------------------------------------ data loading
  const loadCatalogue = useCallback(async () => {
    setError(null);
    try {
      const { sessions, origin: from } = await listDemoSessions();
      setCatalogue(sessions);
      setOrigin(from);
      if (sessions.length) await pick(sessions[0].id);
      else setError('No demo data is available. Run backend/tools/export_demo_sessions.py.');
    } catch (err) {
      setCatalogue([]);
      setError(
        err instanceof ApiError
          ? `${err.message}. No demo data is bundled in this build either.`
          : 'Could not load any demo data.',
      );
    }
  }, []);

  const pick = useCallback(async (id: string) => {
    try {
      const { session: s, origin: from } = await loadDemoSession(id);
      setOrigin(from);
      setSession(s);
      setPlaying(false);
      setElapsed(0);
      const durations = [...new Set(s.outages.map((o) => o.duration_s))].sort((a, b) => a - b);
      const want = durations.includes(60) ? 60 : durations[Math.floor(durations.length / 2)];
      setDuration(want);
      setOutageIndex(s.outages.findIndex((o) => o.duration_s === want));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the demo session.');
    }
  }, []);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  // --------------------------------------------------------------- playback
  const outage = session?.outages[outageIndex] ?? null;
  const player = useMemo(
    () => (session && outage ? new DemoPlayer(session, outage, defaultRate(outage.duration_s)) : null),
    [session, outage],
  );

  useEffect(() => {
    if (!playing || !player) return;
    const id = setInterval(() => {
      setElapsed((e) => {
        const next = e + TICK_MS / 1000;
        if (next >= player.totalS) {
          setPlaying(false);
          return player.totalS;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, player]);

  const frame: DemoFrame | null = player ? player.frame(elapsed) : null;

  // keep the camera on the action
  useEffect(() => {
    if (!frame?.position) return;
    if (frame.phase === 'RECOVERED' && outage) {
      mapRef.current?.fitTo([...toLatLng(outage.dr_path), ...toLatLng(outage.truth_path)], 70);
    } else {
      mapRef.current?.center(frame.position, 0.006);
    }
  }, [frame?.position?.latitude, frame?.position?.longitude, frame?.phase, outage]);

  const restart = () => {
    setElapsed(0);
    setPlaying(true);
  };

  const selectDuration = (d: number) => {
    if (!session) return;
    const idx = session.outages.findIndex((o) => o.duration_s === d);
    if (idx < 0) return;
    setDuration(d);
    setOutageIndex(idx);
    setElapsed(0);
    setPlaying(false);
  };

  const tracks = useMemo<MapTrack[]>(() => {
    if (!frame) return [];
    const out: MapTrack[] = [];
    if (frame.gnssPath.length > 1)
      out.push({ id: 'gnss', points: frame.gnssPath, color: c.trackGnss, width: 5 });
    if (frame.truthPath.length > 1)
      out.push({ id: 'truth', points: frame.truthPath, color: c.trackTruth, width: 4 });
    if (frame.drPath.length > 1)
      out.push({ id: 'dr', points: frame.drPath, color: c.trackDr, width: 5, dashed: true });
    return out;
  }, [frame, c]);

  // ------------------------------------------------------------------ views
  if (error && !session) {
    return (
      <Screen>
        <ScreenHeader title="Demo Mode" back />
        <ErrorState message={error} onRetry={loadCatalogue} />
        <Card>
          <Txt variant="caption" color="textSecondary">
            Demo data is exported once from the frozen prediction files:
          </Txt>
          <Txt variant="caption" color="textTertiary" style={styles.mono}>
            python backend/tools/export_demo_sessions.py
          </Txt>
        </Card>
      </Screen>
    );
  }

  if (!session || !outage || !frame) {
    return (
      <Screen>
        <ScreenHeader title="Demo Mode" back />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={4} />
      </Screen>
    );
  }

  const durations = [...new Set(session.outages.map((o) => o.duration_s))].sort((a, b) => a - b);
  const phaseTone =
    frame.phase === 'OUTAGE' ? 'ai' : frame.phase === 'RECOVERED' ? 'ok' : frame.phase === 'GNSS' ? 'ok' : 'idle';
  const phaseLabel = {
    READY: 'READY',
    GNSS: 'GNSS ACTIVE',
    OUTAGE: 'AI DEAD RECKONING',
    RECOVERED: 'GNSS RECOVERED',
  }[frame.phase];

  return (
    <Screen scroll={false}>
      <View style={{ paddingHorizontal: Spacing.lg }}>
        <ScreenHeader
          title="Demo Mode"
          subtitle={`${session.title} · driver ${session.driver_id} · ${session.split} split`}
          back
          right={<Badge label={origin === 'bundled' ? 'offline' : 'real data'} tone="ok" />}
        />
      </View>

      <View style={styles.mapWrap}>
        <MatrixMap
          ref={mapRef}
          tracks={tracks}
          mapType={settings.mapStyle}
          followVehicle={false}
          vehicle={
            frame.position
              ? {
                  coordinate: frame.position,
                  headingDeg: null,
                  tone: frame.phase === 'OUTAGE' ? c.ai : c.accent,
                }
              : null
          }
          markers={
            frame.phase === 'RECOVERED'
              ? [
                  {
                    id: 'estimated',
                    coordinate: {
                      latitude: outage.estimated.latitude,
                      longitude: outage.estimated.longitude,
                    },
                    title: 'AI estimate at recovery',
                    description: `${outage.final_error_m} m from the reference position`,
                    color: c.trackDr,
                  },
                  {
                    id: 'recovery',
                    coordinate: outage.recovery,
                    title: 'Reference position',
                    description: 'Recorded VBOX ground truth',
                    color: c.trackTruth,
                    hollow: true,
                  },
                ]
              : [
                  {
                    id: 'anchor',
                    coordinate: {
                      latitude: outage.anchor.latitude,
                      longitude: outage.anchor.longitude,
                    },
                    title: 'Outage start',
                    description: `Anchor speed ${outage.anchor.speed_mps.toFixed(1)} m/s`,
                    color: c.trackGnss,
                    hollow: true,
                  },
                ]
          }
        />
        <View style={styles.mapOverlay} pointerEvents="box-none">
          <Card style={{ paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md }}>
            <Row gap={Spacing.sm}>
              <StatusDot tone={phaseTone} pulse={frame.phase === 'OUTAGE'} />
              <Txt variant="label" style={{ color: c[phaseTone] }}>
                {phaseLabel}
              </Txt>
              {frame.phase === 'OUTAGE' || frame.phase === 'RECOVERED' ? (
                <Txt variant="label" tabular color="textSecondary">
                  {formatClock(frame.phaseTime)}
                </Txt>
              ) : null}
            </Row>
          </Card>
          <MapLegend
            entries={[
              { label: 'GNSS', color: c.trackGnss },
              { label: 'AI dead reckoning', color: c.trackDr, dashed: true },
              { label: 'Reference (VBOX)', color: c.trackTruth },
            ]}
          />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.xl, paddingBottom: Spacing.xxxl }}
        showsVerticalScrollIndicator={false}>
        {/* transport */}
        <Card style={{ gap: Spacing.md }}>
          <ProgressBar
            value={player ? elapsed / player.totalS : 0}
            tone={frame.phase === 'OUTAGE' ? 'ai' : 'accent'}
            label="Playback progress"
          />
          <Row gap={Spacing.md}>
            <Button
              label={playing ? 'Pause' : elapsed > 0 ? 'Resume' : 'Play demo'}
              icon={playing ? <IconPause size={18} tint="#fff" /> : <IconPlay size={18} tint="#fff" />}
              onPress={() => setPlaying((p) => !p)}
              style={{ flex: 1 }}
            />
            <IconButton label="Restart" icon={<IconReset size={20} />} onPress={restart} />
          </Row>
          <Txt variant="micro" color="textTertiary">
            {LEAD_IN_S}s of GNSS driving, then the receiver is cut for {outage.duration_s}s. Long
            outages play at {defaultRate(outage.duration_s)}× so the demo stays short.
          </Txt>
        </Card>

        {/* live readout */}
        <Section title="Live">
          <Card>
            <MetricsGrid
              columns={3}
              small
              metrics={[
                {
                  label: 'AI speed',
                  value: formatSpeed(frame.velocityMps, settings.units),
                  tone: frame.phase === 'OUTAGE' ? 'ai' : undefined,
                },
                { label: 'Reference', value: formatSpeed(frame.truthVelocityMps, settings.units) },
                {
                  label: 'Error',
                  value: frame.errorM === null ? '—' : formatDistance(frame.errorM, settings.units),
                  tone: frame.errorM && frame.errorM > 100 ? 'warn' : undefined,
                },
              ]}
            />
          </Card>
        </Section>

        {/* outage picker */}
        <Section title="Outage duration">
          <SegmentedControl
            label="Outage duration"
            value={String(duration)}
            onChange={(v) => selectDuration(Number(v))}
            options={durations.map((d) => ({ value: String(d), label: `${d}s` }))}
          />
        </Section>

        {/* result */}
        <Section title="Measured result">
          <Card>
            <MetricsGrid
              columns={3}
              small
              metrics={[
                { label: 'Final error', value: `${outage.final_error_m}`, unit: 'm', tone: 'ai' },
                { label: 'Trajectory RMSE', value: `${outage.traj_rmse_m}`, unit: 'm' },
                { label: 'Max error', value: `${outage.max_error_m}`, unit: 'm' },
                { label: 'DR distance', value: formatDistance(outage.dr_distance_m, settings.units) },
                { label: 'Heading error', value: `${outage.heading_error_deg.toFixed(1)}`, unit: '°' },
                { label: 'Velocity RMSE', value: `${outage.velocity_rmse_mps}`, unit: 'm/s' },
              ]}
            />
          </Card>
        </Section>

        <Section title="Error growth">
          <Card>
            <LineChart
              height={150}
              xLabel="seconds into outage"
              yUnit="m"
              series={[
                {
                  label: 'Position error',
                  color: c.trackDr,
                  points: outage.error_growth.map((p) => ({ x: p.t, y: p.err })),
                },
              ]}
            />
          </Card>
        </Section>

        <Section title="Velocity">
          <Card>
            <LineChart
              height={150}
              xLabel="seconds into outage"
              yUnit="m/s"
              series={[
                {
                  label: 'AI estimate',
                  color: c.trackDr,
                  points: outage.velocity.map((p) => ({ x: p.t, y: p.dr })),
                },
                {
                  label: 'Reference (VBOX)',
                  color: c.trackTruth,
                  dashed: true,
                  points: outage.velocity.map((p) => ({ x: p.t, y: p.truth })),
                },
              ]}
            />
          </Card>
        </Section>

        {/* session picker */}
        {catalogue && catalogue.length > 1 ? (
          <Section title="Recorded drive">
            <Card padded={false}>
              {catalogue.map((s, i) => (
                <ListRow
                  key={s.id}
                  first={i === 0}
                  last={i === catalogue.length - 1}
                  title={s.title}
                  subtitle={`${s.distance_km} km · driver ${s.driver_id} · ${s.outage_count} outages`}
                  onPress={() => void pick(s.id)}
                  right={
                    s.id === session.id ? <Badge label="selected" tone="accent" /> : undefined
                  }
                />
              ))}
            </Card>
          </Section>
        ) : null}

        <Card style={{ gap: Spacing.sm }}>
          <Txt variant="label" color="textSecondary">
            PROVENANCE
          </Txt>
          <Txt variant="caption" color="textSecondary">
            {session.provenance}
          </Txt>
          <Divider />
          <Txt variant="micro" color="textTertiary">
            Measured on {session.vehicle} with a {session.phone}. Figures are benchmark results on
            this dataset, not a guarantee of accuracy on other devices, vehicles or roads.
          </Txt>
          <Txt variant="micro" color="textTertiary">
            {origin === 'bundled'
              ? 'Loaded from data bundled in this build — Demo Mode needs no network.'
              : 'Loaded from the inference service.'}
          </Txt>
          <Pressable
            onPress={() => router.push('/about')}
            accessibilityRole="button"
            accessibilityLabel="Read about MATRIX limitations">
            <Txt variant="caption" style={{ color: c.accent }}>
              Read the limitations →
            </Txt>
          </Pressable>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mapWrap: { height: 300, marginTop: Spacing.md },
  mapOverlay: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    top: Spacing.md,
    gap: Spacing.sm,
    alignItems: 'flex-start',
  },
  mono: { fontFamily: 'monospace' },
});
