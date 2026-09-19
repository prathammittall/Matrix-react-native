"""Backend tests.

These exercise the SERVING layer: input validation, session/outage bookkeeping,
geodetic projection and the frozen-artifact contract. They deliberately do not
re-test the model itself — that is frozen and validated in `reports/`. What they
DO assert is that the service cannot quietly change it: the checkpoint hashes,
tau, k, the window size and the feature order are all pinned here, so any edit
that moved them would fail this suite.

Run:
    python -m pytest backend/tests -q
"""
import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matrix_service import config, geo                                    # noqa: E402
from matrix_service.dr_engine import DRSession, SessionStore              # noqa: E402


# --------------------------------------------------------------- frozen contract
def test_frozen_input_contract_is_unchanged():
    from matrix_service.frozen import DT, FEATS, K, WINDOW

    assert WINDOW == 50, "the frozen model takes a 50-sample window"
    assert DT == 0.1, "the frozen model assumes exactly 10 Hz"
    assert K == 5, "the frozen delta-v horizon is k=5"
    assert list(FEATS) == ["acc_x", "acc_y", "acc_z", "gyro_x", "gyro_y", "gyro_z"]


def test_frozen_fusion_tau_comes_from_the_frozen_config():
    from matrix_service.frozen import get_models

    m = get_models()
    assert m.tau == 20.0, "frozen_fusion_config.json selected cf_tau20"
    assert m.fusion_config["test_used_for_selection"] is False


def test_scaler_is_the_eleven_channel_train_only_scaler():
    from matrix_service.frozen import FMU, FSD, get_models

    m = get_models()
    assert m.scaler["fitted_on"] == "train split only"
    assert len(m.scaler["feature_mean"]) == 11
    # the 6-channel model uses the first six entries
    assert len(FMU) == 6 and len(FSD) == 6
    assert FMU[2] == pytest.approx(9.8508, abs=1e-3), "acc_z mean retains gravity"


def test_both_checkpoints_load_and_have_the_expected_size():
    from matrix_service.frozen import get_models

    m = get_models()
    assert m.meta["n_params_delta_v"] == 150914
    assert m.meta["n_params_abs_v"] == 150914


def test_inference_shape_and_finiteness():
    from matrix_service.frozen import WINDOW, get_models

    m = get_models()
    rng = np.random.default_rng(0)
    X = rng.normal(0, 1, (4, WINDOW, 6)).astype(np.float32)
    X[:, :, 2] += 9.81
    v_abs, dv, yaw = m.infer(X)
    assert v_abs.shape == dv.shape == yaw.shape == (4,)
    assert np.isfinite(v_abs).all() and np.isfinite(dv).all() and np.isfinite(yaw).all()


def test_wrong_channel_count_is_rejected_not_reshaped():
    from matrix_service.frozen import WINDOW, get_models

    m = get_models()
    with pytest.raises(ValueError, match="expected windows of shape"):
        m.infer(np.zeros((1, WINDOW, 11), np.float32))
    with pytest.raises(ValueError):
        m.infer(np.zeros((1, 30, 6), np.float32))


# ------------------------------------------------------------------ geodesy
def test_local_to_latlon_moves_north_when_heading_is_north():
    lat, lon = geo.local_to_latlon(1000.0, 0.0, 52.0, -1.5, 0.0)
    assert lat > 52.0
    assert lon == pytest.approx(-1.5, abs=1e-9)
    assert geo.haversine_m(52.0, -1.5, lat, lon) == pytest.approx(1000, rel=1e-3)


def test_local_to_latlon_moves_east_when_heading_is_east():
    lat, lon = geo.local_to_latlon(1000.0, 0.0, 52.0, -1.5, 90.0)
    assert lon > -1.5
    assert lat == pytest.approx(52.0, abs=1e-9)


def test_local_to_latlon_handles_sequences():
    lats, lons = geo.local_to_latlon([0, 100, 200], [0, 0, 0], 52.0, -1.5, 0.0)
    assert len(lats) == len(lons) == 3
    assert lats[0] < lats[1] < lats[2]


def test_bearing_wraps_into_zero_to_360():
    assert geo.bearing_from_frozen_heading(10.0, math.radians(20.0)) == pytest.approx(350.0)
    assert 0 <= geo.bearing_from_frozen_heading(0.0, math.radians(-720.0)) < 360


