/**
 * Map-matching — snap a drifting dead-reckoned path onto the road network.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  OUTSIDE the frozen boundary. It consumes the frozen pipeline's OUTPUT path
 *  (a lat/lng series and its per-point heading) and a `RoadGraph`, and returns
 *  a corrected path. It never touches the model. Passing `enabled = false`, an
 *  empty graph, or a path shorter than two points returns the input unchanged,
 *  so the unconstrained frozen result stays exactly reproducible.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ## Why this is the lever for long outages
 *
 * Dead-reckoning error past ~300 s is dominated by HEADING drift: a small,
 * steady gyro-bias residual integrates into an ever-widening arc away from the
 * true track. The road network is a strong, free prior on both position and
 * heading — a vehicle is on a road, and pointed along it. Snapping to it
 * removes the cross-track component of the drift outright, which is most of it.
 *
 * ## The algorithm — Newson & Krumm (2009), HMM map matching
 *
 * A hidden Markov model whose hidden states are "which road edge is the vehicle
 * on", solved with Viterbi:
 *
 *   emission(point -> edge)   how well the point sits on the edge:
 *                             its perpendicular distance (a Gaussian), AND how
 *                             well the DR heading agrees with the edge bearing.
 *                             The heading term is what disambiguates parallel
 *                             roads that distance alone cannot.
 *
 *   transition(edge -> edge)  how plausibly the vehicle moved between two
 *                             consecutive fixes: the along-road distance between
 *                             the two snapped points should match the straight
 *                             distance the measurements actually moved. A jump
 *                             onto a parallel road makes those disagree and is
 *                             penalised (Newson & Krumm's key idea), plus a
 *                             small cost for leaving the current road at all.
 *
 * When a point has no road within the search radius (genuinely off-network — a
 * car park, a private drive) the matcher passes that point through unchanged and
 * restarts continuity afterwards, rather than snapping to something implausibly
 * far away.
 */
import { haversineM } from './gnss';
import type { RoadGraph, ProjectedPoint } from './road-graph';
import type { LatLng } from '@/types';

export interface MapMatchOptions {
  /** how far from a point to look for candidate roads, metres */
  radiusM: number;
  /** measurement noise for the emission distance term, metres */
  sigmaZ: number;
  /** heading-agreement noise for the emission term, degrees. Large = trust
   *  heading weakly (it is itself drifting); small = trust it strongly. */
  sigmaHeadingDeg: number;
  /** transition scale, metres. Newson & Krumm's β; larger tolerates more
   *  disagreement between measured and along-road step length. */
  beta: number;
  /** extra cost (nats) for a transition that switches to a different OSM way,
   *  so staying on the current road is preferred when it fits equally well */
  waySwitchPenalty: number;
}

export const DEFAULT_MAP_MATCH: MapMatchOptions = {
  radiusM: 45,
  sigmaZ: 20,
  sigmaHeadingDeg: 45,
  beta: 30,
  waySwitchPenalty: 1.5,
};

export interface MapMatchResult {
  /** corrected path, one point per input point */
  path: LatLng[];
  /** heading per point (deg) — the matched edge bearing where matched, else the
   *  original DR heading. Feeding this back is what arrests yaw drift. */
  headingDeg: (number | null)[];
  /** fraction of points that snapped to a road in [0,1] */
  matchedFraction: number;
  /** mean perpendicular offset that was removed, metres, over matched points */
  meanOffsetM: number;
}

