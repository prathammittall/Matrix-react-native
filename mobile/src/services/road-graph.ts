/**
 * Offline road network — the map half of map-matching.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  This module is OUTSIDE the frozen boundary, like `motion-constraints.ts`.
 *  It touches no weights, no scaler, no filter — it is pure geometry over an
 *  OpenStreetMap road extract prepared ahead of time and bundled or cached on
 *  the device. Nothing here needs a network at run time.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The graph is a flat list of straight EDGES (one per consecutive vertex pair
 * of an OSM `highway` way). Map-matching only ever asks two questions:
 *
 *   1. which edges are near this point?      -> a uniform-grid spatial index
 *   2. where on an edge does this point fall, and how far off is it?
 *                                            -> `projectToEdge`
 *
 * Distances are metric. Latitude/longitude are converted to a local
 * equirectangular frame centred on the graph, which is accurate to well under a
 * metre over a city-sized extract and is far cheaper than haversine per query.
 */
import type { LatLng } from '@/types';

/** metres per degree of latitude (WGS-84 mean) */
const M_PER_DEG_LAT = 110574.0;

export interface RoadEdge {
  /** endpoints in lat/lng, for drawing and for the snapped output */
  a: LatLng;
  b: LatLng;
  /** local-frame endpoints in metres (x = east, y = north) */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** edge length, metres */
  len: number;
  /** compass bearing a->b, degrees clockwise from north, [0,360) */
  bearingDeg: number;
  /** id of the OSM way this edge belongs to — used for route continuity */
  wayId: number;
}

export interface ProjectedPoint {
  /** closest point on the edge, lat/lng */
  point: LatLng;
  /** perpendicular distance from the query point to the edge, metres */
  distM: number;
  /** fraction along the edge a->b in [0,1] */
  t: number;
  edge: RoadEdge;
}

export interface RawRoadGraph {
  /** [lat, lng] pairs per way, in OSM order */
  ways: { id: number; nodes: [number, number][] }[];
}

function metresPerDegLng(latDeg: number): number {
  return M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

function bearing(ax: number, ay: number, bx: number, by: number): number {
  // local frame: x east, y north -> compass bearing from north, clockwise
  return ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360;
}

/**
 * A road graph with a uniform-grid spatial index over its edges.
 *
 * The grid cell is sized to the match radius so a nearest-edge query only ever
 * scans the query cell and its eight neighbours.
 */
export class RoadGraph {
  readonly edges: RoadEdge[] = [];
  readonly lat0: number;
  readonly lon0: number;
  private readonly mPerLng: number;
  private readonly cellM: number;
  private readonly grid = new Map<string, number[]>();

  constructor(raw: RawRoadGraph, cellM = 50) {
    this.cellM = cellM;
    // centre the local frame on the mean of the first way's first node, or 0
    const first = raw.ways.find((w) => w.nodes.length > 0);
    this.lat0 = first ? first.nodes[0][0] : 0;
    this.lon0 = first ? first.nodes[0][1] : 0;
    this.mPerLng = metresPerDegLng(this.lat0);

    for (const way of raw.ways) {
      for (let i = 0; i + 1 < way.nodes.length; i += 1) {
        const [alat, alon] = way.nodes[i];
        const [blat, blon] = way.nodes[i + 1];
        const ax = this.toX(alon);
        const ay = this.toY(alat);
        const bx = this.toX(blon);
        const by = this.toY(blat);
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue; // drop degenerate duplicate nodes
        const edge: RoadEdge = {
          a: { latitude: alat, longitude: alon },
          b: { latitude: blat, longitude: blon },
          ax,
          ay,
          bx,
          by,
          len,
          bearingDeg: bearing(ax, ay, bx, by),
          wayId: way.id,
        };
        const id = this.edges.push(edge) - 1;
        this.index(id, edge);
      }
    }
  }

  get size() {
    return this.edges.length;
  }

  private toX(lon: number) {
    return (lon - this.lon0) * this.mPerLng;
  }
  private toY(lat: number) {
    return (lat - this.lat0) * M_PER_DEG_LAT;
  }
  private toLatLng(x: number, y: number): LatLng {
    return { latitude: this.lat0 + y / M_PER_DEG_LAT, longitude: this.lon0 + x / this.mPerLng };
  }
  private key(cx: number, cy: number) {
    return `${cx}:${cy}`;
  }

  private index(id: number, e: RoadEdge) {
    // register the edge in every grid cell its bounding box touches, so a long
    // edge is never missed by a query near its middle
    const minx = Math.floor(Math.min(e.ax, e.bx) / this.cellM);
    const maxx = Math.floor(Math.max(e.ax, e.bx) / this.cellM);
    const miny = Math.floor(Math.min(e.ay, e.by) / this.cellM);
    const maxy = Math.floor(Math.max(e.ay, e.by) / this.cellM);
    for (let cx = minx; cx <= maxx; cx += 1) {
      for (let cy = miny; cy <= maxy; cy += 1) {
        const k = this.key(cx, cy);
        const bucket = this.grid.get(k);
        if (bucket) bucket.push(id);
        else this.grid.set(k, [id]);
      }
    }
  }

  /** Project a query point onto one edge; null if the edge is degenerate. */
  private project(p: LatLng, e: RoadEdge): ProjectedPoint {
    const px = this.toX(p.longitude);
    const py = this.toY(p.latitude);
    const dx = e.bx - e.ax;
    const dy = e.by - e.ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - e.ax) * dx + (py - e.ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = e.ax + t * dx;
    const cy = e.ay + t * dy;
    const distM = Math.hypot(px - cx, py - cy);
    return { point: this.toLatLng(cx, cy), distM, t, edge: e };
  }

  /**
   * Every edge whose projection of `p` is within `radiusM`, nearest first.
   * These are the HMM emission candidates for one measurement.
   */
  candidates(p: LatLng, radiusM: number): ProjectedPoint[] {
    const px = this.toX(p.longitude);
    const py = this.toY(p.latitude);
    const cx = Math.floor(px / this.cellM);
    const cy = Math.floor(py / this.cellM);
    const span = Math.max(1, Math.ceil(radiusM / this.cellM));
    const seen = new Set<number>();
    const out: ProjectedPoint[] = [];
    for (let gx = cx - span; gx <= cx + span; gx += 1) {
      for (let gy = cy - span; gy <= cy + span; gy += 1) {
        const bucket = this.grid.get(this.key(gx, gy));
        if (!bucket) continue;
        for (const id of bucket) {
          if (seen.has(id)) continue;
          seen.add(id);
          const pr = this.project(p, this.edges[id]);
          if (pr.distM <= radiusM) out.push(pr);
        }
      }
    }
    out.sort((u, v) => u.distM - v.distM);
    return out;
  }
}
