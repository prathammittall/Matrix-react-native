"""Export the FROZEN checkpoints to ONNX for on-device inference.

This is an EXPORT, not a modification. It:

  * loads `best_k5_huber.pt` and `best_huber.pt` read-only,
  * traces the frozen `MatrixBaseline` architecture in eval mode,
  * writes ONNX graphs OUTSIDE `model/` (into `mobile/assets/models/`),
  * writes the frozen scalers and fusion constants alongside them, copied
    verbatim from `scaler.json` and the checkpoints, and
  * VERIFIES the export by running real IMU windows from the test split through
    both PyTorch and ONNX Runtime and comparing the outputs.

Nothing under `model/` is read except as input, and nothing is written there.
Weights, architecture, feature order, scaler and target scalers are carried
across unchanged; `model/RUN.md` section 17 gap #7 is what this closes.

Usage:
    python backend/tools/export_onnx.py
    python backend/tools/export_onnx.py --verify-only
"""
import argparse
import json
import os
import shutil
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matrix_service import config                                        # noqa: E402
from matrix_service.frozen import (                                      # noqa: E402
    DT, FEATS, FMU, FSD, K, WINDOW, get_models, sha256,
)

OUT_DIR = os.path.join(config.PROJECT_ROOT, "mobile", "assets", "models")
OPSET = 17
# Accuracy budget for the export. The frozen model's own outputs are O(1) in
# magnitude (dv in m/s, yaw in rad/s), so 1e-4 is far below any level that could
# move a dead-reckoning metric, and float32 graph reordering alone accounts for
# most of what is left.
TOLERANCE = 1e-4


def export_one(model, path, name):
    dummy = torch.zeros(1, WINDOW, len(FEATS), dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        path,
        input_names=["window"],
        output_names=["prediction"],
        dynamic_axes={"window": {0: "batch"}, "prediction": {0: "batch"}},
        opset_version=OPSET,
        do_constant_folding=True,
        dynamo=False,
    )
    size = os.path.getsize(path)
    print("  %-28s %7.1f KB  opset %d" % (name, size / 1024, OPSET))
    return size


def real_windows(n=256):
    """Real IMU windows from the frozen test split, bias-corrected as in training."""
    sys.path.insert(0, config.DELTA_V_DIR)
    from dv_common import dense, session_frame            # frozen

    S = session_frame("S-M", "S-M_s00")
    X, _, ok = dense(S)
    X = X[ok][:n]
    return np.ascontiguousarray(X, dtype=np.float32)


