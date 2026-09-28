/**
 * Route planning: polyline decoding, manoeuvre mapping, and the OSRM contract.
 *
 * The network is stubbed. What is being asserted is that a route arriving from
 * the router is turned into a self-contained object — geometry, cumulative
 * distances, and a `startOffsetM` on every step — because that object is what
 * guidance runs on once the signal is gone.
 */
import {
  cumulativeDistances,
  decodePolyline,
  instructionFor,
  maneuverKind,
  placeFromPoint,
  planRoute,
  routeStore,
  RoutingError,
  searchPlaces,
} from '@/services/routing';
import type { GeoPlace } from '@/types';

const A: GeoPlace = {
  id: 'a',
  name: 'Start',
  address: 'Start',
  latitude: 52.4,
  longitude: -1.52,
  source: 'search',
};
const B: GeoPlace = {
  id: 'b',
  name: 'Coventry Station',
  address: 'Coventry',
  latitude: 52.4008,
  longitude: -1.5,
  source: 'search',
};

/** Encode a polyline the way OSRM does, so decoding is tested against a
 *  round trip rather than a magic string. */
function encodePolyline(points: [number, number][], precision = 6): string {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const chunk = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const la = Math.round(lat * factor);
    const lo = Math.round(lon * factor);
    out += chunk(la - prevLat) + chunk(lo - prevLon);
    prevLat = la;
    prevLon = lo;
  }
  return out;
}

const GEOMETRY: [number, number][] = [
  [52.4, -1.52],
  [52.4, -1.51],
  [52.4008, -1.5],
];

function osrmReply() {
  return {
    code: 'Ok',
    routes: [
      {
        geometry: encodePolyline(GEOMETRY),
        distance: 1400,
        duration: 180,
        legs: [
          {
            steps: [
              {
                distance: 700,
                duration: 90,
                name: 'Foleshill Road',
                maneuver: { type: 'depart', modifier: 'straight', location: [-1.52, 52.4] },
              },
              {
                distance: 700,
                duration: 90,
                name: 'Station Approach',
                maneuver: { type: 'turn', modifier: 'left', location: [-1.51, 52.4] },
              },
              {
                distance: 0,
                duration: 0,
                name: '',
                maneuver: { type: 'arrive', location: [-1.5, 52.4008] },
              },
            ],
          },
        ],
      },
    ],
  };
}

