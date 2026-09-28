/**
 * Speaks the same turn-by-turn story the visual banner already tells: an
 * approach announcement, an imminent one, mode-change lines when GNSS is
 * lost or regained, and arrival.
 *
 * This is a thin side-effect binding — the timing decisions live in
 * `services/guidance.ts` (`voiceAnnouncementFor`) so they can be unit tested
 * without a device, and stay in lockstep with what the banner already shows.
 */
import { useEffect, useRef } from 'react';

import { formatDistance } from '@/services/format';
import { voiceAnnouncementFor, type VoiceAnnouncementKind } from '@/services/guidance';
import type { Units } from '@/services/storage';
import { speak, stopSpeaking } from '@/services/voice';
import type { GuidanceState, NavigationMode, Route } from '@/types';

export function useVoiceGuidance(
  route: Route | null,
  guidance: GuidanceState | null,
  mode: NavigationMode,
  units: Units,
  enabled: boolean,
) {
  const lastAnnounced = useRef<{ stepIndex: number; kind: VoiceAnnouncementKind } | null>(null);
  const arrivedSpoken = useRef(false);
  const lastMode = useRef(mode);
  const lastRoute = useRef(route);

  // A new plan (first one, or a reroute) starts the announcement/arrival
  // state fresh, since its step numbering starts over from zero.
  if (route !== lastRoute.current) {
    lastRoute.current = route;
    lastAnnounced.current = null;
    arrivedSpoken.current = false;
  }

  useEffect(() => {
    if (!enabled || !guidance || guidance.arrived) return;
    const step = guidance.nextStep ?? guidance.step;
    const announcement = voiceAnnouncementFor(step, guidance.distanceToManeuverM, lastAnnounced.current, (m) =>
      formatDistance(m, units),
    );
    if (!announcement) return;
    lastAnnounced.current = { stepIndex: announcement.stepIndex, kind: announcement.kind };
    speak(announcement.text);
  }, [enabled, guidance, units]);

  useEffect(() => {
    if (!enabled || !guidance?.arrived || arrivedSpoken.current) return;
    arrivedSpoken.current = true;
    speak('You have arrived at your destination.');
  }, [enabled, guidance?.arrived]);

  // Mode-change lines — the moment that matters most for a spoken interface,
  // since a driver who is not looking at the screen still needs to know the
  // position source just changed.
  useEffect(() => {
    if (mode === lastMode.current) return;
    const was = lastMode.current;
    lastMode.current = mode;
    if (!enabled) return;
    if (mode === 'DEAD_RECKONING') {
      speak('GPS signal lost. Continuing on inertial navigation.');
    } else if (mode === 'GNSS' && was === 'DEAD_RECKONING') {
      speak('GPS signal restored.');
    } else if (mode === 'DEGRADED') {
      speak('Position unavailable.');
    }
  }, [mode, enabled]);

  useEffect(() => {
    if (mode !== 'IDLE') return;
    lastAnnounced.current = null;
    arrivedSpoken.current = false;
    stopSpeaking();
  }, [mode]);

  // Never leave an utterance talking after the screen using this hook goes away.
  useEffect(() => stopSpeaking, []);
}
