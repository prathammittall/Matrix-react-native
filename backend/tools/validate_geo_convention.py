"""Validate `matrix_service.geo.YAW_SIGN` against recorded GNSS.

The frozen model predicts a yaw RATE. Whether a positive yaw rate means a left
turn (counter-clockwise) or a right turn is a frame convention in the
integration layer, not a model property - so it is settled empirically here
rather than assumed.

Method: dead-reckon the recorded VBOX ground truth (`v_true`, `yaw_true`) over
120 s segments of the test sessions using the frozen `dead_reckon`, then for
each candidate sign find the best-fitting map rotation and report the residual
against that segment's real GNSS fixes. The correct sign wins by a wide margin.

Usage:
    python backend/tools/validate_geo_convention.py
"""
import math
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matrix_service import config, geo                       # noqa: E402
from matrix_service.frozen import dead_reckon                # noqa: E402
from export_demo_sessions import Gnss, DENSE_TEST            # noqa: E402

SEGMENT = 1200          # 120 s at 10 Hz


def best_rotation_rms(x, y, times, gnss, lat0, lon0, sign):
    flat, flon, ft = gnss.between(float(times[0]), float(times[-1]))
    if len(ft) < 5:
        return None
    m_lat = math.pi * geo.R_EARTH / 180.0
    m_lon = m_lat * math.cos(math.radians(lat0))
    fn = (flat - lat0) * m_lat
    fe = (flon - lon0) * m_lon
    xi = np.interp(ft, times, x)
    yi = sign * np.interp(ft, times, y)
    best = float("inf")
    for hd in np.arange(0.0, 360.0, 1.0):
        r = math.radians(hd)
        c, s = math.cos(r), math.sin(r)
        best = min(best, float(np.sqrt(np.mean((c * xi + s * yi - fn) ** 2 +
                                               (s * xi - c * yi - fe) ** 2))))
    return best


def main():
    print("Validating geo.YAW_SIGN (currently %+d) over %d s segments\n"
          % (geo.YAW_SIGN, SEGMENT // 10))
    totals = {1.0: [], -1.0: []}
    for fname in sorted(os.listdir(DENSE_TEST)):
        if not fname.endswith(".parquet"):
            continue
        d = pd.read_parquet(os.path.join(DENSE_TEST, fname)).reset_index(drop=True)
        sid, did = str(d.session_id.iloc[0]), str(d.dataset_id.iloc[0])
        gnss = Gnss(did, sid)
        times = d.timestamp_s.to_numpy(float)
        ok = d.ok.to_numpy(bool)
        v = d.v_true.to_numpy(float)
        w = d.yaw_true.to_numpy(float)
        per = {1.0: [], -1.0: []}
        for s0 in range(0, len(d) - SEGMENT, 1500):
            sl = slice(s0, s0 + SEGMENT)
            if not ok[sl].all() or not np.isfinite(v[sl]).all() or v[sl].mean() < 4.0:
                continue
            x, y, _ = dead_reckon(v[sl], w[sl])
            lat0, lon0 = gnss.at(float(times[s0]))
            for sign in (1.0, -1.0):
                r = best_rotation_rms(x, y, times[sl], gnss, lat0, lon0, sign)
                if r is not None:
                    per[sign].append(r)
                    totals[sign].append(r)
        for sign in (1.0, -1.0):
            a = np.array(per[sign])
            print("  %-10s yaw_sign=%+d  n=%2d  median residual %7.1f m"
                  % (sid, sign, len(a), np.median(a) if len(a) else float("nan")))

    print()
    meds = {s: float(np.median(totals[s])) for s in (1.0, -1.0) if totals[s]}
    winner = min(meds, key=meds.get)
    print("overall median residual: +1 -> %.1f m, -1 -> %.1f m"
          % (meds.get(1.0, float("nan")), meds.get(-1.0, float("nan"))))
    print("best convention: YAW_SIGN = %+d" % winner)
    if winner != geo.YAW_SIGN:
        print("MISMATCH: matrix_service/geo.py has YAW_SIGN = %+d" % geo.YAW_SIGN)
        raise SystemExit(1)
    print("matrix_service/geo.py agrees.")


if __name__ == "__main__":
    main()
