/**
 * Turn-by-turn guidance along a planned route.
 *
 * Everything here is a pure function of (route, position, how that position was
 * obtained). There is no network, no device API and no React — which is the
 * property the whole feature rests on:
 *
 *   the guidance layer does not know, and does not care, whether the position
 *   it was handed came from GNSS or from the INS dead-reckoning loop.
 *
 * `navigation-engine.ts` already publishes one `position` and switches its
 * source the moment GNSS is classified as an outage. Guidance simply consumes
 * whatever is on that field, so the handover costs exactly one frame: no
 * re-planning, no re-snapping from scratch, no "recalculating…" pause.
 *
 * What DOES change with the source is tolerance. A dead-reckoned position
 * drifts, and drift grows with outage duration, so the off-route threshold
 * grows with it (`offRouteAllowanceM`). Judging a dead-reckoned fix against the
 * GNSS threshold would declare the driver off-route a minute into a tunnel and
 * try to reroute — the one thing that cannot work with no signal.
 */
import { haversineM } from './gnss';
import type { GuidanceState, LatLng, NavigationMode, Route, RouteStep } from '@/types';

export const GUIDANCE = {
  /** within this distance of the destination the route is complete */
  ARRIVAL_RADIUS_M: 25,
  /** off-route threshold while GNSS is the source */
  OFF_ROUTE_GNSS_M: 40,
  /** off-route threshold at the instant an outage starts */
  OFF_ROUTE_DR_BASE_M: 70,
  /**
   * Extra off-route allowance per second of dead reckoning.
   *
   * Sized from the model's own measured drift (see the demo sessions'
   * `drift_per_min_m`): a few tens of metres per minute, so ~0.5 m/s of
   * allowance keeps a correctly-followed route inside the threshold for the
   * length of a realistic tunnel or urban canyon.
   */
  OFF_ROUTE_DR_GROWTH_M_PER_S: 0.5,
  /** hard ceiling, so a long outage cannot make "off route" meaningless */
  OFF_ROUTE_MAX_M: 400,
  /** consecutive off-route readings before the state flips (matches the
   *  engine's own debounce philosophy: one bad fix must not change the UI) */
  OFF_ROUTE_CONFIRM: 3,
  ON_ROUTE_CONFIRM: 2,
  /** how far back along the route the projection may look */
  BACKTRACK_WINDOW_M: 120,
  /** how far ahead the projection may look in one update */
  LOOKAHEAD_WINDOW_M: 800,
  /** inside this distance the manoeuvre banner counts down in the imperative */
  MANEUVER_IMMINENT_M: 40,
  MANEUVER_NEAR_M: 180,
  /**
   * How long into a GNSS outage an automatic reroute may still fire.
   *
   * The DR position is a trustworthy-enough reroute origin for roughly the
   * same window the model's own drift stays small (see `OFF_ROUTE_DR_BASE_M`).
   * Past this cap the driver is better served by the planned line staying put
   * than by re-planning from a start point that may already be well off the
   * true position.
   */
  DR_REROUTE_MAX_OUTAGE_S: 45,
} as const;

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

/** Local metres-per-degree at a latitude. Flat-earth is exact enough over a
 *  single route segment (tens of metres) and far cheaper than haversine. */
function scaleAt(latitude: number): { mx: number; my: number } {
  return { mx: M_PER_DEG_LAT * Math.max(Math.cos(latitude * DEG), 1e-6), my: M_PER_DEG_LAT };
}

export interface Projection {
  /** index of the segment start vertex */
  index: number;
  /** 0..1 position within that segment */
  t: number;
  /** the point on the route closest to the query */
  snapped: LatLng;
  /** distance from the route origin to `snapped`, metres */
  alongM: number;
  /** perpendicular distance from the route, metres */
  lateralM: number;
}

/**
 * Project a position onto the route polyline.
 *
 * `fromAlongM` is the previous progress. Supplying it restricts the search to a
 * window around where the driver already was, which is what stops the snap
 * jumping to a road the route crosses later — and it makes the cost independent
 * of route length, so a 200 km route projects as fast as a 2 km one.
 */
