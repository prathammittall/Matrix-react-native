/**
 * Demo Mode data source.
 *
 * The demo sessions are bundled into the app, so a demo runs with the phone in
 * aeroplane mode — which is exactly the situation a judge is most likely to put
 * it in. The inference service is consulted only as a fallback, for the case
 * where a newer export exists on the backend than in this build.
 *
 * The payloads are the same files `backend/tools/export_demo_sessions.py`
 * writes: real recorded drives with the frozen models' stored predictions.
 * Nothing is generated at runtime.
 */
import { api } from './api';
import type { DemoSession, DemoSessionSummary } from '@/types';

import bundledIndex from '@/../assets/demo/index.json';
import sM00 from '@/../assets/demo/S-M_s00.json';
import sM01 from '@/../assets/demo/S-M_s01.json';

const BUNDLED: Record<string, DemoSession> = {
  'S-M_s00': sM00 as unknown as DemoSession,
  'S-M_s01': sM01 as unknown as DemoSession,
};

export type DemoOrigin = 'bundled' | 'service';

export interface DemoCatalogue {
  sessions: DemoSessionSummary[];
  origin: DemoOrigin;
}

export function bundledCatalogue(): DemoSessionSummary[] {
  const raw = bundledIndex as unknown as { sessions?: DemoSessionSummary[] };
  return (raw.sessions ?? []).filter((s) => s.id in BUNDLED);
}

/**
 * List demo sessions. Bundled data wins — it is always available, and it is the
 * data this build was verified against.
 */
export async function listDemoSessions(): Promise<DemoCatalogue> {
  const bundled = bundledCatalogue();
  if (bundled.length) return { sessions: bundled, origin: 'bundled' };
  const sessions = await api.demoSessions();
  return { sessions, origin: 'service' };
}

export async function loadDemoSession(
  id: string,
): Promise<{ session: DemoSession; origin: DemoOrigin }> {
  const local = BUNDLED[id];
  if (local) return { session: local, origin: 'bundled' };
  return { session: await api.demoSession(id), origin: 'service' };
}
