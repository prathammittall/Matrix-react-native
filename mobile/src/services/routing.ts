/**
 * Route search and route planning — with no map API key.
 *
 * Two public OpenStreetMap services do the work, both keyless and both free:
 *
 *   geocoding  Nominatim  https://nominatim.openstreetmap.org
 *   routing    OSRM       https://router.project-osrm.org
 *
 * Neither is part of the navigation pipeline. They are consulted ONCE, while
 * the user is still stopped and picking a destination, to turn two place names
 * into a polyline and a list of manoeuvres. After that the route is a plain
 * array of coordinates held in memory (and in AsyncStorage), and guidance runs
 * entirely on-device — which is the whole point: when GNSS drops and the app
 * switches to the INS dead-reckoned position, there is nothing left to fetch,
 * so guidance continues without a network round trip.
 *
 * Both endpoints are shared community infrastructure with published usage
 * policies: a descriptive User-Agent is required, and search is debounced by
 * the caller to stay under one request per second. For production traffic these
 * base URLs should point at a self-hosted Nominatim/OSRM — see `ROUTING`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { haversineM } from './gnss';
import type { GeoPlace, LatLng, ManeuverKind, Route, RouteStep } from '@/types';

export const ROUTING = {
  /** override with EXPO_PUBLIC_MATRIX_GEOCODER_URL to use a self-hosted instance */
  geocoderUrl:
    process.env.EXPO_PUBLIC_MATRIX_GEOCODER_URL?.replace(/\/+$/, '') ??
    'https://nominatim.openstreetmap.org',
  routerUrl:
    process.env.EXPO_PUBLIC_MATRIX_ROUTER_URL?.replace(/\/+$/, '') ??
    'https://router.project-osrm.org',
  /** Nominatim's usage policy requires an identifying User-Agent */
  userAgent: 'MATRIX-DeadReckoning/1.0 (offline navigation research prototype)',
  timeoutMs: 12_000,
  maxResults: 8,
} as const;

export type RoutingProfile = 'driving' | 'cycling' | 'walking';

export class RoutingError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'timeout' | 'http' | 'empty' | 'schema',
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTING.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': ROUTING.userAgent },
    });
    if (!res.ok) throw new RoutingError(`Routing service returned ${res.status}`, 'http');
    return (await res.json()) as unknown;
  } catch (err) {
    if (err instanceof RoutingError) throw err;
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new RoutingError(
      aborted ? 'The routing service timed out' : 'No network connection to the routing service',
      aborted ? 'timeout' : 'network',
    );
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- geocoding
interface NominatimHit {
  place_id?: number;
  osm_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
}

/** Split Nominatim's one long display_name into a title and the rest. */
function splitDisplayName(hit: NominatimHit): { name: string; address: string } {
  const full = typeof hit.display_name === 'string' ? hit.display_name : '';
  const parts = full
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const name = hit.name?.trim() || parts[0] || 'Unnamed place';
  const address = parts.slice(parts[0] === name ? 1 : 0).join(', ') || full;
  return { name, address };
}

function toPlace(hit: NominatimHit, source: GeoPlace['source']): GeoPlace | null {
  const latitude = Number(hit.lat);
  const longitude = Number(hit.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const { name, address } = splitDisplayName(hit);
  return {
    id: String(hit.place_id ?? hit.osm_id ?? `${latitude},${longitude}`),
    name,
    address,
    latitude,
    longitude,
    source,
  };
}

/**
 * Search for a place by name.
 *
 * `near` biases results towards the user, so "station" means the one 2 km away
 * rather than one on another continent. It is a soft preference — a `viewbox`
 * without `bounded=1` ranks matches inside the box first but still returns
 * matches outside it.
 */
export async function searchPlaces(query: string, near?: LatLng | null): Promise<GeoPlace[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    limit: String(ROUTING.maxResults),
    addressdetails: '0',
  });
  if (near) {
    const d = 0.6; // ~65 km box around the user
    params.set(
      'viewbox',
      [near.longitude - d, near.latitude + d, near.longitude + d, near.latitude - d].join(','),
    );
  }
  const raw = await getJson(`${ROUTING.geocoderUrl}/search?${params.toString()}`);
  if (!Array.isArray(raw)) throw new RoutingError('Unexpected search response', 'schema');
  return raw
    .map((hit) => toPlace(hit as NominatimHit, 'search'))
    .filter((p): p is GeoPlace => p !== null);
}

