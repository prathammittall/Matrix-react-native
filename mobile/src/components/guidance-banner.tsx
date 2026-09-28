/**
 * The turn-by-turn banner and the trip strip.
 *
 * The banner answers one question — what do I do next — and it answers it the
 * same way whether the position behind it came from GNSS or from the INS
 * dead-reckoning loop. That is the point of the design: the instruction does
 * not stutter, blank out or say "recalculating" when the signal goes, because
 * the route geometry is already on the device and the position source changed
 * underneath a layer that never asked which source it was.
 *
 * What does change is a small source chip on the right of the banner. The
 * driver is told the guidance is now running on the inertial estimate, because
 * that is a real change in how much the position can be trusted — it is just
 * not a change in whether they should turn left.
 */
import { StyleSheet, View } from 'react-native';

import { formatDistance, formatDuration, formatTime } from '@/services/format';
import { GUIDANCE, maneuverCue } from '@/services/guidance';
import type { Units } from '@/services/storage';
import { Radius, Spacing, useColors } from '@/theme';
import type { GuidanceState, NavigationMode } from '@/types';
import { ManeuverIcon } from './maneuver-icon';
import { Button } from './ui/controls';
import { Row, StatusDot, Txt, type Tone } from './ui/primitives';

/** What the banner says about where its position is coming from. */
export function guidanceSource(mode: NavigationMode): { label: string; tone: Tone } {
  switch (mode) {
    case 'DEAD_RECKONING':
      return { label: 'INS', tone: 'ai' };
    case 'DEGRADED':
      return { label: 'NO FIX', tone: 'danger' };
    case 'GNSS':
      return { label: 'GNSS', tone: 'ok' };
    default:
      return { label: 'READY', tone: 'idle' };
  }
}

export function GuidanceBanner({
  guidance,
  mode,
  offRoute,
  rerouting,
  units,
  /** true when the position is inertial, so the banner can say it is holding */
  stale,
  /** seconds of dead reckoning so far, 0 when GNSS is the source */
  outageSeconds = 0,
}: {
  guidance: GuidanceState;
  mode: NavigationMode;
  offRoute: boolean;
  rerouting: boolean;
  units: Units;
  stale?: boolean;
  outageSeconds?: number;
}) {
  const c = useColors();
  const source = guidanceSource(mode);
  const step = guidance.nextStep ?? guidance.step;
  const kind = guidance.arrived ? 'arrive' : (step?.kind ?? 'straight');
  const instruction = guidance.arrived
    ? 'You have arrived'
    : (step?.instruction ?? 'Follow the route');
  const cue = guidance.arrived
    ? 'Destination reached'
    : maneuverCue(guidance.distanceToManeuverM, (m) => formatDistance(m, units));
  const imminent =
    !guidance.arrived && guidance.distanceToManeuverM <= GUIDANCE.MANEUVER_IMMINENT_M;
  const accent = guidance.arrived ? c.ok : imminent ? c.accent : c.text;

  // The step after the one being announced — "then right" — so a pair of
  // junctions 40 m apart does not arrive as a surprise.
  const following =
    !guidance.arrived && guidance.followingStep
      ? `then ${guidance.followingStep.instruction.charAt(0).toLowerCase()}${guidance.followingStep.instruction.slice(1)}`
      : null;

  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${cue}. ${instruction}. Position source ${source.label}`}
      style={[
        styles.banner,
        {
          backgroundColor: c.surface,
          borderColor: imminent ? `${c.accent}99` : c.border,
        },
      ]}>
      <View style={[styles.glyph, { backgroundColor: imminent ? c.accentSoft : c.surfaceSunken }]}>
        <ManeuverIcon kind={kind} size={36} tint={accent} />
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Row justify="space-between" gap={Spacing.sm}>
          <Txt variant="label" tabular style={{ color: accent }}>
            {cue.toUpperCase()}
          </Txt>
          <Row gap={5}>
            <StatusDot tone={source.tone} size={7} pulse={mode === 'DEAD_RECKONING'} />
            <Txt variant="micro" style={{ color: c[source.tone] }}>
              {source.label}
            </Txt>
          </Row>
        </Row>
        <Txt variant="heading" numberOfLines={2}>
          {instruction}
        </Txt>
        {following ? (
          <Txt variant="caption" color="textSecondary" numberOfLines={1}>
            {following}
          </Txt>
        ) : null}
        {mode === 'DEAD_RECKONING' ? (
          <Txt variant="caption" style={{ color: c.ai }} numberOfLines={2}>
            GNSS lost — guiding from the inertial estimate. The route is already on the device.
          </Txt>
        ) : null}
        {stale && mode === 'DEGRADED' ? (
          <Txt variant="caption" style={{ color: c.danger }} numberOfLines={2}>
            Holding the last instruction — no position available to advance it.
          </Txt>
        ) : null}
        {offRoute ? (
          <Txt variant="caption" style={{ color: rerouting ? c.accent : c.warn }} numberOfLines={2}>
            {rerouting
              ? 'Off route — re-planning…'
              : mode === 'DEAD_RECKONING' && outageSeconds > GUIDANCE.DR_REROUTE_MAX_OUTAGE_S
                ? `Off the planned line by ${formatDistance(guidance.offRouteM, units)}. Re-planning needs GNSS.`
                : `Off route by ${formatDistance(guidance.offRouteM, units)}.`}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

/** Distance left, time left, arrival clock, and the way out of the trip. */
export function TripSummaryBar({
  guidance,
  units,
  onEnd,
  onOverview,
}: {
  guidance: GuidanceState;
  units: Units;
  onEnd: () => void;
  onOverview: () => void;
}) {
  const c = useColors();
  return (
    <View
      style={[styles.trip, { backgroundColor: c.surface, borderColor: c.border }]}
      accessible
      accessibilityLabel={`${formatDistance(guidance.distanceRemainingM, units)} remaining, ${formatDuration(
        guidance.durationRemainingS,
      )}, arriving at ${formatTime(guidance.etaAt)}`}>
      <View style={{ flex: 1 }}>
        <Txt variant="metricSm" tabular>
          {formatTime(guidance.etaAt)}
        </Txt>
        <Txt variant="caption" color="textSecondary" tabular>
          {formatDuration(guidance.durationRemainingS)} ·{' '}
          {formatDistance(guidance.distanceRemainingM, units)}
        </Txt>
      </View>
      <Row gap={Spacing.sm}>
        <Button label="Overview" variant="secondary" onPress={onOverview} />
        <Button label="End" variant="danger" onPress={onEnd} />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  glyph: {
    width: 56,
    height: 56,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