/** Smallest unsigned angle between two bearings, degrees in [0,180]. */
function angDiff(a: number, b: number): number {
  let d = Math.abs(((a - b) % 360) + 360) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Heading cost against a bidirectional road: the vehicle may drive either way. */
function headingCost(headingDeg: number | null, edgeBearingDeg: number, sigmaDeg: number): number {
  if (headingDeg === null || !Number.isFinite(headingDeg)) return 0;
  const d = Math.min(angDiff(headingDeg, edgeBearingDeg), angDiff(headingDeg, edgeBearingDeg + 180));
  const z = d / sigmaDeg;
  return 0.5 * z * z;
}

interface Cell {
  cand: ProjectedPoint;
  cost: number; // best cumulative negative-log-likelihood to here
  prev: number; // index into previous layer, -1 if none
}

/**
 * Run HMM map matching over one path. Pure and synchronous.
 *
 * `headingDeg[i]` may be null where no heading is known; the emission then uses
 * distance only. Cost is accumulated as negative log-likelihood (lower better),
 * so the terms add and Viterbi minimises.
 */
export function mapMatch(
  path: LatLng[],
  headingDeg: (number | null)[],
  graph: RoadGraph | null,
  opts: MapMatchOptions = DEFAULT_MAP_MATCH,
  enabled = true,
): MapMatchResult {
  const n = path.length;
  const identity = (): MapMatchResult => ({
    path: path.slice(),
    headingDeg: headingDeg.slice(0, n),
    matchedFraction: 0,
    meanOffsetM: 0,
  });
  if (!enabled || !graph || graph.size === 0 || n < 2) return identity();

  const emissionCost = (c: ProjectedPoint, i: number): number => {
    const z = c.distM / opts.sigmaZ;
    return 0.5 * z * z + headingCost(headingDeg[i], c.edge.bearingDeg, opts.sigmaHeadingDeg);
  };

  let prevLayer: Cell[] = [];
  const layers: Cell[][] = [];
  const rawPass: boolean[] = new Array(n).fill(false);

  for (let i = 0; i < n; i += 1) {
    const cands = graph.candidates(path[i], opts.radiusM);
    if (cands.length === 0) {
      // off-network: pass this point through, break continuity
      rawPass[i] = true;
      layers.push([]);
      prevLayer = [];
      continue;
    }
    const layer: Cell[] = cands.map((cand) => ({ cand, cost: emissionCost(cand, i), prev: -1 }));

    if (prevLayer.length > 0) {
      const measStep = haversineM(path[i - 1], path[i]);
      for (const cell of layer) {
        let best = Infinity;
        let bestPrev = -1;
        for (let j = 0; j < prevLayer.length; j += 1) {
          const p = prevLayer[j];
          const routeStep = haversineM(p.cand.point, cell.cand.point);
          let t = Math.abs(measStep - routeStep) / opts.beta;
          if (p.cand.edge.wayId !== cell.cand.edge.wayId) t += opts.waySwitchPenalty;
          const total = p.cost + t;
          if (total < best) {
            best = total;
            bestPrev = j;
          }
        }
        cell.cost += best;
        cell.prev = bestPrev;
      }
    }
    layers.push(layer);
    prevLayer = layer;
  }

  // Backtrack from the best terminal cell of the last non-empty layer, walking
  // backwards and filling each layer's chosen cell.
  const chosen: (Cell | null)[] = new Array(n).fill(null);
  let last = n - 1;
  while (last >= 0 && layers[last].length === 0) last -= 1;
  if (last >= 0) {
    let bi = 0;
    for (let k = 1; k < layers[last].length; k += 1) {
      if (layers[last][k].cost < layers[last][bi].cost) bi = k;
    }
    let idx = last;
    let cellIdx = bi;
    while (idx >= 0 && cellIdx >= 0 && layers[idx].length > 0) {
      const cell = layers[idx][cellIdx];
      chosen[idx] = cell;
      cellIdx = cell.prev;
      idx -= 1;
      // a broken chain (prev = -1 before the start) ends this run
      if (cellIdx < 0) break;
    }
  }

  const outPath: LatLng[] = new Array(n);
  const outHeading: (number | null)[] = new Array(n);
  let matched = 0;
  let offsetSum = 0;
  for (let i = 0; i < n; i += 1) {
    const cell = chosen[i];
    if (cell) {
      outPath[i] = cell.cand.point;
      outHeading[i] = cell.cand.edge.bearingDeg;
      matched += 1;
      offsetSum += cell.cand.distM;
    } else {
      outPath[i] = path[i];
      outHeading[i] = headingDeg[i] ?? null;
    }
  }

  return {
    path: outPath,
    headingDeg: outHeading,
    matchedFraction: matched / n,
    meanOffsetM: matched ? offsetSum / matched : 0,
  };
}