/** Name the coordinates the device is sitting on. Falls back to the numbers. */
export async function reverseGeocode(point: LatLng): Promise<GeoPlace> {
  const fallback: GeoPlace = {
    id: 'device',
    name: 'Current location',
    address: `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
    latitude: point.latitude,
    longitude: point.longitude,
    source: 'device',
  };
  try {
    const params = new URLSearchParams({
      lat: String(point.latitude),
      lon: String(point.longitude),
      format: 'jsonv2',
      zoom: '17',
    });
    const raw = await getJson(`${ROUTING.geocoderUrl}/reverse?${params.toString()}`);
    const place = toPlace(raw as NominatimHit, 'device');
    if (!place) return fallback;
    return {
      ...place,
      id: 'device',
      name: 'Current location',
      address: place.address || place.name,
    };
  } catch {
    // Reverse geocoding is cosmetic: the coordinates are already known, and a
    // failure here must never stop the user routing from where they are.
    return fallback;
  }
}

/** Wrap a raw coordinate (a long-press on the map) as a place. */
export function placeFromPoint(point: LatLng, name = 'Dropped pin'): GeoPlace {
  return {
    id: `pin_${point.latitude.toFixed(5)}_${point.longitude.toFixed(5)}`,
    name,
    address: `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
    latitude: point.latitude,
    longitude: point.longitude,
    source: 'map',
  };
}

// -------------------------------------------------------------- polyline
/**
 * Decode an encoded polyline.
 *
 * OSRM is asked for `polyline6`, which is the classic encoded-polyline
 * algorithm at 1e-6 precision — about 0.1 m, so route geometry is never the
 * limiting term in the error budget next to a dead-reckoned position.
 */
export function decodePolyline(encoded: string, precision = 6): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat / factor, longitude: lon / factor });
  }
  return points;
}

/** Running distance to each vertex. `cumulativeM[0]` is always 0. */
export function cumulativeDistances(points: LatLng[]): number[] {
  const out = new Array<number>(points.length);
  if (!points.length) return out;
  out[0] = 0;
  for (let i = 1; i < points.length; i += 1) {
    out[i] = out[i - 1] + haversineM(points[i - 1], points[i]);
  }
  return out;
}

// ------------------------------------------------------------ manoeuvres
interface OsrmManeuver {
  type?: string;
  modifier?: string;
  location?: [number, number];
  exit?: number;
}

interface OsrmStep {
  distance?: number;
  duration?: number;
  name?: string;
  ref?: string;
  maneuver?: OsrmManeuver;
}

const MODIFIER_KIND: Record<string, ManeuverKind> = {
  left: 'left',
  right: 'right',
  'slight left': 'slight-left',
  'slight right': 'slight-right',
  'sharp left': 'sharp-left',
  'sharp right': 'sharp-right',
  straight: 'straight',
  uturn: 'uturn',
};

/** Reduce OSRM's (type, modifier) pair to the manoeuvres this app draws. */
export function maneuverKind(type?: string, modifier?: string): ManeuverKind {
  if (type === 'depart') return 'depart';
  if (type === 'arrive') return 'arrive';
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') return 'roundabout';
  if (type === 'merge') return 'merge';
  if (type === 'fork') return 'fork';
  return MODIFIER_KIND[modifier ?? ''] ?? 'straight';
}

const TURN_PHRASE: Record<ManeuverKind, string> = {
  depart: 'Head',
  straight: 'Continue straight',
  'slight-left': 'Bear left',
  left: 'Turn left',
  'sharp-left': 'Turn sharp left',
  'slight-right': 'Bear right',
  right: 'Turn right',
  'sharp-right': 'Turn sharp right',
  uturn: 'Make a U-turn',
  roundabout: 'At the roundabout',
  merge: 'Merge',
  fork: 'Keep going',
  arrive: 'Arrive',
};

