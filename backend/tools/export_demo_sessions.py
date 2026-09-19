"""Export Demo Mode data from the FROZEN artifacts.

Reads (read-only):
  model/experiments/complementary_fusion/predictions/dense/test/*.parquet
      -> stored predictions from BOTH frozen models plus the VBOX ground truth
         (v_true, yaw_true) recorded on the same drive
  model/preprocessing/smartphone_core/*.parquet
      -> the real GNSS fixes recorded on the same drive

Writes (outside model/):
  backend/demo_data/index.json          served by the API
  backend/demo_data/<session>.json
  mobile/assets/demo/*.json             bundled into the app, so Demo Mode also
                                        works with no network

What is real and what is derived
--------------------------------
* `dv_pred`, `yaw_pred_dv`, `v_abs_pred`  - stored outputs of the frozen models.
* `v_true`, `yaw_true`                    - recorded VBOX ground truth.
* fused velocity, heading, x/y            - produced by the frozen functions
  `v_abs_anchored`, `complementary(tau)` and `dead_reckon`, called unchanged.
* `final_error_m`, `traj_rmse_m`, ...     - computed between the AI track and the
  ground-truth track in the SAME planar frame the frozen evaluation uses, so
  they are directly comparable with `test_results/test_summary.csv`.
* latitude/longitude                      - a rotation of that planar frame onto
  the map (integration layer, `matrix_service.geo`). The rotation angle is fitted
  to the session's own GNSS fixes; it moves the whole picture, not the error.

Nothing is simulated. If the dense predictions are missing the script fails
loudly rather than producing a fabricated trajectory.

Usage:
    python backend/tools/export_demo_sessions.py
"""
import argparse
import json
import math
import os
import shutil
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matrix_service import config, geo                                  # noqa: E402
from matrix_service.frozen import (                                     # noqa: E402
    DT, complementary, dead_reckon, get_models, v_abs_anchored,
)

OUTAGES = [10, 30, 60, 120, 300]          # the frozen evaluation's durations
DENSE_TEST = os.path.join(config.FUSION_DIR, "predictions", "dense", "test")
CORE = os.path.join(config.PREPROCESSING_DIR, "smartphone_core")

TITLES = {
    "S-M_s00": "Coventry urban loop",
    "S-M_s01": "Coventry return leg",
}


class Gnss:
    """The session's distinct GNSS fixes (this dataset updates about every 9 s)."""

    def __init__(self, dataset_id: str, session_id: str):
        core = pd.read_parquet(os.path.join(CORE, "%s.parquet" % dataset_id))
        core = core[core.session_id == session_id].sort_values(
            ["timestamp_s", "row_index_original"])
        g = core.dropna(subset=["gps_latitude", "gps_longitude"])
        lat = g.gps_latitude.to_numpy(float)
        lon = g.gps_longitude.to_numpy(float)
        t = g.timestamp_s.to_numpy(float)
        changed = np.r_[0, np.where((np.diff(lat) != 0) | (np.diff(lon) != 0))[0] + 1]
        self.lat, self.lon, self.t = lat[changed], lon[changed], t[changed]
        self.speed_mps = (g.gps_speed_kmh.to_numpy(float)[changed]) / 3.6
        self.accuracy_m = g.gps_accuracy_m.to_numpy(float)[changed]
        self.satellites = g.gps_satellites_used.to_numpy(float)[changed]

    def at(self, t: float):
        return (float(np.interp(t, self.t, self.lat)),
                float(np.interp(t, self.t, self.lon)))

    def between(self, t0: float, t1: float):
        m = (self.t >= t0) & (self.t <= t1)
        return self.lat[m], self.lon[m], self.t[m]


def register_heading(x, y, times, gnss: Gnss, lat0: float, lon0: float):
    """Fit the compass bearing of the local +x axis to the session's GNSS fixes.

    Pure map registration: it rotates the planar track onto the map and has no
    effect on any error metric, which is computed in the planar frame.
    Returns (heading_deg, residual_rms_m, n_fixes).
    """
    flat, flon, ft = gnss.between(times[0], times[-1])
    if len(ft) < 4:
        # too few fixes: fall back to the straight-line bearing over the segment
        la1, lo1 = gnss.at(times[0])
        la2, lo2 = gnss.at(times[-1])
        return bearing_deg(la1, lo1, la2, lo2), float("nan"), len(ft)

    m_lat = math.pi * geo.R_EARTH / 180.0
    m_lon = m_lat * math.cos(math.radians(lat0))
    fn = (flat - lat0) * m_lat
    fe = (flon - lon0) * m_lon
    xi = np.interp(ft, times, x)
    yi = geo.YAW_SIGN * np.interp(ft, times, y)

    best = (float("inf"), 0.0)
    for hd in np.arange(0.0, 360.0, 0.25):
        r = math.radians(hd)
        c, s = math.cos(r), math.sin(r)
        rms = float(np.sqrt(np.mean((c * xi + s * yi - fn) ** 2 +
                                    (s * xi - c * yi - fe) ** 2)))
        if rms < best[0]:
            best = (rms, float(hd))
    return best[1], best[0], len(ft)


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def thin(values, step):
    idx = list(range(0, len(values), step))
    if idx[-1] != len(values) - 1:
        idx.append(len(values) - 1)
    return idx


