"""Generate golden vectors for the on-device port of the frozen fusion.

Offline inference needs the complementary filter and the dead-reckoning
integration to run on the phone, in TypeScript. That is a port of frozen
mathematics, so it must be held to the frozen implementation rather than merely
resembling it.

This script runs the FROZEN functions (`v_abs_anchored`, `complementary`,
`dead_reckon`) over real outage segments from the test split and writes their
exact inputs and outputs. `mobile/__tests__/frozen-fusion.test.ts` replays those
vectors through the TypeScript port and fails if it disagrees by more than float
noise — so the port cannot drift away from the model without a red test.

Usage:
    python backend/tools/export_fusion_golden.py
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matrix_service import config                                        # noqa: E402
from matrix_service.frozen import (                                      # noqa: E402
    DT, K, complementary, dead_reckon, get_models, v_abs_anchored,
)

OUT = os.path.join(config.PROJECT_ROOT, "mobile", "__tests__", "fixtures",
                   "fusion_golden.json")
DENSE_TEST = os.path.join(config.FUSION_DIR, "predictions", "dense", "test")
# lengths in samples: 10 s, 30 s, 60 s, 300 s, plus a 1-sample degenerate case
CASES = [(1, 4000), (100, 3000), (300, 6000), (600, 9000), (3000, 12000)]


def main():
    tau = get_models().tau
    d = pd.read_parquet(os.path.join(DENSE_TEST, "S-M_s00.parquet")).reset_index(drop=True)
    dv_all = d.dv_pred.to_numpy(float)
    va_all = d.v_abs_pred.to_numpy(float)
    yaw_all = d.yaw_pred_dv.to_numpy(float)
    vt_all = d.v_true.to_numpy(float)

    cases = []
    for length, start in CASES:
        sl = slice(start, start + length)
        dv = dv_all[sl]
        va = va_all[sl]
        yaw = yaw_all[sl]
        v0 = float(vt_all[start])

        va_anch = v_abs_anchored(va, v0)          # frozen
        v = complementary(dv, va_anch, v0, tau)   # frozen
        x, y, h = dead_reckon(v, yaw)             # frozen

        cases.append({
            "name": "%ds outage from sample %d" % (round(length * DT), start),
            "length": int(length),
            "v0": v0,
            "tau": tau,
            "input": {
                "dv": [float(q) for q in dv],
                "va": [float(q) for q in va],
                "yaw": [float(q) for q in yaw],
            },
            "expected": {
                "va_anchored": [float(q) for q in va_anch],
                "v": [float(q) for q in v],
                "x": [float(q) for q in x],
                "y": [float(q) for q in y],
                "h": [float(q) for q in h],
            },
        })
        print("  %-28s v0=%6.2f  v[-1]=%7.3f  x[-1]=%9.2f  y[-1]=%9.2f  h[-1]=%7.3f"
              % (cases[-1]["name"], v0, v[-1], x[-1], y[-1], h[-1]))

    # a case that exercises the velocity floor: a hard brake from a slow anchor
    n = 200
    dv = np.full(n, -1.0)                  # sustained deceleration
    va = np.zeros(n)
    yaw = np.zeros(n)
    v0 = 2.0
    va_anch = v_abs_anchored(va, v0)
    v = complementary(dv, va_anch, v0, tau)
    x, y, h = dead_reckon(v, yaw)
    cases.append({
        "name": "velocity floor (sustained braking to a stop)",
        "length": n, "v0": v0, "tau": tau,
        "input": {"dv": list(dv), "va": list(va), "yaw": list(yaw)},
        "expected": {
            "va_anchored": [float(q) for q in va_anch],
            "v": [float(q) for q in v],
            "x": [float(q) for q in x],
            "y": [float(q) for q in y],
            "h": [float(q) for q in h],
        },
    })
    print("  %-28s min v = %.6f (must be exactly 0.0)"
          % ("velocity floor", float(v.min())))

    payload = {
        "_comment": ("Golden vectors produced by the FROZEN Python functions "
                     "v_abs_anchored / complementary / dead_reckon in "
                     "model/experiments/complementary_fusion/phase2_4_fusion_select.py. "
                     "Regenerate with backend/tools/export_fusion_golden.py."),
        "source_session": "S-M_s00 (test split, driver B)",
        "dt": DT,
        "k": K,
        "tau": tau,
        "cases": cases,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print("\nwrote %s (%.0f KB, %d cases)"
          % (OUT, os.path.getsize(OUT) / 1024, len(cases)))


if __name__ == "__main__":
    main()
