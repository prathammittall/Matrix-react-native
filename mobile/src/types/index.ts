/**
 * MATRIX domain types.
 *
 * Three states are kept deliberately separate (see FRONTEND_RUN.md, Architecture):
 *
 *   GnssState        what the GNSS receiver is doing        (sensor layer)
 *   InferenceState   what the ML service is doing           (ML layer)
 *   NavigationMode   which of those the app is navigating by (navigation layer)
 *
 * A GNSS outage does not by itself mean the app is dead reckoning: if the
 * inference service is unavailable, the mode becomes DEGRADED and the UI says so
 * rather than showing a position it cannot justify.
 */

// ---------------------------------------------------------------- sensors
/** One 6-axis IMU sample in the FROZEN model's units and channel order. */
export interface SensorSample {
  /** monotonic seconds since the sensor stream started */
  t: number;
  /** m/s^2, gravity RETAINED (the frozen model was trained this way) */
  acc_x: number;
  acc_y: number;
  acc_z: number;
  /** rad/s */
  gyro_x: number;
  gyro_y: number;
  gyro_z: number;
}

export interface GnssSample {
  latitude: number;
  longitude: number;
  /** metres per second */
  speed: number | null;
  /** degrees clockwise from true north */
  bearing: number | null;
  /** horizontal accuracy, metres */
  accuracy: number | null;
  altitude: number | null;
  /** device clock, ms */
  timestamp: number;
  /** sensor-stream clock, seconds — the same base as SensorSample.t */
  t: number;
}

export type GnssState = 'ACTIVE' | 'WEAK' | 'OUTAGE' | 'UNAVAILABLE';

export interface GnssStatus {
  state: GnssState;
  fix: GnssSample | null;
  /** seconds since the last accepted fix */
  age: number;
  /** why the layer classified the state as it did — shown in Diagnostics */
  reason: string;
  satellites: number | null;
}

// ------------------------------------------------------------------- ML
export type InferenceState = 'IDLE' | 'WARMING' | 'READY' | 'ERROR' | 'OFFLINE';

/** Telemetry from the frozen models for the most recent window. */
export interface MlTelemetry {
  timestamp_s: number;
  /** dv5 = v[t] - v[t-5], m/s over 0.5 s */
  delta_v: number;
  /** rad/s */
  yaw_rate: number;
  /** absolute-velocity anchor model, m/s */
  v_abs_pred: number;
}

export interface InferenceRequest {
  samples: SensorSample[];
}

export interface InferenceResponse {
  delta_v: number;
  yaw_rate: number;
  v_abs_pred: number;
  window_samples: number;
  features: string[];
  latency_ms: number;
}

export interface OutageAnchor {
  latitude: number;
  longitude: number;
  speed_mps: number;
  bearing_deg: number | null;
  timestamp_s: number | null;
}

/** Live dead-reckoning state returned by the service while an outage is open. */
export interface DeadReckoningState {
  active: true;
  samples: number;
  duration_s: number;
  latitude: number;
  longitude: number;
  velocity_mps: number;
  heading_deg: number;
  distance_m: number;
  delta_v: number | null;
  yaw_rate: number | null;
}

export interface ServiceSessionState {
  session_id: string;
  mode: 'GNSS' | 'DEAD_RECKONING';
  samples_ingested: number;
  windows_inferred: number;
  rejected_windows: number;
  buffer_fill: number;
  buffer_required: number;
  last_inference_ms: number | null;
  telemetry: MlTelemetry | null;
  outage: DeadReckoningState | null;
  completed_outages: number;
  k: number;
  tau_s: number;
}

export interface ModelInfo {
  name: string;
  version: string;
  device: string;
  window_samples: number;
  sampling_rate_hz: number;
  features: string[];
  prediction: string[];
  fusion: string;
  tau_s: number;
  k: number;
  dt_s: number;
  n_params_abs_v: number;
  n_params_delta_v: number;
  checkpoints: Record<string, unknown>;
  frozen: boolean;
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  model_loaded: boolean;
  detail: string | null;
  uptime_s: number;
  active_sessions: number;
  device: string | null;
  demo_sessions: number;
}

// ----------------------------------------------------------- navigation
export type NavigationMode =
  /** not navigating */
  | 'IDLE'
  /** GNSS is the position source */
  | 'GNSS'
  /** GNSS is gone and the frozen model is producing the position */
  | 'DEAD_RECKONING'
  /** GNSS is gone AND dead reckoning is not available — no trustworthy position */
  | 'DEGRADED';

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface OutageEvent {
  id: string;
  /** ms since epoch */
  startedAt: number;
  endedAt: number | null;
  durationS: number;
  anchor: OutageAnchor;
  /** dead-reckoned path produced by the frozen pipeline */
  path: LatLng[];
  estimated: LatLng | null;
  recovery: LatLng | null;
  /** distance between the dead-reckoned end point and the recovered GNSS fix */
  recoveryErrorM: number | null;
  headingErrorDeg: number | null;
  drDistanceM: number;
  /** set when dead reckoning could not run (service unavailable) */
  degraded: boolean;
}

