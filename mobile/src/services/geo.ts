/**
 * Geodetic projection for on-device dead reckoning.
 *
 * A direct port of `backend/matrix_service/geo.py`. NOT part of the frozen
 * model: the frozen `deadReckon` produces a planar track whose +x axis is the
 * heading at the anchor and whose heading grows counter-clockwise. Turning that
 * into WGS-84 latitude/longitude is map projection, and it cannot change an
 * error metric — only where the picture is drawn.
 *
 * `YAW_SIGN` is the one genuine convention choice: whether a positive frozen
 * yaw rate is a left turn. It is +1, established empirically against real GNSS
 * tracks by `backend/tools/validate_geo_convention.py` (median residual 15.8 m
 * for +1 versus 131.4 m for -1), and must stay in step with the Python constant.
 */
export const R_EARTH = 6378137.0;
export const YAW_SIGN = 1.0;

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = (Math.PI * R_EARTH) / 180;

export interface LocalToLatLngAnchor {
  lat0: number;
  lon0: number;
  /** compass bearing of the local +x axis, degrees clockwise from north */
  heading0Deg: number;
}

/** Rotate one frozen local (x, y) in metres onto latitude/longitude. */
export function localToLatLng(
  x: number,
  y: number,
  { lat0, lon0, heading0Deg }: LocalToLatLngAnchor,
): { latitude: number; longitude: number } {
  const h0 = heading0Deg * DEG;
  const ch = Math.cos(h0);
  const sh = Math.sin(h0);
  const mPerDegLon = M_PER_DEG_LAT * Math.max(Math.cos(lat0 * DEG), 1e-6);

  const yv = YAW_SIGN * y; // flipping the yaw convention mirrors y (y = Σ v sin h)
  const north = ch * x + sh * yv;
  const east = sh * x - ch * yv;

  return {
    latitude: lat0 + north / M_PER_DEG_LAT,
    longitude: lon0 + east / mPerDegLon,
  };
}

/** Compass bearing (0–360) for a frozen local heading `h` in radians. */
export function bearingFromFrozenHeading(heading0Deg: number, hRad: number): number {
  return (((heading0Deg - (YAW_SIGN * hRad) / DEG) % 360) + 360) % 360;
}
