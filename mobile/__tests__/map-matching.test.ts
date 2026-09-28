import { RoadGraph, type RawRoadGraph } from '@/services/road-graph';
import { mapMatch, DEFAULT_MAP_MATCH } from '@/services/map-matching';
import { haversineM } from '@/services/gnss';
import type { LatLng } from '@/types';

const LAT0 = 52.4;
const LON0 = -1.5;

/** A single straight east–west road at constant latitude. */
function ewRoad(lat: number, id = 1): RawRoadGraph['ways'][number] {
  const nodes: [number, number][] = [];
  for (let k = -5; k <= 5; k += 1) nodes.push([lat, LON0 + k * 0.001]);
  return { id, nodes };
}

/** A single straight north–south road at constant longitude. */
function nsRoad(lon: number, id = 2): RawRoadGraph['ways'][number] {
  const nodes: [number, number][] = [];
  for (let k = -5; k <= 5; k += 1) nodes.push([LAT0 + k * 0.001, lon]);
  return { id, nodes };
}

describe('RoadGraph', () => {
  it('builds edges from ways and finds nearby candidates', () => {
    const g = new RoadGraph({ ways: [ewRoad(LAT0)] });
    expect(g.size).toBe(10); // 11 nodes -> 10 edges
    const near = g.candidates({ latitude: LAT0 + 0.0001, longitude: LON0 }, 45);
    expect(near.length).toBeGreaterThan(0);
    expect(near[0].distM).toBeLessThan(20);
  });

  it('returns nothing far from any road', () => {
    const g = new RoadGraph({ ways: [ewRoad(LAT0)] });
    const near = g.candidates({ latitude: LAT0 + 0.01, longitude: LON0 }, 45);
    expect(near.length).toBe(0);
  });
});

describe('mapMatch', () => {
  const g = new RoadGraph({ ways: [ewRoad(LAT0)] });

  it('is identity when disabled', () => {
    const path: LatLng[] = [
      { latitude: LAT0 + 0.0002, longitude: LON0 - 0.001 },
      { latitude: LAT0 + 0.0002, longitude: LON0 + 0.001 },
    ];
    const r = mapMatch(path, [90, 90], g, DEFAULT_MAP_MATCH, false);
    expect(r.path).toEqual(path);
    expect(r.matchedFraction).toBe(0);
  });

  it('is identity with an empty graph', () => {
    const empty = new RoadGraph({ ways: [] });
    const path: LatLng[] = [
      { latitude: LAT0, longitude: LON0 },
      { latitude: LAT0, longitude: LON0 + 0.001 },
    ];
    const r = mapMatch(path, [90, 90], empty);
    expect(r.matchedFraction).toBe(0);
    expect(r.path).toEqual(path);
  });

  it('snaps a north-drifted track back onto the road and shrinks the offset', () => {
    const offsetDeg = 0.0002; // ~22 m north of the road
    const path: LatLng[] = [];
    const heads: number[] = [];
    for (let k = -3; k <= 3; k += 1) {
      path.push({ latitude: LAT0 + offsetDeg, longitude: LON0 + k * 0.0005 });
      heads.push(90);
    }
    const r = mapMatch(path, heads, g);
    expect(r.matchedFraction).toBe(1);
    // every snapped point is closer to the road latitude than the input was
    for (const p of r.path) {
      const offsetAfter = haversineM(p, { latitude: LAT0, longitude: p.longitude });
      expect(offsetAfter).toBeLessThan(5);
    }
    // the matched heading is the road bearing (~90, east)
    for (const h of r.headingDeg) expect(Math.abs((h ?? 0) - 90)).toBeLessThan(5);
    expect(r.meanOffsetM).toBeGreaterThan(15);
  });

  it('uses heading to pick the crossing road, not the perpendicular one', () => {
    const cross = new RoadGraph({ ways: [ewRoad(LAT0, 1), nsRoad(LON0, 2)] });
    // points sitting right at the intersection, moving east
    const path: LatLng[] = [
      { latitude: LAT0 + 0.00005, longitude: LON0 - 0.0002 },
      { latitude: LAT0 + 0.00005, longitude: LON0 + 0.0002 },
    ];
    const r = mapMatch(path, [90, 90], cross);
    // east heading -> east–west road (bearing ~90), not the N–S road (bearing 0)
    for (const h of r.headingDeg) {
      const east = Math.min(Math.abs((h ?? 0) - 90), Math.abs((h ?? 0) - 270));
      expect(east).toBeLessThan(10);
    }
  });

  it('passes through points that are off every road', () => {
    const path: LatLng[] = [
      { latitude: LAT0, longitude: LON0 }, // on road
      { latitude: LAT0 + 0.01, longitude: LON0 }, // ~1.1 km off road
    ];
    const r = mapMatch(path, [90, 90], g);
    // the off-road point is returned unchanged
    expect(r.path[1]).toEqual(path[1]);
    expect(r.matchedFraction).toBeLessThan(1);
  });
});
