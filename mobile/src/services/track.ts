/**
 * Track/polyline helpers.
 *
 * Pure functions — no React, no device APIs — so the map's data path is unit
 * testable and cheap to call from a high-rate update loop.
 */
import { TUNING } from './config';
import { haversineM } from './gnss';
import type { LatLng } from '@/types';

const EPS_M = 1.5;

/** Append a point, dropping it if it is within `minSpacingM` of the last one. */
export function appendPoint(path: LatLng[], p: LatLng, minSpacingM = EPS_M): LatLng[] {
  const last = path[path.length - 1];
  if (last && haversineM(last, p) < minSpacingM) return path;
  return [...path, p];
}

/** Total path length in metres. */
export function pathLengthM(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += haversineM(path[i - 1], path[i]);
  return total;
}

/**
 * Uniformly thin a polyline for rendering. Always keeps the first and last
 * point so the drawn line still starts and ends where the data does.
 */
export function decimate(path: LatLng[], max: number = TUNING.MAX_POLYLINE_POINTS): LatLng[] {
  if (path.length <= max) return path;
  const step = Math.ceil(path.length / max);
  const out: LatLng[] = [];
  for (let i = 0; i < path.length; i += step) out.push(path[i]);
  const last = path[path.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export interface Region {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

/** A map region that contains every supplied point, with padding. */
export function regionFor(points: LatLng[], padding = 1.45, minDelta = 0.002): Region | null {
  if (!points.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLon = Math.min(minLon, p.longitude);
    maxLon = Math.max(maxLon, p.longitude);
  }
  if (!Number.isFinite(minLat)) return null;
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * padding, minDelta),
    longitudeDelta: Math.max((maxLon - minLon) * padding, minDelta),
  };
}

/** `[lat, lon]` pairs (the demo payload shape) to map coordinates. */
export function toLatLng(pairs: [number, number][]): LatLng[] {
  return pairs.map(([latitude, longitude]) => ({ latitude, longitude }));
}