export function projectOnRoute(route: Route, position: LatLng, fromAlongM = -1): Projection {
  const { geometry, cumulativeM } = route;
  const total = cumulativeM[cumulativeM.length - 1] ?? 0;

  let lo = 0;
  let hi = geometry.length - 2;
  if (fromAlongM >= 0) {
    const min = Math.max(0, fromAlongM - GUIDANCE.BACKTRACK_WINDOW_M);
    const max = Math.min(total, fromAlongM + GUIDANCE.LOOKAHEAD_WINDOW_M);
    while (lo < hi && cumulativeM[lo + 1] < min) lo += 1;
    while (hi > lo && cumulativeM[hi] > max) hi -= 1;
  }

  let best: Projection = {
    index: lo,
    t: 0,
    snapped: geometry[lo],
    alongM: cumulativeM[lo],
    lateralM: Infinity,
  };

  const { mx, my } = scaleAt(position.latitude);
  const px = position.longitude * mx;
  const py = position.latitude * my;

  for (let i = lo; i <= hi; i += 1) {
    const a = geometry[i];
    const b = geometry[i + 1];
    const ax = a.longitude * mx;
    const ay = a.latitude * my;
    const dx = b.longitude * mx - ax;
    const dy = b.latitude * my - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const lateralM = Math.hypot(px - cx, py - cy);
    if (lateralM < best.lateralM) {
      best = {
        index: i,
        t,
        snapped: { latitude: cy / my, longitude: cx / mx },
        alongM: cumulativeM[i] + t * (cumulativeM[i + 1] - cumulativeM[i]),
        lateralM,
      };
    }
  }
  return best;
}

/** Compass bearing from `a` to `b`, degrees clockwise from true north. */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const lat1 = a.latitude * DEG;
  const lat2 = b.latitude * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) / DEG) % 360 + 360) % 360;
}

/**
 * How far from the route the driver is allowed to be before the app calls it
 * off-route, given how the position was obtained.
 *
 * GNSS: a fixed threshold plus the receiver's own reported accuracy, so a weak
 * fix on a wide road does not read as a wrong turn.
 *
 * Dead reckoning: a larger base plus a term that grows with outage duration.
 * The INS position is an integral, and its error grows with time whether or not
 * the driver did anything wrong; holding it to the GNSS threshold would flag a
 * perfectly-followed route as a deviation after roughly a minute underground.
 */
export function offRouteAllowanceM(
  mode: NavigationMode,
  outageSeconds: number,
  accuracyM: number | null,
): number {
  if (mode === 'DEAD_RECKONING') {
    return Math.min(
      GUIDANCE.OFF_ROUTE_MAX_M,
      GUIDANCE.OFF_ROUTE_DR_BASE_M +
        Math.max(0, outageSeconds) * GUIDANCE.OFF_ROUTE_DR_GROWTH_M_PER_S,
    );
  }
  return GUIDANCE.OFF_ROUTE_GNSS_M + Math.min(60, Math.max(0, accuracyM ?? 0));
}

/** The step being driven at `alongM` — the last one whose manoeuvre has passed. */
export function stepIndexAt(steps: RouteStep[], alongM: number): number {
  if (!steps.length) return -1;
  let index = 0;
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].startOffsetM <= alongM + 0.5) index = i;
    else break;
  }
  return index;
}

/**
 * Time left, from the router's own per-step durations.
 *
 * Deliberately not derived from live speed: the speed during an outage is
 * itself a model output, and feeding it into the ETA would make the arrival
 * time wander every time the vehicle slowed for a junction. The router's
 * profile is a stable estimate, and the remaining fraction of the current step
 * is interpolated so the countdown still moves continuously.
 */
export function durationRemainingS(steps: RouteStep[], alongM: number, totalM: number): number {
  if (!steps.length) return 0;
  const i = stepIndexAt(steps, alongM);
  if (i < 0) return 0;
  const step = steps[i];
  const end = i + 1 < steps.length ? steps[i + 1].startOffsetM : totalM;
  const span = Math.max(1e-6, end - step.startOffsetM);
  const fractionLeft = Math.max(0, Math.min(1, (end - alongM) / span));
  let remaining = step.durationS * fractionLeft;
  for (let j = i + 1; j < steps.length; j += 1) remaining += steps[j].durationS;
  return remaining;
}

