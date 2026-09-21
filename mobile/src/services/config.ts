import { Platform } from 'react-native';

/**
 * Runtime configuration.
 *
 * No secrets live in source. `EXPO_PUBLIC_*` variables come from `mobile/.env`
 * (see `.env.example`) and are inlined by Expo at build time.
 *
 * There is no map API key: maps are rendered by MapLibre from OpenStreetMap
 * tiles. The inference-service URL below is OPTIONAL — navigation inference
 * runs on-device, and the service is used only for diagnostics and session
 * upload.
 */

/** Android emulators reach the host machine at 10.0.2.2, not localhost. */
const DEFAULT_HOST = Platform.select({ android: '10.0.2.2', default: '127.0.0.1' });

export const DEFAULT_API_URL =
  process.env.EXPO_PUBLIC_MATRIX_API_URL?.replace(/\/+$/, '') ?? `http://${DEFAULT_HOST}:8000`;

/** The FROZEN input contract. These are read from the service at runtime and
 *  verified against these constants; they are never used to reshape data. */
export const FROZEN = {
  WINDOW_SAMPLES: 50,
  SAMPLE_RATE_HZ: 10,
  SAMPLE_INTERVAL_MS: 100,
  FEATURES: ['acc_x', 'acc_y', 'acc_z', 'gyro_x', 'gyro_y', 'gyro_z'] as const,
  K: 5,
  TAU_S: 20,
} as const;

/** Standard gravity — expo-sensors reports acceleration in g, the frozen model
 *  was trained on m/s^2 with gravity retained. */
export const G = 9.80665;

export const TUNING = {
  /** how often a batch of samples is posted to the inference service */
  UPLOAD_INTERVAL_MS: 1000,
  /** how often the UI re-reads high-rate buffers (sensor values are throttled,
   *  not rendered per sample) */
  UI_REFRESH_MS: 250,
  /** how often the engine re-evaluates GNSS health and republishes a snapshot.
   *  GNSS staleness is a function of the CLOCK, not of fix arrivals: without a
   *  heartbeat, "no fix for 6 s" can never be observed, because the only thing
   *  that used to trigger a re-classification was a fix arriving. */
  HEARTBEAT_MS: 500,

  // --- GNSS health thresholds -------------------------------------------
  // Two thresholds per transition, never one. A receiver sitting on a
  // boundary would otherwise oscillate, and every oscillation is a mode flip
  // the driver sees. Entering a worse state needs the worse number; leaving it
  // needs the better one (hysteresis).
  /** GNSS becomes WEAK above this horizontal accuracy... */
  ACCURACY_WEAK_M: 30,
  /** ...and is only ACTIVE again below this one */
  ACCURACY_WEAK_CLEAR_M: 22,
  /** GNSS is treated as an OUTAGE above this horizontal accuracy...
   *  A phone that falls back to cell/Wi-Fi positioning reports 50-100 m, and a
   *  first fix in a cold start is routinely 40-80 m. Both are still a usable
   *  position. Only a genuinely uninformative fix is an outage. */
  ACCURACY_OUTAGE_M: 150,
  /** ...and stops being one below this */
  ACCURACY_OUTAGE_CLEAR_M: 110,
  /** a fix older than this is stale -> OUTAGE. Android's fused provider under
   *  BestForNavigation delivers ~1 Hz but skips beats under load, so this has
   *  to tolerate several missed beats before calling the receiver dead. */
  FIX_TIMEOUT_S: 6,
  /** a fix older than this is ageing -> WEAK */
  FIX_STALE_S: 3,

  // --- mode confirmation (seconds, not samples) -------------------------
  // Sample counts are meaningless when the callers tick at different rates:
  // the old 2-sample debounce was satisfied by one GNSS fix plus one inference
  // reply ~50 ms apart, so a single bad reading flipped the app into dead
  // reckoning. Time is the honest unit for "has this really happened?".
  /** GNSS must look lost continuously for this long before the AI takes over */
  OUTAGE_CONFIRM_S: 3,
  /** and must look healthy this long before GNSS is trusted again */
  RECOVERY_CONFIRM_S: 1.5,
  /** network timeout for one inference call */
  REQUEST_TIMEOUT_MS: 8000,
  /** consecutive request failures before the service is declared OFFLINE */
  FAILURES_BEFORE_OFFLINE: 3,
  /** cap on points kept in a rendered polyline (map performance) */
  MAX_POLYLINE_POINTS: 1200,
} as const;
