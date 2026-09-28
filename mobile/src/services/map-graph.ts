/**
 * Bundled offline road graphs.
 *
 * The graph is prepared ahead of time from OpenStreetMap (see
 * `scripts/fetch-osm-graph.py`) and shipped inside the app, so map-matching
 * needs no network at run time. This module builds the `RoadGraph` once, lazily,
 * and hands the same instance to every outage.
 *
 * Today a single demo-region graph (Coventry, matching the IO-VNBD demo drive)
 * is bundled. A production build would carry several regional extracts and pick
 * the one whose bounds contain the last GNSS fix; the selection seam is
 * `graphForRegion`, which currently returns the one bundled graph.
 */
import raw from '@/../assets/maps/coventry_road_graph.json';
import { RoadGraph, type RawRoadGraph } from './road-graph';
import type { LatLng } from '@/types';

let cached: RoadGraph | null = null;

/** The bundled Coventry graph, built once. */
export function bundledRoadGraph(): RoadGraph {
  if (!cached) cached = new RoadGraph(raw as unknown as RawRoadGraph);
  return cached;
}

/**
 * The road graph covering `where`, or null if none is bundled for that area.
 * With one bundled region this returns it whenever a position is known; the
 * matcher itself contributes nothing when the point is far from every road, so
 * an out-of-region fix degrades to plain dead reckoning rather than misbehaving.
 */
export function graphForRegion(where: LatLng | null): RoadGraph | null {
  if (!where) return null;
  return bundledRoadGraph();
}
