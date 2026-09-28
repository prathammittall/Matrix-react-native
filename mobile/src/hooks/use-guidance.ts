/**
 * React bindings for route guidance.
 *
 * `useRouteGuidance` owns the active route and turns the engine's position
 * stream into a `GuidanceState`. It is deliberately thin — all of the geometry
 * lives in `services/guidance.ts` as pure functions — because the interesting
 * behaviour here is not the maths but the policy around it:
 *
 *   * guidance recomputes from whatever position the engine published, so a
 *     GNSS -> dead-reckoning handover needs no special case and no reset;
 *   * rerouting is attempted only while GNSS is the source, because it needs
 *     the network and a trustworthy start point, and an outage has neither;
 *   * the route is persisted, so a route planned before losing signal is still
 *     there after a restart in the middle of a tunnel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  computeGuidance,
  OffRouteLatch,
  shouldReroute,
  type GuidanceInput,
} from '@/services/guidance';
import type { EngineSnapshot } from '@/services/navigation-engine';
import { placeFromPoint, planRoute, routeStore, RoutingError } from '@/services/routing';
import type { GuidanceState, LatLng, Route } from '@/types';

/** Never re-plan more often than this, however far off-route the driver is. */
const REROUTE_COOLDOWN_MS = 20_000;

export interface RouteGuidance {
  route: Route | null;
  guidance: GuidanceState | null;
  /** debounced: true only after the deviation has been confirmed */
  offRoute: boolean;
  rerouting: boolean;
  rerouteError: string | null;
  /** set once, when the destination is first reached */
  arrived: boolean;
  setRoute: (route: Route | null) => void;
  clearRoute: () => void;
  /** re-plan from the live position on demand (the "Reroute" button) */
  reroute: () => Promise<void>;
  /** true until the persisted route has been read back */
  loading: boolean;
}

