/**
 * Guidance geometry and policy.
 *
 * The behaviour these tests protect is the one the product is about: guidance
 * must not change when the position stops coming from GNSS and starts coming
 * from the dead-reckoning loop. Every assertion below that mentions
 * DEAD_RECKONING is really asserting "the driver keeps being told where to
 * turn, and is not told they went the wrong way because the INS drifted".
 */
import {
  bearingBetween,
  computeGuidance,
  durationRemainingS,
  GUIDANCE,
  offRouteAllowanceM,
  OffRouteLatch,
  projectOnRoute,
  shouldReroute,
  splitRoute,
  stepIndexAt,
  voiceAnnouncementFor,
} from '@/services/guidance';
import { cumulativeDistances } from '@/services/routing';
import type { GeoPlace, LatLng, ManeuverKind, Route, RouteStep } from '@/types';

const p = (lat: number, lon: number): LatLng => ({ latitude: lat, longitude: lon });

const place = (name: string, lat: number, lon: number): GeoPlace => ({
  id: name,
  name,
  address: name,
  latitude: lat,
  longitude: lon,
  source: 'search',
});

/**
 * A straight 2 km route due east at the equator-ish latitude of the IO-VNBD
 * drives, with one right turn halfway. Straight geometry keeps the expected
 * numbers hand-checkable.
 */
function makeRoute(): Route {
  const geometry: LatLng[] = [];
  for (let i = 0; i <= 20; i += 1) geometry.push(p(52.4, -1.52 + i * 0.001));
  const cumulativeM = cumulativeDistances(geometry);
  const total = cumulativeM[cumulativeM.length - 1];

  const step = (
    index: number,
    kind: ManeuverKind,
    startOffsetM: number,
    distanceM: number,
    durationS: number,
  ): RouteStep => ({
    index,
    kind,
    instruction: `${kind} step ${index}`,
    roadName: 'Test Road',
    distanceM,
    durationS,
    startOffsetM,
    location: p(52.4, -1.52),
    exit: null,
  });

  const half = total / 2;
  return {
    id: 'r',
    origin: place('Start', 52.4, -1.52),
    destination: place('End', geometry[20].latitude, geometry[20].longitude),
    geometry,
    cumulativeM,
    steps: [
      step(0, 'depart', 0, half, 60),
      step(1, 'right', half, half, 60),
      step(2, 'arrive', total, 0, 0),
    ],
    distanceM: total,
    durationS: 120,
    createdAt: 0,
    provider: 'test',
  };
}

describe('projectOnRoute', () => {
  const route = makeRoute();

  it('snaps a point beside the route onto the line and reports the offset', () => {
    const along = route.cumulativeM[5];
    const off = p(route.geometry[5].latitude + 0.0005, route.geometry[5].longitude);
    const proj = projectOnRoute(route, off);
    expect(proj.alongM).toBeCloseTo(along, -1);
    // 0.0005 deg of latitude is about 55 m
    expect(proj.lateralM).toBeGreaterThan(50);
    expect(proj.lateralM).toBeLessThan(60);
  });

  it('reports zero offset for a point exactly on the route', () => {
    expect(projectOnRoute(route, route.geometry[7]).lateralM).toBeLessThan(0.5);
  });

  it('restricts the search to a window around the previous progress', () => {
    // A point near the start, queried as if the driver were already 1.5 km in,
    // must not snap backwards — that is what stops a crossing road stealing the
    // projection and resurrecting a manoeuvre already taken.
    const previous = route.cumulativeM[18];
    const proj = projectOnRoute(route, route.geometry[1], previous);
    // The window is clamped to whole segments, so it may reach back one
    // segment further than the nominal limit — but nowhere near the start.
    const segmentM = route.cumulativeM[1];
    expect(proj.alongM).toBeGreaterThan(previous - GUIDANCE.BACKTRACK_WINDOW_M - segmentM);
    expect(proj.alongM).toBeGreaterThan(route.cumulativeM[10]);
  });
});

