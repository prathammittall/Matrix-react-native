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
  /** GNSS is WEAK above this horizontal accuracy */
  ACCURACY_WEAK_M: 25,
  /** GNSS is treated as an OUTAGE above this horizontal accuracy */
  ACCURACY_OUTAGE_M: 60,
  /** a fix older than this is stale -> OUTAGE */
  FIX_TIMEOUT_S: 5,
  /** a fix older than this is ageing -> WEAK */
  FIX_STALE_S: 2.5,
  /** consecutive bad classifications before the mode actually switches
   *  (debounce, so one dropped fix does not flip the whole UI) */
  OUTAGE_CONFIRM_SAMPLES: 2,
  RECOVERY_CONFIRM_SAMPLES: 2,
  /** network timeout for one inference call */
  REQUEST_TIMEOUT_MS: 8000,
  /** consecutive request failures before the service is declared OFFLINE */
  FAILURES_BEFORE_OFFLINE: 3,
  /** cap on points kept in a rendered polyline (map performance) */
  MAX_POLYLINE_POINTS: 1200,
} as const;