export interface GuidanceInput {
  route: Route;
  position: LatLng;
  /** how the position was obtained — sets the off-route tolerance only */
  mode: NavigationMode;
  /** seconds of dead reckoning so far, 0 when GNSS is the source */
  outageSeconds?: number;
  /** GNSS horizontal accuracy, when there is a fix */
  accuracyM?: number | null;
  /** previous `distanceAlongM`, so the projection can use a search window */
  previousAlongM?: number;
}

/** One guidance update. Pure: same inputs, same output, no clock, no I/O. */
export function computeGuidance({
  route,
  position,
  mode,
  outageSeconds = 0,
  accuracyM = null,
  previousAlongM = -1,
}: GuidanceInput): GuidanceState {
  const totalM = route.cumulativeM[route.cumulativeM.length - 1] ?? route.distanceM;
  const projection = projectOnRoute(route, position, previousAlongM);

  // Progress may never run backwards on its own: an off-route excursion or a
  // noisy fix must not un-drive a kilometre and resurrect a manoeuvre the
  // driver already took.
  const alongM =
    previousAlongM >= 0 ? Math.max(previousAlongM, projection.alongM) : projection.alongM;

  const stepIndex = stepIndexAt(route.steps, alongM);
  const step = stepIndex >= 0 ? route.steps[stepIndex] : null;
  const nextStep = stepIndex >= 0 ? (route.steps[stepIndex + 1] ?? null) : null;
  const followingStep = stepIndex >= 0 ? (route.steps[stepIndex + 2] ?? null) : null;

  const distanceRemainingM = Math.max(0, totalM - alongM);
  const distanceToManeuverM = nextStep
    ? Math.max(0, nextStep.startOffsetM - alongM)
    : distanceRemainingM;

  const i = Math.min(projection.index, route.geometry.length - 2);
  const routeBearingDeg = bearingBetween(route.geometry[i], route.geometry[i + 1]);

  const straightLineToEndM = haversineM(position, route.destination);
  const arrived =
    distanceRemainingM <= GUIDANCE.ARRIVAL_RADIUS_M ||
    straightLineToEndM <= GUIDANCE.ARRIVAL_RADIUS_M;

  const remainingS = durationRemainingS(route.steps, alongM, totalM);

  return {
    distanceAlongM: alongM,
    distanceRemainingM,
    durationRemainingS: remainingS,
    etaAt: Date.now() + remainingS * 1000,
    offRouteM: projection.lateralM,
    onRoute: projection.lateralM <= offRouteAllowanceM(mode, outageSeconds, accuracyM),
    step,
    nextStep,
    followingStep,
    distanceToManeuverM,
    snapped: projection.snapped,
    routeBearingDeg,
    arrived,
  };
}

/**
 * Debounced off-route latch.
 *
 * Mirrors the engine's `Debouncer`: a single reading never flips the state, and
 * leaving the route is confirmed more slowly than rejoining it, because the
 * cost of a false "off route" (an attempted reroute, which fails with no
 * signal) is higher than the cost of a late one.
 */
export class OffRouteLatch {
  private off = false;
  private streak = 0;

  /** Returns true while the driver is considered off the route. */
  push(onRoute: boolean): boolean {
    const agrees = onRoute === !this.off;
    if (agrees) {
      this.streak = 0;
      return this.off;
    }
    this.streak += 1;
    const threshold = this.off ? GUIDANCE.ON_ROUTE_CONFIRM : GUIDANCE.OFF_ROUTE_CONFIRM;
    if (this.streak >= threshold) {
      this.off = !this.off;
      this.streak = 0;
    }
    return this.off;
  }

  reset() {
    this.off = false;
    this.streak = 0;
  }
}