export function useRouteGuidance(state: EngineSnapshot): RouteGuidance {
  const [route, setRouteState] = useState<Route | null>(null);
  const [loading, setLoading] = useState(true);
  const [guidance, setGuidance] = useState<GuidanceState | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [rerouteError, setRerouteError] = useState<string | null>(null);
  const [arrived, setArrived] = useState(false);

  const latch = useRef(new OffRouteLatch());
  const alongRef = useRef(-1);
  const lastRerouteAt = useRef(0);
  const routeRef = useRef<Route | null>(null);
  routeRef.current = route;

  // Restore whatever was being driven before the app was last closed.
  useEffect(() => {
    let alive = true;
    void routeStore.load().then((saved) => {
      if (!alive) return;
      if (saved) setRouteState(saved);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setRoute = useCallback((next: Route | null) => {
    latch.current.reset();
    alongRef.current = -1;
    setOffRoute(false);
    setArrived(false);
    setRerouteError(null);
    setGuidance(null);
    setRouteState(next);
    void routeStore.save(next);
    if (next) void routeStore.remember(next.destination);
  }, []);

  const clearRoute = useCallback(() => setRoute(null), [setRoute]);

  const position = state.position;
  const mode = state.mode;
  const outageSeconds = state.activeOutage?.durationS ?? 0;
  const accuracyM = state.gnss.fix?.accuracy ?? null;

  // The guidance update. Runs on every engine snapshot the UI receives, which
  // is the same cadence whether the position came from a GNSS fix or from the
  // dead-reckoning loop — there is no branch on the source anywhere below.
  useEffect(() => {
    // DEGRADED means there is no position worth believing — GNSS is gone and
    // dead reckoning could not run. The last instruction is left on screen
    // rather than cleared: it is still the best available answer to "what do I
    // do next", and the banner labels it as held.
    if (!route || !position || mode === 'IDLE' || mode === 'DEGRADED') return;
    const input: GuidanceInput = {
      route,
      position,
      mode,
      outageSeconds,
      accuracyM,
      previousAlongM: alongRef.current,
    };
    const next = computeGuidance(input);
    alongRef.current = next.distanceAlongM;
    setGuidance(next);
    setOffRoute(latch.current.push(next.onRoute));
    if (next.arrived) setArrived(true);
  }, [route, position, mode, outageSeconds, accuracyM]);

  const reroute = useCallback(async () => {
    const current = routeRef.current;
    const from = position;
    if (!current || !from) return;
    setRerouting(true);
    setRerouteError(null);
    try {
      const next = await planRoute(placeFromPoint(from, 'Current position'), current.destination);
      latch.current.reset();
      alongRef.current = -1;
      setOffRoute(false);
      setRouteState(next);
      void routeStore.save(next);
    } catch (err) {
      setRerouteError(
        err instanceof RoutingError
          ? err.message
          : 'Could not reach the routing service to re-plan',
      );
    } finally {
      lastRerouteAt.current = Date.now();
      setRerouting(false);
    }
  }, [position]);

  // Automatic re-planning. Always while GNSS is the live source; also for the
  // first `DR_REROUTE_MAX_OUTAGE_S` of a GNSS outage, while the dead-reckoned
  // start point is still trustworthy enough to plan from. Past that, the app
  // keeps the planned line on screen instead.
  useEffect(() => {
    if (!shouldReroute(mode, offRoute, arrived, outageSeconds) || rerouting) return;
    if (Date.now() - lastRerouteAt.current < REROUTE_COOLDOWN_MS) return;
    void reroute();
  }, [mode, offRoute, arrived, outageSeconds, rerouting, reroute]);

  return useMemo(
    () => ({
      route,
      guidance,
      offRoute,
      rerouting,
      rerouteError,
      arrived,
      setRoute,
      clearRoute,
      reroute,
      loading,
    }),
    [route, guidance, offRoute, rerouting, rerouteError, arrived, setRoute, clearRoute, reroute, loading],
  );
}

// ------------------------------------------------------- smooth rendering
const FRAME_MS = 50;
/** Fraction of the remaining gap closed each frame. ~0.6 s to converge. */
const EASE = 0.18;
/** Below this the puck is snapped, so it does not creep for ever. */
const SNAP_M = 0.4;

function shortestAngleDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export interface SmoothVehicle {
  coordinate: LatLng;
  headingDeg: number | null;
}

/**
 * Ease the map puck between position updates.
 *
 * Positions arrive about once a second — a GNSS fix, or one dead-reckoning
 * update per uploaded sensor batch. Drawing them raw makes the marker hop once
 * a second, which reads as a broken map even when the underlying track is
 * perfect. This eases the drawn position towards the true one instead, so the
 * marker glides and the GNSS -> INS handover is not visible as a stutter.
 *
 * It only ever moves TOWARDS a position the engine has actually published: the
 * puck never leads the data, so nothing on screen is extrapolated.
 */
export function useSmoothVehicle(
  target: LatLng | null,
  headingDeg: number | null,
  enabled = true,
): SmoothVehicle | null {
  const [render, setRender] = useState<SmoothVehicle | null>(null);
  const current = useRef<SmoothVehicle | null>(null);
  const goal = useRef<{ p: LatLng; h: number | null } | null>(null);

  goal.current = target ? { p: target, h: headingDeg } : null;

  useEffect(() => {
    if (!enabled || !target) {
      current.current = target ? { coordinate: target, headingDeg } : null;
      setRender(current.current);
      return;
    }
    // A brand-new track starts exactly where the data is; only subsequent
    // updates are eased.
    if (!current.current) {
      current.current = { coordinate: target, headingDeg };
      setRender(current.current);
    }

    const id = setInterval(() => {
      const g = goal.current;
      const c = current.current;
      if (!g || !c) return;
      const dLat = g.p.latitude - c.coordinate.latitude;
      const dLon = g.p.longitude - c.coordinate.longitude;
      const dHead =
        g.h === null || c.headingDeg === null ? 0 : shortestAngleDelta(c.headingDeg, g.h);
      // degrees -> rough metres, only to decide when to stop animating
      const gapM = Math.hypot(dLat, dLon) * 111_320;
      if (gapM < SNAP_M && Math.abs(dHead) < 0.5) {
        if (gapM > 0 || dHead !== 0) {
          current.current = { coordinate: g.p, headingDeg: g.h };
          setRender(current.current);
        }
        return;
      }
      current.current = {
        coordinate: {
          latitude: c.coordinate.latitude + dLat * EASE,
          longitude: c.coordinate.longitude + dLon * EASE,
        },
        headingDeg: c.headingDeg === null ? g.h : c.headingDeg + dHead * EASE,
      };
      setRender(current.current);
    }, FRAME_MS);
    return () => clearInterval(id);
    // `target`/`headingDeg` are read through `goal`; the interval must not be
    // torn down and rebuilt on every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, target === null]);

  return enabled ? render : target ? { coordinate: target, headingDeg } : null;
}
