/**
 * Spoken turn-by-turn output.
 *
 * A thin wrapper around `expo-speech` — the only state it owns is "stop
 * whatever was being said before saying the next thing", so a fast sequence
 * of updates (e.g. a mode change right on top of a manoeuvre) never queues up
 * behind itself and reads out stale lines.
 */
import * as Speech from 'expo-speech';

export function speak(text: string) {
  Speech.stop();
  Speech.speak(text, { rate: 1.0 });
}

export function stopSpeaking() {
  Speech.stop();
}
