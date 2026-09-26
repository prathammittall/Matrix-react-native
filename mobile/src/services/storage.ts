/**
 * Local persistence: navigation history and user settings.
 *
 * Sessions are stored as JSON in AsyncStorage. Every read is defensive — a
 * corrupt or partially written record is skipped rather than crashing History.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_API_URL } from './config';
import type { InferenceMode } from './inference-backend';
import type { NavigationSession } from '@/types';

const SESSIONS_KEY = 'matrix.sessions.v1';
const SETTINGS_KEY = 'matrix.settings.v1';
const MAX_SESSIONS = 50;

export type Units = 'metric' | 'imperial';
/** Basemaps MapLibre serves from free OpenStreetMap-compatible tiles.
 *  There is no satellite option: imagery needs a paid provider, and this
 *  app deliberately has no map billing dependency. */
export type MapStyle = 'standard' | 'terrain';

export interface Settings {
  units: Units;
  mapStyle: MapStyle;
  followVehicle: boolean;
  showGnssTrack: boolean;
  showDrTrack: boolean;
  keepAwake: boolean;
  hapticsOnModeChange: boolean;
  voiceGuidance: boolean;
  technicalDetails: boolean;
  apiUrl: string;
  /** where the frozen model runs: on the phone, on the service, or prefer-local */
  inferenceMode: InferenceMode;
}

export const DEFAULT_SETTINGS: Settings = {
  units: 'metric',
  mapStyle: 'standard',
  followVehicle: true,
  showGnssTrack: true,
  showDrTrack: true,
  keepAwake: true,
  hapticsOnModeChange: true,
  voiceGuidance: true,
  technicalDetails: false,
  apiUrl: DEFAULT_API_URL,
  // On-device by default: it is the only mode that survives a tunnel with no
  // signal, which is the case the product exists for.
  inferenceMode: 'ondevice',
};

function isSession(v: unknown): v is NavigationSession {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.startedAt === 'number' &&
    Array.isArray(s.gnssPath) &&
    Array.isArray(s.outages)
  );
}

export const storage = {
  async loadSessions(): Promise<NavigationSession[]> {
    try {
      const raw = await AsyncStorage.getItem(SESSIONS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isSession).sort((a, b) => b.startedAt - a.startedAt);
    } catch {
      return [];
    }
  },

  async saveSession(session: NavigationSession): Promise<void> {
    const all = await storage.loadSessions();
    const next = [session, ...all.filter((s) => s.id !== session.id)].slice(0, MAX_SESSIONS);
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(next));
  },

  async deleteSession(id: string): Promise<void> {
    const all = await storage.loadSessions();
    await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(all.filter((s) => s.id !== id)));
  },

  async clearSessions(): Promise<void> {
    await AsyncStorage.removeItem(SESSIONS_KEY);
  },

  async loadSettings(): Promise<Settings> {
    try {
      const raw = await AsyncStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
      // merge so a settings key added in a later build gets its default
      return { ...DEFAULT_SETTINGS, ...(parsed as Partial<Settings>) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },

  async saveSettings(settings: Settings): Promise<void> {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  },
};