/**
 * Should the app try to fetch a new route?
 *
 * Always while GNSS is the position source. During dead reckoning, only for
 * the first `DR_REROUTE_MAX_OUTAGE_S` of the outage — long enough for a real
 * deviation to be worth correcting, short enough that the drifting DR
 * position is still a reasonable start point for the router. Past that, the
 * sensible behaviour is to keep showing the planned line and let the driver
 * rejoin it once GNSS is back.
 */
export function shouldReroute(
  mode: NavigationMode,
  offRoute: boolean,
  arrived: boolean,
  outageSeconds = 0,
): boolean {
  if (!offRoute || arrived) return false;
  if (mode === 'GNSS') return true;
  if (mode === 'DEAD_RECKONING') return outageSeconds <= GUIDANCE.DR_REROUTE_MAX_OUTAGE_S;
  return false;
}

/**
 * Split the route geometry at the current progress.
 *
 * The map draws the two halves differently — the part already driven is dimmed
 * and the part ahead is solid — which is the cheapest possible way to show
 * progress without animating anything. The split point is inserted exactly,
 * so the two polylines meet at the puck rather than at the nearest vertex.
 */
export function splitRoute(
  route: Route,
  alongM: number,
): { travelled: LatLng[]; remaining: LatLng[] } {
  const { geometry, cumulativeM } = route;
  if (alongM <= 0) return { travelled: [], remaining: geometry };
  const total = cumulativeM[cumulativeM.length - 1] ?? 0;
  if (alongM >= total) return { travelled: geometry, remaining: [] };

  let i = 0;
  while (i < cumulativeM.length - 2 && cumulativeM[i + 1] < alongM) i += 1;
  const span = cumulativeM[i + 1] - cumulativeM[i];
  const t = span > 0 ? (alongM - cumulativeM[i]) / span : 0;
  const cut: LatLng = {
    latitude: geometry[i].latitude + t * (geometry[i + 1].latitude - geometry[i].latitude),
    longitude: geometry[i].longitude + t * (geometry[i + 1].longitude - geometry[i].longitude),
  };
  return {
    travelled: [...geometry.slice(0, i + 1), cut],
    remaining: [cut, ...geometry.slice(i + 1)],
  };
}

/** "in 300 m" / "now" — the phrasing that goes under the manoeuvre arrow. */
export function maneuverCue(distanceM: number, format: (m: number) => string): string {
  if (distanceM <= GUIDANCE.MANEUVER_IMMINENT_M) return 'Now';
  return `In ${format(distanceM)}`;
}

export type VoiceAnnouncementKind = 'approach' | 'imminent';

export interface VoiceAnnouncement {
  kind: VoiceAnnouncementKind;
  stepIndex: number;
  text: string;
}

/**
 * Decide whether the current step warrants a spoken announcement right now,
 * and what to say. Pure and distance-only, using the same thresholds the
 * banner already counts down by (`MANEUVER_NEAR_M`, `MANEUVER_IMMINENT_M`),
 * so voice and text never disagree about when a turn is "coming up" versus
 * "now".
 *
 * Each step gets at most one `approach` announcement and one `imminent`
 * announcement — the caller passes back the last one it made so this stays a
 * pure function instead of holding its own state.
 */
export function voiceAnnouncementFor(
  step: RouteStep | null,
  distanceToManeuverM: number,
  lastAnnounced: { stepIndex: number; kind: VoiceAnnouncementKind } | null,
  format: (m: number) => string,
): VoiceAnnouncement | null {
  if (!step) return null;
  const kind: VoiceAnnouncementKind | null =
    distanceToManeuverM <= GUIDANCE.MANEUVER_IMMINENT_M
      ? 'imminent'
      : distanceToManeuverM <= GUIDANCE.MANEUVER_NEAR_M
        ? 'approach'
        : null;
  if (!kind) return null;
  if (lastAnnounced?.stepIndex === step.index) {
    // Same step: only ever move approach -> imminent, never repeat either one.
    if (lastAnnounced.kind === 'imminent' || kind === 'approach') return null;
  }
  const text =
    kind === 'imminent'
      ? step.instruction
      : `In ${format(distanceToManeuverM)}, ${lowerFirst(step.instruction)}`;
  return { kind, stepIndex: step.index, text };
}

function lowerFirst(s: string): string {
  return s.length ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