describe('bearingBetween', () => {
  it('is 90 degrees for due east and 0 for due north', () => {
    expect(bearingBetween(p(52, -1.5), p(52, -1.4))).toBeCloseTo(90, 0);
    expect(bearingBetween(p(52, -1.5), p(52.1, -1.5))).toBeCloseTo(0, 0);
  });
});

describe('offRouteAllowanceM — the GNSS/INS tolerance split', () => {
  it('uses the tight threshold while GNSS is the source', () => {
    expect(offRouteAllowanceM('GNSS', 0, null)).toBe(GUIDANCE.OFF_ROUTE_GNSS_M);
  });

  it('widens with a poor GNSS accuracy so a weak fix is not a wrong turn', () => {
    expect(offRouteAllowanceM('GNSS', 0, 30)).toBe(GUIDANCE.OFF_ROUTE_GNSS_M + 30);
  });

  it('starts wider under dead reckoning and grows with the outage', () => {
    const atStart = offRouteAllowanceM('DEAD_RECKONING', 0, null);
    const aMinuteIn = offRouteAllowanceM('DEAD_RECKONING', 60, null);
    expect(atStart).toBe(GUIDANCE.OFF_ROUTE_DR_BASE_M);
    expect(aMinuteIn).toBeGreaterThan(atStart);
    expect(aMinuteIn).toBe(GUIDANCE.OFF_ROUTE_DR_BASE_M + 60 * GUIDANCE.OFF_ROUTE_DR_GROWTH_M_PER_S);
  });

  it('is capped, so a very long outage does not make off-route meaningless', () => {
    expect(offRouteAllowanceM('DEAD_RECKONING', 100_000, null)).toBe(GUIDANCE.OFF_ROUTE_MAX_M);
  });
});

describe('stepIndexAt', () => {
  const route = makeRoute();

  it('is the departure step before the first manoeuvre', () => {
    expect(stepIndexAt(route.steps, 10)).toBe(0);
  });

  it('advances once the manoeuvre offset is passed', () => {
    expect(stepIndexAt(route.steps, route.steps[1].startOffsetM + 1)).toBe(1);
  });

  it('is -1 for a route with no steps', () => {
    expect(stepIndexAt([], 10)).toBe(-1);
  });
});

describe('durationRemainingS', () => {
  const route = makeRoute();
  const total = route.cumulativeM[route.cumulativeM.length - 1];

  it('is the whole route duration at the start', () => {
    expect(durationRemainingS(route.steps, 0, total)).toBeCloseTo(120, 0);
  });

  it('interpolates within the current step so the countdown moves continuously', () => {
    const quarter = durationRemainingS(route.steps, total * 0.25, total);
    expect(quarter).toBeLessThan(120);
    expect(quarter).toBeGreaterThan(60);
  });

  it('reaches zero at the destination', () => {
    expect(durationRemainingS(route.steps, total, total)).toBeCloseTo(0, 5);
  });
});