export interface NavigationSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  /** metres, from the GNSS track plus dead-reckoned segments */
  distanceM: number;
  durationS: number;
  gnssPath: LatLng[];
  drPath: LatLng[];
  outages: OutageEvent[];
  /** fraction of session duration with a usable GNSS fix, 0..1 */
  gnssAvailability: number;
  totalOutageS: number;
  longestOutageS: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  windowsInferred: number;
  source: 'LIVE' | 'DEMO';
  demoSessionId?: string;
}

// ----------------------------------------------------------- demo mode
export interface DemoTrackPoint {
  t: number;
  lat: number;
  lon: number;
  speed_mps: number;
  accuracy_m: number | null;
  satellites: number | null;
}

export interface DemoOutage {
  duration_s: number;
  start_t: number;
  anchor: { latitude: number; longitude: number; speed_mps: number; bearing_deg: number; source: string };
  dr_path: [number, number][];
  truth_path: [number, number][];
  gnss_fixes: [number, number][];
  recovery: LatLng;
  estimated: { latitude: number; longitude: number; velocity_mps: number; heading_deg: number };
  final_error_m: number;
  mean_error_m: number;
  max_error_m: number;
  traj_rmse_m: number;
  heading_error_deg: number;
  drift_per_min_m: number;
  dr_distance_m: number;
  velocity_rmse_mps: number;
  registration: { residual_rms_m: number | null; gnss_fixes_used: number };
  velocity: { t: number; dr: number; truth: number }[];
  error_growth: { t: number; err: number }[];
}

export interface DemoSessionSummary {
  id: string;
  title: string;
  driver_id: string;
  split: string;
  duration_s: number;
  distance_km: number;
  outage_count: number;
  outage_durations: number[];
  vehicle: string;
  phone: string;
}

export interface DemoSession extends DemoSessionSummary {
  dataset_id: string;
  dt_s: number;
  tau_s: number;
  yaw_sign: number;
  gnss_update_interval_s: number;
  provenance: string;
  track: DemoTrackPoint[];
  outages: DemoOutage[];
}

// ---------------------------------------------------------- diagnostics
export type ComponentHealth = 'READY' | 'ACTIVE' | 'WARNING' | 'OFFLINE';

export interface SystemHealth {
  gnss: ComponentHealth;
  imu: ComponentHealth;
  model: ComponentHealth;
  api: ComponentHealth;
}

// ------------------------------------------------------------- routing
/**
 * A place the user can pick as a start or destination.
 *
 * `source` records where the coordinates came from, because a place derived
 * from the live fix must not be re-geocoded and must not be cached.
 */
export interface GeoPlace {
  id: string;
  /** short name shown in the field, e.g. "Coventry Station" */
  name: string;
  /** full address line shown underneath */
  address: string;
  latitude: number;
  longitude: number;
  source: 'search' | 'device' | 'map';
}

/** The manoeuvre kinds this app renders. OSRM types are mapped onto these. */
export type ManeuverKind =
  | 'depart'
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'uturn'
  | 'roundabout'
  | 'merge'
  | 'fork'
  | 'arrive';

export interface RouteStep {
  /** index within Route.steps */
  index: number;
  kind: ManeuverKind;
  /** "Turn left onto Foleshill Road" */
  instruction: string;
  /** road the step travels along, '' for unnamed service roads */
  roadName: string;
  /** length of this step, metres */
  distanceM: number;
  /** expected time for this step, seconds */
  durationS: number;
  /** distance from the route origin to where this manoeuvre happens */
  startOffsetM: number;
  /** where the manoeuvre happens */
  location: LatLng;
  /** roundabout exit number, when the router supplied one */
  exit: number | null;
}

export interface Route {
  id: string;
  origin: GeoPlace;
  destination: GeoPlace;
  /** full geometry, origin first */
  geometry: LatLng[];
  /** cumulative distance to geometry[i], metres. Same length as geometry. */
  cumulativeM: number[];
  steps: RouteStep[];
  distanceM: number;
  durationS: number;
  /** ms since epoch, so a cached route can be shown with its age */
  createdAt: number;
  /** which router produced it */
  provider: string;
}

/** Live guidance derived from the current position and a Route. */
export interface GuidanceState {
  /** distance travelled along the route, metres */
  distanceAlongM: number;
  distanceRemainingM: number;
  /** seconds remaining, from the router's own step durations */
  durationRemainingS: number;
  /** ms since epoch */
  etaAt: number;
  /** perpendicular distance from the route polyline, metres */
  offRouteM: number;
  onRoute: boolean;
  /** the step being driven now */
  step: RouteStep | null;
  /** the manoeuvre being approached */
  nextStep: RouteStep | null;
  /** the manoeuvre after that, for the "then ..." line */
  followingStep: RouteStep | null;
  distanceToManeuverM: number;
  /** the position projected onto the route — what the guidance line follows */
  snapped: LatLng;
  /** bearing of the route at the snapped point, degrees from north */
  routeBearingDeg: number;
  arrived: boolean;
}