def verify(models, paths):
    """Compare ONNX against PyTorch on real windows.

    Both sides run on CPU, deliberately: ONNX Runtime on the phone is a CPU
    execution provider, so CPU-vs-CPU measures what actually ships. Comparing
    against the CUDA graph instead would fold in GPU-vs-CPU kernel differences
    (order 1e-4 for a GRU) that have nothing to do with the export.
    """
    import onnxruntime as ort

    X = real_windows()
    print("\nverifying on %d real test-split windows (PyTorch CPU vs ONNX Runtime CPU)"
          % len(X))
    Xs = ((X - FMU) / FSD).astype(np.float32)

    results = {}
    worst = 0.0
    for key, (torch_model, tmu, tsd) in models.items():
        sess = ort.InferenceSession(paths[key], providers=["CPUExecutionProvider"])
        onnx_raw = sess.run(None, {"window": Xs})[0]
        with torch.no_grad():
            torch_raw = torch_model(torch.from_numpy(Xs)).numpy()

        # compare in physical units, which is what the pipeline consumes
        onnx_phys = onnx_raw * tsd + tmu
        torch_phys = torch_raw * tsd + tmu
        diff = np.abs(onnx_phys - torch_phys)
        per_output = diff.max(axis=0)
        worst = max(worst, float(diff.max()))
        results[key] = {
            "max_abs_diff": float(diff.max()),
            "mean_abs_diff": float(diff.mean()),
            "max_abs_diff_per_output": [float(v) for v in per_output],
            "reference_output_std": [float(v) for v in torch_phys.std(axis=0)],
        }
        print("  %-10s max |onnx - torch| = %.3e   mean = %.3e   (outputs: %s)"
              % (key, diff.max(), diff.mean(),
                 ", ".join("%.2e" % v for v in per_output)))

    ok = worst < TOLERANCE
    print("\n%s  worst difference %.3e (tolerance %.0e)"
          % ("EXPORT VERIFIED" if ok else "EXPORT FAILED", worst, TOLERANCE))
    return ok, results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()

    m = get_models()
    # Export and verification both run on CPU — the phone's execution provider.
    m.model_delta_v.cpu().eval()
    m.model_abs_v.cpu().eval()
    os.makedirs(OUT_DIR, exist_ok=True)
    paths = {
        "delta_v": os.path.join(OUT_DIR, "matrix_delta_v.onnx"),
        "abs_v": os.path.join(OUT_DIR, "matrix_abs_v.onnx"),
    }

    if not args.verify_only:
        print("exporting frozen checkpoints -> %s" % OUT_DIR)
        export_one(m.model_delta_v, paths["delta_v"], "matrix_delta_v.onnx")
        export_one(m.model_abs_v, paths["abs_v"], "matrix_abs_v.onnx")

    models = {
        "delta_v": (m.model_delta_v, np.asarray(m.delta_v_target_mean, np.float32),
                    np.asarray(m.delta_v_target_std, np.float32)),
        "abs_v": (m.model_abs_v, m.abs_v_target_mean, m.abs_v_target_std),
    }
    ok, results = verify(models, paths)

    if args.verify_only:
        return 0 if ok else 1
    if not ok:
        for p in paths.values():
            if os.path.exists(p):
                os.remove(p)
        raise SystemExit("Export did not reproduce the frozen model; ONNX files removed.")

    # --- runtime constants, copied verbatim from the frozen artifacts ---------
    manifest = {
        "_comment": (
            "Generated by backend/tools/export_onnx.py from the FROZEN checkpoints. "
            "Every value here is copied verbatim from model/. Do not hand-edit: "
            "regenerate, and the export re-verifies itself against PyTorch."
        ),
        "window_samples": WINDOW,
        "sampling_rate_hz": round(1.0 / DT, 6),
        "dt_s": DT,
        "k": K,
        "tau_s": m.tau,
        "features": list(FEATS),
        "feature_mean": [float(v) for v in FMU],
        "feature_std": [float(v) for v in FSD],
        "delta_v": {
            "file": "matrix_delta_v.onnx",
            "outputs": ["dv5", "yaw_rate"],
            "target_mean": [float(v) for v in np.asarray(m.delta_v_target_mean).ravel()],
            "target_std": [float(v) for v in np.asarray(m.delta_v_target_std).ravel()],
            "source_checkpoint": m.meta["delta_v_checkpoint"],
            "source_sha256": m.meta["delta_v_sha256"],
            "onnx_sha256": sha256(paths["delta_v"]),
        },
        "abs_v": {
            "file": "matrix_abs_v.onnx",
            "outputs": ["v_forward", "yaw_rate"],
            "target_mean": [float(v) for v in np.asarray(m.abs_v_target_mean).ravel()],
            "target_std": [float(v) for v in np.asarray(m.abs_v_target_std).ravel()],
            "source_checkpoint": m.meta["abs_v_checkpoint"],
            "source_sha256": m.meta["abs_v_sha256"],
            "onnx_sha256": sha256(paths["abs_v"]),
        },
        "scaler_sha256": m.meta["scaler_sha256"],
        "fusion_config_sha256": m.meta["fusion_config_sha256"],
        "opset": OPSET,
        "verification": {"tolerance": TOLERANCE, "results": results},
    }
    mpath = os.path.join(OUT_DIR, "frozen_runtime.json")
    with open(mpath, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print("wrote %s" % mpath)

    # a copy for the backend, so the service can report what the app is running
    shutil.copy(mpath, os.path.join(config.BACKEND_ROOT, "exported_runtime.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
