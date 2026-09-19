"""Import bridge to the FROZEN MATRIX model code.

This module is the ONLY place the service touches `model/`. It:

  * inserts the three frozen source directories on `sys.path`,
  * imports the frozen architecture, scaler, windowing and fusion functions,
  * loads the two frozen checkpoints,

and re-exports them. It defines no model mathematics of its own.

Frozen objects re-exported here
-------------------------------
MatrixBaseline        model/baseline/train_baseline.py            architecture
FMU, FSD              model/experiments/delta_v/dv_common.py      feature scaler [:6]
predict               model/experiments/delta_v/dv_common.py      scale -> forward -> unscale
v_abs_anchored        .../complementary_fusion/phase2_4_fusion_select.py
complementary         .../complementary_fusion/phase2_4_fusion_select.py   tau filter
dead_reckon           .../complementary_fusion/phase2_4_fusion_select.py   x/y/heading
K, DT                 .../complementary_fusion/phase2_4_fusion_select.py   k=5, dt=0.1

Nothing is patched, wrapped or re-derived.
"""
import json
import os
import sys

# Do not leave .pyc files inside the frozen tree.
sys.dont_write_bytecode = True

import numpy as np  # noqa: E402
import torch  # noqa: E402

from . import config  # noqa: E402

for _p in (config.BASELINE_DIR, config.DELTA_V_DIR, config.FUSION_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from train_baseline import MatrixBaseline, DEVICE            # noqa: E402  frozen
from dv_common import FMU, FSD, predict, W as WINDOW, DT as DV_DT, FEATS  # noqa: E402  frozen
from phase2_4_fusion_select import (                          # noqa: E402  frozen
    complementary, v_abs_anchored, v_delta_stride, dead_reckon, K, DT,
)

__all__ = [
    "MatrixBaseline", "DEVICE", "FMU", "FSD", "predict", "WINDOW", "FEATS",
    "complementary", "v_abs_anchored", "v_delta_stride", "dead_reckon", "K", "DT",
    "FrozenModels", "get_models", "sha256",
]


def sha256(path: str) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class FrozenModels:
    """Both frozen checkpoints plus the frozen scalers, loaded once at startup."""

    def __init__(self) -> None:
        missing = [p for p in (config.CKPT_ABS_V, config.CKPT_DELTA_V,
                               config.SCALER_JSON, config.FUSION_CONFIG) if not os.path.exists(p)]
        if missing:
            raise FileNotFoundError(
                "Frozen artifacts missing (train them per model/RUN.md section 4): "
                + ", ".join(missing))

        self.scaler = json.load(open(config.SCALER_JSON))
        self.feature_schema = json.load(open(config.FEATURE_SCHEMA))
        self.fusion_config = json.load(open(config.FUSION_CONFIG))

        # tau comes from the frozen selection record, never from a request.
        selected = self.fusion_config["selected_config"]           # e.g. "cf_tau20"
        if not selected.startswith("cf_tau"):
            raise RuntimeError(f"frozen_fusion_config.json selected {selected!r}, "
                               "which is not a complementary-filter config")
        self.tau = float(selected[len("cf_tau"):])

        # absolute-v model: target scaler lives in scaler.json (RUN.md section 14)
        ck_b = torch.load(config.CKPT_ABS_V, map_location=DEVICE, weights_only=False)
        self.model_abs_v = MatrixBaseline().to(DEVICE)
        self.model_abs_v.load_state_dict(ck_b["model"])
        self.model_abs_v.eval()
        self.abs_v_target_mean = np.array(self.scaler["target_mean"], np.float32)
        self.abs_v_target_std = np.array(self.scaler["target_std"], np.float32)

        # delta-v model: target scaler lives INSIDE the checkpoint (RUN.md section 14)
        ck_d = torch.load(config.CKPT_DELTA_V, map_location=DEVICE, weights_only=False)
        self.model_delta_v = MatrixBaseline().to(DEVICE)
        self.model_delta_v.load_state_dict(ck_d["model"])
        self.model_delta_v.eval()
        self.delta_v_target_mean = ck_d["target_mean"]
        self.delta_v_target_std = ck_d["target_std"]

        self.meta = {
            "device": DEVICE,
            "window_samples": WINDOW,
            "sampling_rate_hz": 1.0 / DT,
            "dt_s": DT,
            "k": K,
            "tau_s": self.tau,
            "features": list(FEATS),
            "n_params_abs_v": int(ck_b.get("n_params", 0)),
            "n_params_delta_v": int(ck_d.get("n_params", 0)),
            "abs_v_checkpoint": os.path.basename(config.CKPT_ABS_V),
            "delta_v_checkpoint": os.path.basename(config.CKPT_DELTA_V),
            "abs_v_sha256": sha256(config.CKPT_ABS_V),
            "delta_v_sha256": sha256(config.CKPT_DELTA_V),
            "scaler_sha256": sha256(config.SCALER_JSON),
            "fusion_config_sha256": sha256(config.FUSION_CONFIG),
            "abs_v_val_loss": ck_b.get("val_loss"),
            "delta_v_val_loss": ck_d.get("val_loss"),
            "delta_v_epoch": ck_d.get("epoch"),
        }

    def infer(self, windows: np.ndarray):
        """Run both frozen models over `windows` of shape (N, 50, 6), raw units.

        Returns (v_abs_pred (N,), dv_pred (N,), yaw_pred (N,)) in physical units.
        Scaling, forward pass and un-scaling are all done by the frozen
        `dv_common.predict`; this method only splits the two output columns.
        """
        if windows.ndim != 3 or windows.shape[1] != WINDOW or windows.shape[2] != len(FEATS):
            raise ValueError(f"expected windows of shape (N, {WINDOW}, {len(FEATS)}), "
                             f"got {tuple(windows.shape)}")
        X = np.ascontiguousarray(windows, dtype=np.float32)
        p_abs = predict(self.model_abs_v, X, self.abs_v_target_mean, self.abs_v_target_std)
        p_dv = predict(self.model_delta_v, X, self.delta_v_target_mean, self.delta_v_target_std)
        return (p_abs[:, 0].astype(float),      # v_forward (m/s)
                p_dv[:, 0].astype(float),       # dv5 (m/s over 0.5 s)
                p_dv[:, 1].astype(float))       # yaw_rate (rad/s)


_MODELS: "FrozenModels | None" = None


def get_models() -> FrozenModels:
    global _MODELS
    if _MODELS is None:
        _MODELS = FrozenModels()
    return _MODELS