function mockFetch(body: unknown, ok = true, status = 200) {
  global.fetch = jest.fn(async () => ({
    ok,
    status,
    statusText: 'x',
    json: async () => body,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('decodePolyline', () => {
  it('round-trips an encoded polyline at 1e-6 precision', () => {
    const decoded = decodePolyline(encodePolyline(GEOMETRY));
    expect(decoded).toHaveLength(3);
    decoded.forEach((point, i) => {
      expect(point.latitude).toBeCloseTo(GEOMETRY[i][0], 6);
      expect(point.longitude).toBeCloseTo(GEOMETRY[i][1], 6);
    });
  });

  it('returns an empty path for an empty string', () => {
    expect(decodePolyline('')).toEqual([]);
  });
});

describe('cumulativeDistances', () => {
  it('starts at zero and increases monotonically', () => {
    const cum = cumulativeDistances(decodePolyline(encodePolyline(GEOMETRY)));
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeGreaterThan(0);
    expect(cum[2]).toBeGreaterThan(cum[1]);
  });

  it('handles an empty path without throwing', () => {
    expect(cumulativeDistances([])).toEqual([]);
  });
});

describe('maneuverKind', () => {
  it('maps OSRM types that carry their own meaning', () => {
    expect(maneuverKind('depart', 'straight')).toBe('depart');
    expect(maneuverKind('arrive', undefined)).toBe('arrive');
    expect(maneuverKind('roundabout', 'right')).toBe('roundabout');
  });

  it('falls back to the modifier for plain turns', () => {
    expect(maneuverKind('turn', 'left')).toBe('left');
    expect(maneuverKind('turn', 'slight right')).toBe('slight-right');
    expect(maneuverKind('continue', 'uturn')).toBe('uturn');
  });

  it('degrades to "straight" for anything unrecognised', () => {
    expect(maneuverKind('something-new', 'sideways')).toBe('straight');
  });
});

describe('instructionFor', () => {
  it('names the road when there is one', () => {
    expect(instructionFor('left', 'Foleshill Road', 'Home', null)).toBe(
      'Turn left onto Foleshill Road',
    );
  });

  it('omits the road for unnamed ways rather than saying "onto"', () => {
    expect(instructionFor('right', '', 'Home', null)).toBe('Turn right');
  });

  it('counts roundabout exits', () => {
    expect(instructionFor('roundabout', 'A45', 'Home', 3)).toBe(
      'At the roundabout, take the 3rd exit onto A45',
    );
  });

  it('names the destination on arrival', () => {
    expect(instructionFor('arrive', '', 'Coventry Station', null)).toBe(
      'Arrive at Coventry Station',
    );
  });
});

describe('planRoute', () => {
  it('builds a self-contained route with per-step offsets', async () => {
    mockFetch(osrmReply());
    const route = await planRoute(A, B);

    expect(route.geometry).toHaveLength(3);
    expect(route.cumulativeM[0]).toBe(0);
    expect(route.steps).toHaveLength(3);
    expect(route.steps[0].startOffsetM).toBe(0);
    expect(route.steps[1].startOffsetM).toBe(700);
    expect(route.steps[1].instruction).toBe('Turn left onto Station Approach');
    expect(route.steps[2].kind).toBe('arrive');
    expect(route.distanceM).toBe(1400);
    expect(route.provider).toContain('OSRM');
  });

  it('never lets a step claim to start past the end of the geometry', async () => {
    mockFetch(osrmReply());
    const route = await planRoute(A, B);
    const total = route.cumulativeM[route.cumulativeM.length - 1];
    for (const step of route.steps) expect(step.startOffsetM).toBeLessThanOrEqual(total);
  });

  it('asks the router for a full polyline6 geometry with steps', async () => {
    mockFetch(osrmReply());
    await planRoute(A, B);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('/route/v1/driving/');
    expect(url).toContain('geometries=polyline6');
    expect(url).toContain('steps=true');
    expect(url).toContain('-1.52,52.4');
  });

  it('reports "no route" rather than returning an unusable object', async () => {
    mockFetch({ code: 'NoRoute' });
    await expect(planRoute(A, B)).rejects.toThrow(RoutingError);
  });

  it('rejects a reply whose geometry is missing', async () => {
    mockFetch({ code: 'Ok', routes: [{ distance: 10, legs: [] }] });
    await expect(planRoute(A, B)).rejects.toThrow(/no geometry/);
  });

  it('surfaces a network failure as a RoutingError, not a raw fetch error', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(planRoute(A, B)).rejects.toThrow(RoutingError);
  });
});

describe('searchPlaces', () => {
  it('does not call the geocoder for a one-character query', async () => {
    mockFetch([]);
    expect(await searchPlaces('a')).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('parses hits and biases the search towards the user', async () => {
    mockFetch([
      { place_id: 1, lat: '52.4008', lon: '-1.5', name: 'Coventry Station', display_name: 'Coventry Station, Coventry, UK' },
      { place_id: 2, lat: 'not-a-number', lon: '-1.5', display_name: 'Broken' },
    ]);
    const found = await searchPlaces('station', { latitude: 52.4, longitude: -1.52 });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Coventry Station');
    expect(found[0].address).toBe('Coventry, UK');
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('viewbox=');
  });
});

describe('placeFromPoint', () => {
  it('wraps a raw coordinate as a usable place', () => {
    const place = placeFromPoint({ latitude: 52.4, longitude: -1.52 });
    expect(place.source).toBe('map');
    expect(place.address).toBe('52.40000, -1.52000');
  });
});

describe('routeStore', () => {
  it('round-trips the active route, so a restart mid-outage keeps guiding', async () => {
    mockFetch(osrmReply());
    const route = await planRoute(A, B);
    await routeStore.save(route);
    const loaded = await routeStore.load();
    expect(loaded?.steps).toHaveLength(3);
    expect(loaded?.geometry).toHaveLength(3);
  });

  it('clears the route when asked', async () => {
    await routeStore.save(null);
    expect(await routeStore.load()).toBeNull();
  });

  it('rejects a corrupt stored route instead of crashing guidance', async () => {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem('matrix.route.v1', '{"geometry":[]}');
    expect(await routeStore.load()).toBeNull();
  });

  it('remembers searched destinations but not the live position', async () => {
    await routeStore.remember(B);
    await routeStore.remember({ ...B, id: 'device', source: 'device' });
    const recents = await routeStore.recents();
    expect(recents.filter((r) => r.source === 'device')).toHaveLength(0);
    expect(recents[0].id).toBe('b');
  });
});