describe('computeGuidance', () => {
  const route = makeRoute();
  const total = route.cumulativeM[route.cumulativeM.length - 1];

  it('counts down to the next manoeuvre from the start of the route', () => {
    const g = computeGuidance({ route, position: route.geometry[0], mode: 'GNSS' });
    expect(g.nextStep?.index).toBe(1);
    expect(g.distanceToManeuverM).toBeCloseTo(total / 2, -1);
    expect(g.distanceRemainingM).toBeCloseTo(total, -1);
    expect(g.onRoute).toBe(true);
    expect(g.arrived).toBe(false);
  });

  it('produces the same instruction for the same position whatever the source', () => {
    const position = route.geometry[6];
    const viaGnss = computeGuidance({ route, position, mode: 'GNSS' });
    const viaIns = computeGuidance({ route, position, mode: 'DEAD_RECKONING', outageSeconds: 30 });
    expect(viaIns.nextStep?.index).toBe(viaGnss.nextStep?.index);
    expect(viaIns.distanceToManeuverM).toBeCloseTo(viaGnss.distanceToManeuverM, 6);
    expect(viaIns.distanceRemainingM).toBeCloseTo(viaGnss.distanceRemainingM, 6);
  });

  it('keeps a drifted dead-reckoned position on-route where a GNSS fix would not be', () => {
    // 60 m off the line, 90 s into an outage: within the INS allowance, outside
    // the GNSS one. Flagging this as a wrong turn would try to reroute with no
    // signal — exactly the failure this tolerance exists to prevent.
    const drifted = p(route.geometry[8].latitude + 0.00054, route.geometry[8].longitude);
    expect(computeGuidance({ route, position: drifted, mode: 'GNSS' }).onRoute).toBe(false);
    expect(
      computeGuidance({ route, position: drifted, mode: 'DEAD_RECKONING', outageSeconds: 90 })
        .onRoute,
    ).toBe(true);
  });

  it('never lets progress run backwards', () => {
    const ahead = computeGuidance({ route, position: route.geometry[10], mode: 'GNSS' });
    const behind = computeGuidance({
      route,
      position: route.geometry[9],
      mode: 'GNSS',
      previousAlongM: ahead.distanceAlongM,
    });
    expect(behind.distanceAlongM).toBeGreaterThanOrEqual(ahead.distanceAlongM);
  });

  it('declares arrival inside the arrival radius', () => {
    const g = computeGuidance({ route, position: route.geometry[20], mode: 'GNSS' });
    expect(g.arrived).toBe(true);
    expect(g.distanceRemainingM).toBeLessThanOrEqual(GUIDANCE.ARRIVAL_RADIUS_M);
  });

  it('exposes the following manoeuvre for the "then …" line', () => {
    const g = computeGuidance({ route, position: route.geometry[0], mode: 'GNSS' });
    expect(g.followingStep?.index).toBe(2);
  });
});

describe('OffRouteLatch', () => {
  it('ignores a single deviating reading', () => {
    const latch = new OffRouteLatch();
    expect(latch.push(false)).toBe(false);
  });

  it('flips only after the deviation is confirmed', () => {
    const latch = new OffRouteLatch();
    for (let i = 0; i < GUIDANCE.OFF_ROUTE_CONFIRM - 1; i += 1) expect(latch.push(false)).toBe(false);
    expect(latch.push(false)).toBe(true);
  });

  it('rejoins faster than it leaves', () => {
    const latch = new OffRouteLatch();
    for (let i = 0; i < GUIDANCE.OFF_ROUTE_CONFIRM; i += 1) latch.push(false);
    for (let i = 0; i < GUIDANCE.ON_ROUTE_CONFIRM - 1; i += 1) expect(latch.push(true)).toBe(true);
    expect(latch.push(true)).toBe(false);
  });

  it('forgets a partial streak that is interrupted', () => {
    const latch = new OffRouteLatch();
    latch.push(false);
    latch.push(true);
    for (let i = 0; i < GUIDANCE.OFF_ROUTE_CONFIRM - 1; i += 1) expect(latch.push(false)).toBe(false);
  });
});

describe('shouldReroute', () => {
  it('re-plans when GNSS says the driver left the route', () => {
    expect(shouldReroute('GNSS', true, false)).toBe(true);
  });

  it('re-plans early in an outage — the DR start point is still trustworthy', () => {
    expect(shouldReroute('DEAD_RECKONING', true, false, 0)).toBe(true);
    expect(shouldReroute('DEAD_RECKONING', true, false, GUIDANCE.DR_REROUTE_MAX_OUTAGE_S)).toBe(true);
  });

  it('stops re-planning once the outage has run past the cap', () => {
    expect(shouldReroute('DEAD_RECKONING', true, false, GUIDANCE.DR_REROUTE_MAX_OUTAGE_S + 1)).toBe(
      false,
    );
  });

  it('never re-plans while DEGRADED — there is no position to plan from', () => {
    expect(shouldReroute('DEGRADED', true, false, 0)).toBe(false);
  });

  it('does not re-plan after arrival', () => {
    expect(shouldReroute('GNSS', true, true)).toBe(false);
  });
});

