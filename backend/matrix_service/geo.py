"""Geodetic projection for the integration layer.

NOT part of the frozen model. The frozen `dead_reckon` produces a planar track
(x, y, heading) in a body-aligned local frame whose +x axis is the heading at the
anchor and whose heading is measured counter-clockwise from that axis. Turning
that planar track into WGS-84 latitude/longitude is a map-rendering concern, so
it lives here rather than in `model/`.

Convention
----------
`heading0_deg` is the compass bearing (clockwise from true north) at the anchor.
The frozen heading `h` grows counter-clockwise, so the compass bearing at step t
is `heading0 - h[t]`. Substituting that into the frozen sums gives

    north = cos(heading0) * x + sin(heading0) * y
    east  = sin(heading0) * x - cos(heading0) * y

which is the rotation applied below. `YAW_SIGN` records the one convention that
is genuinely a choice: whether a positive frozen `yaw_rate` is a left turn.
It is +1 (positive yaw_rate = counter-clockwise = left), matching the frozen
target definition; it is validated against real GNSS tracks by
`backend/tools/validate_geo_convention.py`.
"""
import math

R_EARTH = 6_378_137.0  # WGS-84 semi-major axis, metres
YAW_SIGN = 1.0


def local_to_latlon(x, y, lat0_deg: float, lon0_deg: float, heading0_deg: float):
    """Rotate frozen local (x, y) metres into a lat/lon offset from the anchor.

    Accepts scalars or sequences; returns the same shape as (lat, lon) lists.
    """
    h0 = math.radians(heading0_deg)
    ch, sh = math.cos(h0), math.sin(h0)
    lat0 = math.radians(lat0_deg)
    m_per_deg_lat = math.pi * R_EARTH / 180.0
    m_per_deg_lon = m_per_deg_lat * max(math.cos(lat0), 1e-6)

    scalar = not hasattr(x, "__len__")
    xs = [float(x)] if scalar else [float(v) for v in x]
    ys = [float(y)] if scalar else [float(v) for v in y]

    lats, lons = [], []
    for xv, yv in zip(xs, ys):
        yv = YAW_SIGN * yv          # flipping the yaw convention mirrors y (y = sum v sin h)
        north = ch * xv + sh * yv
        east = sh * xv - ch * yv
        lats.append(lat0_deg + north / m_per_deg_lat)
        lons.append(lon0_deg + east / m_per_deg_lon)
    if scalar:
        return lats[0], lons[0]
    return lats, lons


def bearing_from_frozen_heading(heading0_deg: float, h_rad: float) -> float:
    """Compass bearing (0-360) for a frozen local heading `h` (radians, CCW)."""
    return (heading0_deg - YAW_SIGN * math.degrees(h_rad)) % 360.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.asin(min(1.0, math.sqrt(a)))