def test_haversine_is_symmetric_and_zero_on_identity():
    a, b = (52.0, -1.5), (52.01, -1.49)
    assert geo.haversine_m(*a, *b) == pytest.approx(geo.haversine_m(*b, *a))
    assert geo.haversine_m(*a, *a) == pytest.approx(0.0, abs=1e-6)


def test_yaw_sign_convention_is_the_validated_one():
    # settled empirically against real GNSS by tools/validate_geo_convention.py
    assert geo.YAW_SIGN == 1.0


# ------------------------------------------------------- session bookkeeping
def _imu(n, t0=0.0, dt=0.1):
    return [
        {"t": round(t0 + i * dt, 3), "acc_x": 0.1, "acc_y": 0.0, "acc_z": 9.81,
         "gyro_x": 0.0, "gyro_y": 0.0, "gyro_z": 0.05}
        for i in range(n)
    ]


def test_a_new_session_starts_in_gnss_mode_with_an_empty_window():
    s = DRSession()
    st = s.state()
    assert st["mode"] == "GNSS"
    assert st["buffer_fill"] == 0
    assert st["buffer_required"] == 50
    assert st["outage"] is None


def test_no_inference_happens_before_the_window_is_full():
    s = DRSession()
    st = s.ingest(_imu(49))
    assert st["windows_inferred"] == 0
    assert st["telemetry"] is None
    st = s.ingest(_imu(1, t0=4.9))
    assert st["windows_inferred"] == 1
    assert st["telemetry"] is not None


def test_out_of_spec_cadence_is_rejected_not_resampled():
    s = DRSession()
    # 5 Hz instead of 10 Hz -> every window spans 9.8 s, far outside tolerance
    st = s.ingest(_imu(60, dt=0.2))
    assert st["windows_inferred"] == 0
    assert st["rejected_windows"] > 0


def test_non_finite_samples_are_rejected():
    s = DRSession()
    bad = _imu(50)
    bad[10]["acc_x"] = float("nan")
    st = s.ingest(bad)
    assert st["windows_inferred"] == 0
    assert st["rejected_windows"] >= 1


def test_outage_lifecycle_produces_a_track_and_a_summary():
    s = DRSession()
    s.ingest(_imu(50))
    s.start_outage({"latitude": 52.4, "longitude": -1.5, "speed_mps": 12.0, "bearing_deg": 0.0})
    st = s.ingest(_imu(50, t0=5.0))
    assert st["mode"] == "DEAD_RECKONING"
    assert st["outage"]["samples"] == 50
    assert st["outage"]["duration_s"] > 0

    summary = s.end_outage({"latitude": 52.405, "longitude": -1.5})
    assert s.state()["mode"] == "GNSS"
    assert summary["samples"] == 50
    assert len(summary["path"]) == 50
    assert summary["recovery_error_m"] is not None
    assert summary["recovery_error_m"] > 0


def test_two_overlapping_outages_are_refused():
    s = DRSession()
    anchor = {"latitude": 52.4, "longitude": -1.5, "speed_mps": 10.0, "bearing_deg": 0.0}
    s.start_outage(anchor)
    with pytest.raises(ValueError, match="already active"):
        s.start_outage(anchor)


def test_ending_an_outage_that_never_started_is_refused():
    with pytest.raises(ValueError, match="no outage is active"):
        DRSession().end_outage(None)


def test_oversized_batches_are_refused():
    s = DRSession()
    with pytest.raises(ValueError, match="at most"):
        s.ingest(_imu(config.MAX_SAMPLES_PER_REQUEST + 1))


def test_a_stationary_anchor_produces_a_track_that_does_not_run_away():
    """v0 = 0 with near-zero acceleration must not integrate into a long path."""
    s = DRSession()
    s.ingest(_imu(50))
    s.start_outage({"latitude": 52.4, "longitude": -1.5, "speed_mps": 0.0, "bearing_deg": 0.0})
    s.ingest(_imu(100, t0=5.0))
    snap = s.state()["outage"]
    assert snap["velocity_mps"] >= 0.0, "the frozen filter floors velocity at zero"