def build_outage(d, gnss: Gnss, s0: int, length: int, tau: float):
    """Run the frozen pipeline over one outage window and score it against truth."""
    sl = slice(s0, s0 + length)
    times = d.timestamp_s.to_numpy(float)[sl]
    dv = d.dv_pred.to_numpy(float)[sl]
    va = d.v_abs_pred.to_numpy(float)[sl]
    yaw = d.yaw_pred_dv.to_numpy(float)[sl]
    vt = d.v_true.to_numpy(float)[sl]
    wt = d.yaw_true.to_numpy(float)[sl]
    v0 = float(vt[0])                     # the frozen evaluation's anchor

    va_anch = v_abs_anchored(va, v0)                      # frozen
    v = complementary(dv, va_anch, v0, tau)               # frozen (tau = 20 s)
    x, y, h = dead_reckon(v, yaw)                         # frozen
    xt, yt, ht = dead_reckon(vt, wt)                      # frozen, ground truth

    # error metrics in the planar frame, as in the frozen evaluation
    err = np.hypot(x - xt, y - yt)
    head_err = math.degrees(float(h[-1] - ht[-1]))
    head_err = (head_err + 180.0) % 360.0 - 180.0

    lat0, lon0 = gnss.at(float(times[0]))
    hdg0, reg_rms, n_fix = register_heading(xt, yt, times, gnss, lat0, lon0)

    lats, lons = geo.local_to_latlon(x, y, lat0, lon0, hdg0)
    tlats, tlons = geo.local_to_latlon(xt, yt, lat0, lon0, hdg0)
    flat, flon, ft = gnss.between(float(times[0]), float(times[-1]))

    step = max(1, length // 120)
    idx = thin(lats, step)
    cidx = thin(lats, max(1, length // 60))

    return {
        "duration_s": int(round(length * DT)),
        "start_t": round(float(times[0]), 2),
        "anchor": {
            "latitude": round(lat0, 7), "longitude": round(lon0, 7),
            "speed_mps": round(v0, 3), "bearing_deg": round(hdg0, 2),
            "source": "ground-truth VBOX velocity at outage start, as in the frozen evaluation",
        },
        "dr_path": [[round(lats[i], 7), round(lons[i], 7)] for i in idx],
        "truth_path": [[round(tlats[i], 7), round(tlons[i], 7)] for i in idx],
        "gnss_fixes": [[round(float(flat[i]), 7), round(float(flon[i]), 7)]
                       for i in range(len(ft))],
        "recovery": {"latitude": round(tlats[-1], 7), "longitude": round(tlons[-1], 7)},
        "estimated": {"latitude": round(lats[-1], 7), "longitude": round(lons[-1], 7),
                      "velocity_mps": round(float(v[-1]), 3),
                      "heading_deg": round(geo.bearing_from_frozen_heading(hdg0, float(h[-1])), 2)},
        "final_error_m": round(float(err[-1]), 2),
        "mean_error_m": round(float(err.mean()), 2),
        "max_error_m": round(float(err.max()), 2),
        "traj_rmse_m": round(float(np.sqrt((err ** 2).mean())), 2),
        "heading_error_deg": round(head_err, 2),
        "drift_per_min_m": round(float(err[-1]) / max(length * DT / 60.0, 1e-6), 2),
        "dr_distance_m": round(float(np.hypot(x[-1], y[-1])), 2),
        "velocity_rmse_mps": round(float(np.sqrt(((v - vt) ** 2).mean())), 3),
        "registration": {"residual_rms_m": (None if math.isnan(reg_rms) else round(reg_rms, 1)),
                         "gnss_fixes_used": int(n_fix)},
        "velocity": [{"t": round(i * DT, 1), "dr": round(float(v[i]), 2),
                      "truth": round(float(vt[i]), 2)} for i in cidx],
        "error_growth": [{"t": round(i * DT, 1), "err": round(float(err[i]), 1)}
                         for i in cidx],
    }


def pick_starts(d, length, count):
    """Outage starts during sustained motion, spread across the session."""
    ok = d.ok.to_numpy(bool)
    vt = d.v_true.to_numpy(float)
    n = len(d)
    cands = [s for s in range(0, n - length, 300)
             if ok[s:s + length].all() and np.isfinite(vt[s:s + length]).all()
             and vt[s] > 3.0 and vt[s:s + length].mean() > 4.0]
    if not cands:
        return []
    step = max(1, len(cands) // count)
    return cands[::step][:count]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=config.DEMO_DIR)
    ap.add_argument("--no-bundle", action="store_true",
                    help="skip copying into mobile/assets/demo/")
    args = ap.parse_args()

    if not os.path.isdir(DENSE_TEST) or not os.listdir(DENSE_TEST):
        raise SystemExit("Missing %s - run model/experiments/complementary_fusion/"
                         "generate_dense.py first (RUN.md section 9)." % DENSE_TEST)

    tau = get_models().tau
    os.makedirs(args.out, exist_ok=True)
    index = []

    for fname in sorted(os.listdir(DENSE_TEST)):
        if not fname.endswith(".parquet"):
            continue
        d = pd.read_parquet(os.path.join(DENSE_TEST, fname)).reset_index(drop=True)
        sid = str(d.session_id.iloc[0])
        did = str(d.dataset_id.iloc[0])
        times = d.timestamp_s.to_numpy(float)
        gnss = Gnss(did, sid)

        outages = []
        for T in OUTAGES:
            length = int(round(T / DT))
            for s0 in pick_starts(d, length, 3 if T <= 60 else 2):
                outages.append(build_outage(d, gnss, s0, length, tau))
        outages.sort(key=lambda o: (o["duration_s"], o["start_t"]))

        dist_km = sum(geo.haversine_m(gnss.lat[i - 1], gnss.lon[i - 1], gnss.lat[i], gnss.lon[i])
                      for i in range(1, len(gnss.lat))) / 1000.0

        payload = {
            "id": sid,
            "title": TITLES.get(sid, sid),
            "dataset_id": did,
            "driver_id": str(d.driver_id.iloc[0]),
            "split": str(d.split.iloc[0]),
            "vehicle": "Ford Fiesta Titanium",
            "phone": "Huawei P20 Pro",
            "dt_s": DT,
            "tau_s": tau,
            "yaw_sign": geo.YAW_SIGN,
            "duration_s": round(float(times[-1] - times[0]), 1),
            "distance_km": round(dist_km, 2),
            "gnss_update_interval_s": round(float(np.median(np.diff(gnss.t))), 1),
            "provenance": (
                "Real IO-VNBD test-split drive (driver B, unseen in training). "
                "Model outputs read from predictions/dense/test/%s; velocity fused and "
                "integrated by the frozen complementary filter (tau=%.0f s). Errors are "
                "measured against the recorded VBOX ground truth." % (fname, tau)),
            "track": [{"t": round(float(gnss.t[i] - times[0]), 1),
                       "lat": round(float(gnss.lat[i]), 7),
                       "lon": round(float(gnss.lon[i]), 7),
                       "speed_mps": round(float(gnss.speed_mps[i]), 2),
                       "accuracy_m": (None if not np.isfinite(gnss.accuracy_m[i])
                                      else round(float(gnss.accuracy_m[i]), 1)),
                       "satellites": (None if not np.isfinite(gnss.satellites[i])
                                      else int(gnss.satellites[i]))}
                      for i in range(len(gnss.t))],
            "outages": outages,
        }
        out = os.path.join(args.out, "%s.json" % sid)
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        index.append({"id": sid, "title": payload["title"], "driver_id": payload["driver_id"],
                      "split": payload["split"], "duration_s": payload["duration_s"],
                      "distance_km": payload["distance_km"],
                      "outage_count": len(outages),
                      "outage_durations": sorted({o["duration_s"] for o in outages}),
                      "vehicle": payload["vehicle"], "phone": payload["phone"]})
        med = {T: round(float(np.median([o["final_error_m"] for o in outages
                                         if o["duration_s"] == T])), 1)
               for T in OUTAGES}
        print("wrote %s  (%d outages, %.1f km) median final error by outage: %s"
              % (out, len(outages), payload["distance_km"], med))

    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"sessions": index,
                   "note": "Real recorded drives with stored frozen-model predictions."},
                  fh, indent=2)
    print("wrote %s" % os.path.join(args.out, "index.json"))

    if not args.no_bundle:
        bundle = os.path.join(config.PROJECT_ROOT, "mobile", "assets", "demo")
        os.makedirs(bundle, exist_ok=True)
        for entry in index:
            shutil.copy(os.path.join(args.out, "%s.json" % entry["id"]), bundle)
        shutil.copy(os.path.join(args.out, "index.json"), bundle)
        print("bundled %d demo session(s) into %s" % (len(index), bundle))


if __name__ == "__main__":
    main()
