import { useEffect, useRef, useState } from 'react';

import { TUNING } from '@/services/config';
import { engine, type EngineSnapshot } from '@/services/navigation-engine';
import type { SensorSnapshot } from '@/services/sensors';

/**
 * Subscribe to the navigation engine.
 *
 * The engine emits on every GNSS fix and every inference reply. That is well
 * under 10 Hz, but the snapshot is still coalesced onto an animation-friendly
 * interval so a burst cannot cause a render storm.
 */
export function useEngine(): EngineSnapshot {
  const [state, setState] = useState<EngineSnapshot>(() => engine.snapshot());
  const pending = useRef<EngineSnapshot | null>(null);

  useEffect(() => {
    const flush = setInterval(() => {
      if (pending.current) {
        setState(pending.current);
        pending.current = null;
      }
    }, TUNING.UI_REFRESH_MS);
    const unsubscribe = engine.subscribe((s) => {
      pending.current = s;
    });
    return () => {
      clearInterval(flush);
      unsubscribe();
    };
  }, []);

  return state;
}

/**
 * Poll the raw IMU snapshot on a fixed cadence.
 *
 * Raw samples land in a ring buffer at 10 Hz and are never pushed into React
 * state. This hook reads the latest values only while a panel that shows them is
 * mounted, so the sensor dashboard costs four renders a second and the rest of
 * the app costs none.
 */
export function useSensorSnapshot(
  active: boolean,
  intervalMs: number = TUNING.UI_REFRESH_MS,
): SensorSnapshot {
  const [snap, setSnap] = useState<SensorSnapshot>(() => engine.sensors.snapshot());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setSnap(engine.sensors.snapshot()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);

  return snap;
}