describe('splitRoute', () => {
  const route = makeRoute();
  const total = route.cumulativeM[route.cumulativeM.length - 1];

  it('is all remaining before the drive starts', () => {
    const { travelled, remaining } = splitRoute(route, 0);
    expect(travelled).toHaveLength(0);
    expect(remaining).toHaveLength(route.geometry.length);
  });

  it('is all travelled at the destination', () => {
    expect(splitRoute(route, total).remaining).toHaveLength(0);
  });

  it('meets exactly at the split point', () => {
    const { travelled, remaining } = splitRoute(route, total / 2);
    expect(travelled[travelled.length - 1]).toEqual(remaining[0]);
    expect(travelled.length + remaining.length).toBe(route.geometry.length + 2);
  });
});

describe('voiceAnnouncementFor', () => {
  const fmt = (m: number) => `${Math.round(m)} m`;
  const left: RouteStep = {
    index: 1,
    kind: 'left',
    instruction: 'Turn left onto Foleshill Road',
    roadName: 'Foleshill Road',
    distanceM: 500,
    durationS: 60,
    startOffsetM: 1000,
    location: p(52.4, -1.52),
    exit: null,
  };

  it('says nothing while the manoeuvre is far away', () => {
    expect(voiceAnnouncementFor(left, GUIDANCE.MANEUVER_NEAR_M + 1, null, fmt)).toBeNull();
  });

  it('announces the approach once, lower-casing the instruction after "in X"', () => {
    const a = voiceAnnouncementFor(left, GUIDANCE.MANEUVER_NEAR_M, null, fmt);
    expect(a).toEqual({
      kind: 'approach',
      stepIndex: 1,
      text: `In ${GUIDANCE.MANEUVER_NEAR_M} m, turn left onto Foleshill Road`,
    });
  });

  it('does not repeat the approach announcement for the same step', () => {
    const first = voiceAnnouncementFor(left, GUIDANCE.MANEUVER_NEAR_M, null, fmt)!;
    const again = voiceAnnouncementFor(
      left,
      GUIDANCE.MANEUVER_NEAR_M - 10,
      { stepIndex: first.stepIndex, kind: first.kind },
      fmt,
    );
    expect(again).toBeNull();
  });

  it('escalates to an imminent announcement, spoken as the instruction itself', () => {
    const a = voiceAnnouncementFor(
      left,
      GUIDANCE.MANEUVER_IMMINENT_M,
      { stepIndex: 1, kind: 'approach' },
      fmt,
    );
    expect(a).toEqual({ kind: 'imminent', stepIndex: 1, text: 'Turn left onto Foleshill Road' });
  });

  it('never repeats the imminent announcement for the same step', () => {
    const again = voiceAnnouncementFor(left, 5, { stepIndex: 1, kind: 'imminent' }, fmt);
    expect(again).toBeNull();
  });

  it('announces a fresh step even if the previous step ended imminent', () => {
    const nextStep: RouteStep = { ...left, index: 2, instruction: 'Turn right onto Broadgate' };
    const a = voiceAnnouncementFor(
      nextStep,
      GUIDANCE.MANEUVER_NEAR_M,
      { stepIndex: 1, kind: 'imminent' },
      fmt,
    );
    expect(a).toEqual({
      kind: 'approach',
      stepIndex: 2,
      text: `In ${GUIDANCE.MANEUVER_NEAR_M} m, turn right onto Broadgate`,
    });
  });

  it('says nothing with no current step', () => {
    expect(voiceAnnouncementFor(null, 10, null, fmt)).toBeNull();
  });
});
