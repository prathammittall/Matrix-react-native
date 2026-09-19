"""Prove the streaming API reproduces the offline frozen pipeline exactly.

Replays real IMU samples from a test session through the live HTTP API as if a
phone were streaming them, simulates a GNSS outage, and compares the resulting
dead-reckoned end point with the same outage computed offline by calling the
frozen functions directly. Any divergence means the serving layer has altered
the pipeline - which it must never do.

Usage:
    python backend/tools/streaming_parity_check.py [--url http://127.0.0.1:8008]
"""
import argparse
import json
import math
import os
import sys
import urllib.request

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matrix_service import config, geo                                  # noqa: E402
from matrix_service.frozen import (                                     # noqa: E402
    DT, FEATS, WINDOW, complementary, dead_reckon, get_models, v_abs_anchored,
)

sys.path.insert(0, config.DELTA_V_DIR)
from dv_common import session_frame                                     # noqa: E402  frozen


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8008")
    ap.add_argument("--session", default="S-M_s00")
    ap.add_argument("--dataset", default="S-M")
    ap.add_argument("--outage", type=int, default=60, help="outage length in seconds")
    ap.add_argument("--start", type=int, default=4000, help="start row in the session")
    args = ap.parse_args()
    api = args.url.rstrip("/") + "/api/v1"

    # --- the same bias-corrected session frame the frozen pipeline uses --------
    S = session_frame(args.dataset, args.session)
    feats = S[list(FEATS)].to_numpy(float)
    times = S.timestamp_s.to_numpy(float)

    n_out = int(args.outage / DT)
    warm = args.start - WINDOW + 1                    # fill the rolling window first
    total = args.start + n_out
    assert warm > 0 and total <= len(feats), "start/outage out of range for this session"

    anchor = {"latitude": 52.4, "longitude": -1.5, "speed_mps": 12.0,
              "bearing_deg": 0.0, "timestamp_s": float(times[args.start])}

    # --- streaming path: through the HTTP API --------------------------------
    sid = post(api + "/sessions", {})["session_id"]
    def send(lo, hi):
        for i in range(lo, hi, 50):
            block = [dict(t=float(times[j]), **{f: float(feats[j][k])
                                                for k, f in enumerate(FEATS)})
                     for j in range(i, min(i + 50, hi))]
            post(api + "/sessions/%s/samples" % sid, {"samples": block})

    send(warm, args.start)
    post(api + "/sessions/%s/outage/start" % sid, anchor)
    send(args.start, total)
    live = post(api + "/sessions/%s/outage/end" % sid, {})["outage"]

    # --- offline path: frozen functions called directly ----------------------
    m = get_models()
    W = np.stack([feats[i - WINDOW + 1:i + 1] for i in range(args.start, total)]).astype(np.float32)
    v_abs, dv, yaw = m.infer(W)
    va_anch = v_abs_anchored(v_abs, anchor["speed_mps"])
    v = complementary(dv, va_anch, anchor["speed_mps"], m.tau)
    x, y, h = dead_reckon(v, yaw)
    lat, lon = geo.local_to_latlon(x, y, anchor["latitude"], anchor["longitude"],
                                   anchor["bearing_deg"])

    # --- compare --------------------------------------------------------------
    est = live["estimated"]
    d_m = geo.haversine_m(est["latitude"], est["longitude"], lat[-1], lon[-1])
    dv_err = abs(est["velocity_mps"] - float(v[-1]))
    print("outage %d s | streamed samples %d | offline windows %d"
          % (args.outage, live["samples"], len(W)))
    print("  streaming end  %.7f, %.7f  v=%.4f m/s" % (est["latitude"], est["longitude"],
                                                       est["velocity_mps"]))
    print("  offline   end  %.7f, %.7f  v=%.4f m/s" % (lat[-1], lon[-1], float(v[-1])))
    print("  position difference %.6f m | velocity difference %.6f m/s" % (d_m, dv_err))

    # Tolerance is float noise only: the streaming path batches 50 windows per
    # request while the offline path runs one batch of 600, and GPU kernels are
    # not bit-identical across batch sizes. Anything above this would mean the
    # serving layer had actually changed the pipeline.
    ok = live["samples"] == len(W) and d_m < 0.01 and dv_err < 1e-3
    print("\nPARITY %s" % ("OK - the serving layer does not alter the frozen pipeline"
                           if ok else "FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
