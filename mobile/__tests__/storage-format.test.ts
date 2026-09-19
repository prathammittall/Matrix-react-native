import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  degToCardinal,
  formatClock,
  formatDistance,
  formatDuration,
  formatPercent,
  formatSigned,
  formatSpeed,
} from '@/services/format';
import { DEFAULT_SETTINGS, storage } from '@/services/storage';
import type { NavigationSession } from '@/types';

const session = (over: Partial<NavigationSession> = {}): NavigationSession => ({
  id: 'sess_1',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_600_000,
  distanceM: 5400,
  durationS: 600,
  gnssPath: [{ latitude: 52, longitude: -1.5 }],
  drPath: [],
  outages: [],
  gnssAvailability: 0.92,
  totalOutageS: 48,
  longestOutageS: 30,
  avgSpeedMps: 9,
  maxSpeedMps: 22,
  windowsInferred: 6000,
  source: 'LIVE',
  ...over,
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('storage — navigation history', () => {
  it('round-trips a session', async () => {
    await storage.saveSession(session());
    const all = await storage.loadSessions();
    expect(all).toHaveLength(1);
    expect(all[0].distanceM).toBe(5400);
  });

  it('returns newest first', async () => {
    await storage.saveSession(session({ id: 'a', startedAt: 1000 }));
    await storage.saveSession(session({ id: 'b', startedAt: 2000 }));
    expect((await storage.loadSessions()).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('replaces rather than duplicates a session with the same id', async () => {
    await storage.saveSession(session({ id: 'x', distanceM: 100 }));
    await storage.saveSession(session({ id: 'x', distanceM: 200 }));
    const all = await storage.loadSessions();
    expect(all).toHaveLength(1);
    expect(all[0].distanceM).toBe(200);
  });

  it('deletes one session and keeps the rest', async () => {
    await storage.saveSession(session({ id: 'a' }));
    await storage.saveSession(session({ id: 'b' }));
    await storage.deleteSession('a');
    expect((await storage.loadSessions()).map((s) => s.id)).toEqual(['b']);
  });

  it('survives corrupt stored data instead of crashing History', async () => {
    await AsyncStorage.setItem('matrix.sessions.v1', '{not json');
    expect(await storage.loadSessions()).toEqual([]);
  });

  it('skips malformed records inside an otherwise valid list', async () => {
    await AsyncStorage.setItem(
      'matrix.sessions.v1',
      JSON.stringify([session(), { id: 'broken' }, null, 42]),
    );
    expect(await storage.loadSessions()).toHaveLength(1);
  });
});

describe('storage — settings', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await storage.loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a stored partial with defaults, so a new setting gets its default', async () => {
    await AsyncStorage.setItem('matrix.settings.v1', JSON.stringify({ units: 'imperial' }));
    const s = await storage.loadSettings();
    expect(s.units).toBe('imperial');
    expect(s.mapStyle).toBe(DEFAULT_SETTINGS.mapStyle);
  });

  it('falls back to defaults on corrupt settings', async () => {
    await AsyncStorage.setItem('matrix.settings.v1', 'null');
    expect(await storage.loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('formatters', () => {
  it('formats distances metric and imperial', () => {
    expect(formatDistance(420)).toBe('420 m');
    expect(formatDistance(5400)).toBe('5.40 km');   // 2 dp below 10 km
    expect(formatDistance(42000)).toBe('42.0 km');  // 1 dp above it
    expect(formatDistance(1500)).toBe('1.50 km');
    expect(formatDistance(100, 'imperial')).toBe('328 ft');
    expect(formatDistance(5400, 'imperial')).toMatch(/mi$/);
  });

  it('formats speeds', () => {
    expect(formatSpeed(10)).toBe('36 km/h');
    expect(formatSpeed(10, 'imperial')).toBe('22 mph');
    expect(formatSpeed(null)).toBe('—');
  });

  it('formats durations at every magnitude', () => {
    expect(formatDuration(9)).toBe('9s');
    expect(formatDuration(95)).toBe('1m 35s');
    expect(formatDuration(3725)).toBe('1h 02m');
    expect(formatDuration(-1)).toBe('—');
  });

  it('formats an outage clock', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65)).toBe('01:05');
    expect(formatClock(-5)).toBe('00:00');
  });

  it('formats percentages and signed values', () => {
    expect(formatPercent(0.923)).toBe('92%');
    expect(formatSigned(2.5, 1, '°')).toBe('+2.5 °');
    expect(formatSigned(-2.5, 1)).toBe('-2.5');
    expect(formatSigned(null)).toBe('—');
  });

  it('never renders NaN to the user', () => {
    expect(formatDistance(NaN)).toBe('—');
    expect(formatSpeed(NaN)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
    expect(formatPercent(NaN)).toBe('—');
  });

  it('maps bearings to compass points', () => {
    expect(degToCardinal(0)).toBe('N');
    expect(degToCardinal(90)).toBe('E');
    expect(degToCardinal(181)).toBe('S');
    expect(degToCardinal(null)).toBe('—');
  });
});