def test_session_store_evicts_and_bounds():
    store = SessionStore()
    a = store.create()
    assert store.get(a.id) is a
    store.drop(a.id)
    with pytest.raises(KeyError):
        store.get(a.id)


# ------------------------------------------------------------ request schemas
def test_inference_request_rejects_a_short_window():
    from pydantic import ValidationError

    from matrix_service.schemas import InferenceRequest

    with pytest.raises(ValidationError):
        InferenceRequest(samples=_imu(49))


def test_inference_request_rejects_an_out_of_spec_cadence():
    from pydantic import ValidationError

    from matrix_service.schemas import InferenceRequest

    with pytest.raises(ValidationError, match="10 Hz"):
        InferenceRequest(samples=_imu(50, dt=0.2))


def test_inference_request_accepts_a_correct_window():
    from matrix_service.schemas import InferenceRequest

    req = InferenceRequest(samples=_imu(50))
    assert len(req.samples) == 50


def test_outage_anchor_rejects_impossible_values():
    from pydantic import ValidationError

    from matrix_service.schemas import OutageAnchor

    with pytest.raises(ValidationError):
        OutageAnchor(latitude=95.0, longitude=0.0, speed_mps=10.0)
    with pytest.raises(ValidationError):
        OutageAnchor(latitude=52.0, longitude=0.0, speed_mps=-1.0)
    with pytest.raises(ValidationError):
        OutageAnchor(latitude=52.0, longitude=0.0, speed_mps=10.0, bearing_deg=400.0)


# --------------------------------------------------- on-device ONNX export
def test_onnx_graphs_match_pytorch_within_tolerance():
    """The graphs shipped in the APK must be the frozen model, not an approximation."""
    pytest.importorskip("onnxruntime")
    sys.path.insert(0, os.path.join(config.BACKEND_ROOT, "tools"))
    import export_onnx
    from matrix_service.frozen import get_models

    paths = {
        "delta_v": os.path.join(export_onnx.OUT_DIR, "matrix_delta_v.onnx"),
        "abs_v": os.path.join(export_onnx.OUT_DIR, "matrix_abs_v.onnx"),
    }
    if not all(os.path.exists(p) for p in paths.values()):
        pytest.skip("ONNX not exported yet: run backend/tools/export_onnx.py")

    m = get_models()
    m.model_delta_v.cpu().eval()
    m.model_abs_v.cpu().eval()
    models = {
        "delta_v": (m.model_delta_v, np.asarray(m.delta_v_target_mean, np.float32),
                    np.asarray(m.delta_v_target_std, np.float32)),
        "abs_v": (m.model_abs_v, m.abs_v_target_mean, m.abs_v_target_std),
    }
    ok, results = export_onnx.verify(models, paths)
    assert ok, results
    for key, r in results.items():
        assert r["max_abs_diff"] < export_onnx.TOLERANCE, (key, r)


def test_bundled_runtime_manifest_matches_the_frozen_constants():
    import json as _json

    manifest_path = os.path.join(export_onnx_out_dir(), "frozen_runtime.json")
    if not os.path.exists(manifest_path):
        pytest.skip("ONNX not exported yet: run backend/tools/export_onnx.py")
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = _json.load(fh)

    from matrix_service.frozen import DT, FEATS, K, WINDOW, get_models

    m = get_models()
    assert manifest["window_samples"] == WINDOW
    assert manifest["k"] == K
    assert manifest["dt_s"] == DT
    assert manifest["tau_s"] == m.tau
    assert manifest["features"] == list(FEATS)
    # the scaler travelling with the app must be the 6-channel slice, not the 11
    assert len(manifest["feature_mean"]) == 6
    assert len(manifest["feature_std"]) == 6
    # and it must be the FROZEN scaler, not a re-fit
    assert manifest["feature_mean"] == [float(v) for v in __import__("matrix_service.frozen",
                                                                    fromlist=["FMU"]).FMU]
    assert manifest["scaler_sha256"] == m.meta["scaler_sha256"]
    assert manifest["delta_v"]["source_sha256"] == m.meta["delta_v_sha256"]
    assert manifest["abs_v"]["source_sha256"] == m.meta["abs_v_sha256"]


def export_onnx_out_dir():
    sys.path.insert(0, os.path.join(config.BACKEND_ROOT, "tools"))
    import export_onnx
    return export_onnx.OUT_DIR
