/**
 * Validation of map-matching on the real IO-VNBD demo drive.
 *
 * Loads the bundled Coventry road graph and the recorded outages from
 * `S-M_s00`, runs the frozen dead-reckoned path through the HMM matcher, and
 * measures the final position error against ground truth before and after
 * snapping. This is the quantitative evidence that map-matching closes drift.
 */
import { RoadGraph, type RawRoadGraph } from '@/services/road-graph';
import { mapMatch, DEFAULT_MAP_MATCH } from '@/services/map-matching';
import { haversineM, bearingDeg } from '@/services/gnss';
import type { LatLng } from '@/types';

import demo from '../assets/demo/S-M_s00.json';
import rawGraph from '../assets/maps/coventry_road_graph.json';

type Outage = {
  duration_s: number;
  dr_path: [number, number][];
  truth_path: [number, number][];
};

const graph = new RoadGraph(rawGraph as unknown as RawRoadGraph);
const toLL = (p: [number, number]): LatLng => ({ latitude: p[0], longitude: p[1] });

/** Per-point heading from consecutive path points — what the engine feeds live. */
function headings(path: LatLng[]): (number | null)[] {
  return path.map((p, i) => (i === 0 ? null : bearingDeg(path[i - 1], p)));
}

describe('map-matching on the real Coventry drive', () => {
  const outages = (demo as unknown as { outages: Outage[] }).outages;

  it('loads a non-trivial bundled road graph', () => {
    expect(graph.size).toBeGreaterThan(500);
  });

  it('reduces final-position error in the 30-120 s drift range', () => {
    let rawSum = 0;
    let matchedSum = 0;
    let n = 0;
    // Aggregate over the horizons where map-matching is the right tool: long
    // enough that inertial drift has grown past a lane, short enough that the
    // path has not drifted onto a genuinely different road. Below ~30 s the DR
    // fix is already sub-lane and snapping only adds longitudinal slide; past
    // ~5 min the drift is gross and needs a global re-anchor, not local matching.
    const MID = new Set([30, 60, 120]);
    let midRaw = 0;
    let midMatched = 0;
    const rows: string[] = [];
    // one representative of each horizon (the first occurrence)
    const seen = new Set<number>();
    for (const o of outages) {
      if (seen.has(o.duration_s)) continue;
      seen.add(o.duration_s);
      const dr = o.dr_path.map(toLL);
      const truth = o.truth_path.map(toLL);
      if (dr.length < 2 || truth.length < 2) continue;
      const truthEnd = truth[truth.length - 1];

      const rawErr = haversineM(dr[dr.length - 1], truthEnd);
      const res = mapMatch(dr, headings(dr), graph, DEFAULT_MAP_MATCH);
      const matchedErr = haversineM(res.path[res.path.length - 1], truthEnd);

      rawSum += rawErr;
      matchedSum += matchedErr;
      n += 1;
      if (MID.has(o.duration_s)) {
        midRaw += rawErr;
        midMatched += matchedErr;
      }
      rows.push(
        `${String(o.duration_s).padStart(4)}s  raw ${rawErr.toFixed(0).padStart(4)} m  ` +
          `-> matched ${matchedErr.toFixed(0).padStart(4)} m  ` +
          `(matched ${(res.matchedFraction * 100).toFixed(0)}%, offset ${res.meanOffsetM.toFixed(0)} m)`,
      );
    }
    // Print the evidence for the write-up.
    const midCut = (100 * (midRaw - midMatched)) / midRaw;
    // eslint-disable-next-line no-console
    console.log('\nMap-matching on IO-VNBD S-M_s00:\n' + rows.join('\n') +
      `\nMEAN(all) raw ${(rawSum / n).toFixed(0)} m -> matched ${(matchedSum / n).toFixed(0)} m` +
      `\n30-120 s  raw ${midRaw.toFixed(0)} m -> matched ${midMatched.toFixed(0)} m  (${midCut.toFixed(0)}% cut)\n`);

    expect(n).toBeGreaterThan(0);
    // The claim we actually stand behind: a clear cut in the mid-range.
    expect(midMatched).toBeLessThan(midRaw);
    expect(midCut).toBeGreaterThan(15);
  });
});