function ordinal(n: number): string {
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/**
 * The human sentence for one manoeuvre.
 *
 * Built here rather than taken from a routing service's own instruction text,
 * so the wording is the app's and does not change with the routing backend.
 */
export function instructionFor(
  kind: ManeuverKind,
  roadName: string,
  destinationName: string,
  exit: number | null,
): string {
  const onto = roadName ? ` onto ${roadName}` : '';
  switch (kind) {
    case 'depart':
      return roadName ? `Head along ${roadName}` : 'Start driving';
    case 'arrive':
      return `Arrive at ${destinationName}`;
    case 'roundabout':
      return exit
        ? `At the roundabout, take the ${ordinal(exit)} exit${onto}`
        : `At the roundabout, continue${onto}`;
    case 'straight':
      return roadName ? `Continue on ${roadName}` : 'Continue straight';
    case 'merge':
      return `Merge${onto}`;
    case 'fork':
      return roadName ? `Keep to ${roadName}` : 'Keep going at the fork';
    default:
      return `${TURN_PHRASE[kind]}${onto}`;
  }
}

// ---------------------------------------------------------------- routing
interface OsrmResponse {
  code?: string;
  message?: string;
  routes?: {
    geometry?: string;
    distance?: number;
    duration?: number;
    legs?: { steps?: OsrmStep[] }[];
  }[];
}

/**
 * Plan a route between two places.
 *
 * `steps` is flattened across legs and each step is given a `startOffsetM`, the
 * distance from the route origin at which its manoeuvre happens. That single
 * number is what makes guidance cheap: once the current position has been
 * projected onto the route, finding the next manoeuvre is a comparison, not a
 * geometric search — which matters when the position is arriving from the
 * dead-reckoning loop rather than from a 1 Hz GNSS fix.
 */
export async function planRoute(
  origin: GeoPlace,
  destination: GeoPlace,
  profile: RoutingProfile = 'driving',
): Promise<Route> {
  const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'polyline6',
    steps: 'true',
    annotations: 'false',
    alternatives: 'false',
  });
  const raw = (await getJson(
    `${ROUTING.routerUrl}/route/v1/${profile}/${coords}?${params.toString()}`,
  )) as OsrmResponse;

  if (raw?.code && raw.code !== 'Ok') {
    throw new RoutingError(
      raw.code === 'NoRoute'
        ? 'No road route exists between those two places'
        : (raw.message ?? `Router replied ${raw.code}`),
      'empty',
    );
  }
  const first = raw?.routes?.[0];
  const encoded = first?.geometry;
  if (typeof encoded !== 'string' || !encoded) {
    throw new RoutingError('The router returned a route with no geometry', 'schema');
  }

  const geometry = decodePolyline(encoded);
  if (geometry.length < 2) throw new RoutingError('Route geometry is too short to follow', 'schema');
  const cumulativeM = cumulativeDistances(geometry);
  const geometryLength = cumulativeM[cumulativeM.length - 1];

  const rawSteps = (first?.legs ?? []).flatMap((leg) => leg.steps ?? []);
  const steps: RouteStep[] = [];
  let offset = 0;
  for (const s of rawSteps) {
    const kind = maneuverKind(s.maneuver?.type, s.maneuver?.modifier);
    const roadName = (s.name || s.ref || '').trim();
    const loc = s.maneuver?.location;
    const exit = typeof s.maneuver?.exit === 'number' ? s.maneuver.exit : null;
    steps.push({
      index: steps.length,
      kind,
      instruction: instructionFor(kind, roadName, destination.name, exit),
      roadName,
      distanceM: Number(s.distance) || 0,
      durationS: Number(s.duration) || 0,
      // clamped: OSRM's leg distances and the decoded geometry agree to well
      // under a metre, but a step must never claim to start past the end.
      startOffsetM: Math.min(offset, geometryLength),
      location:
        Array.isArray(loc) && loc.length === 2
          ? { latitude: loc[1], longitude: loc[0] }
          : geometry[geometry.length - 1],
      exit,
    });
    offset += Number(s.distance) || 0;
  }

  return {
    id: `route_${Date.now()}`,
    origin,
    destination,
    geometry,
    cumulativeM,
    steps,
    distanceM: Number(first?.distance) || geometryLength,
    durationS: Number(first?.duration) || 0,
    createdAt: Date.now(),
    provider: `OSRM (${profile})`,
  };
}

// ----------------------------------------------------------- persistence
const ROUTE_KEY = 'matrix.route.v1';
const RECENTS_KEY = 'matrix.route.recents.v1';
const MAX_RECENTS = 8;

function isRoute(v: unknown): v is Route {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r.geometry) &&
    r.geometry.length > 1 &&
    Array.isArray(r.cumulativeM) &&
    Array.isArray(r.steps) &&
    typeof r.distanceM === 'number'
  );
}

/**
 * The active route survives an app restart.
 *
 * A driver who planned a route with signal and then lost it — the exact
 * scenario this product is built for — must not have to re-plan to get their
 * guidance back, and re-planning is the one thing that cannot work offline.
 */
export const routeStore = {
  async save(route: Route | null): Promise<void> {
    try {
      if (route) await AsyncStorage.setItem(ROUTE_KEY, JSON.stringify(route));
      else await AsyncStorage.removeItem(ROUTE_KEY);
    } catch {
      /* persistence is best-effort; the in-memory route still works */
    }
  },

  async load(): Promise<Route | null> {
    try {
      const raw = await AsyncStorage.getItem(ROUTE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isRoute(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },

  async recents(): Promise<GeoPlace[]> {
    try {
      const raw = await AsyncStorage.getItem(RECENTS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (p): p is GeoPlace =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as GeoPlace).latitude === 'number' &&
          typeof (p as GeoPlace).longitude === 'number',
      );
    } catch {
      return [];
    }
  },

  async remember(place: GeoPlace): Promise<GeoPlace[]> {
    // the live fix is not a place worth offering again tomorrow
    if (place.source === 'device') return this.recents();
    const current = await this.recents();
    const next = [place, ...current.filter((p) => p.id !== place.id)].slice(0, MAX_RECENTS);
    try {
      await AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    return next;
  },
};
