"""MATRIX inference API (FastAPI).

Serving layer only. See `backend/README.md` for the full contract.
"""
import json
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config, demo
from .dr_engine import STORE
from .frozen import FEATS, WINDOW, get_models
from .schemas import (
    GnssFix, InferenceRequest, InferenceResponse, ModelInfo, OutageAnchor,
    OutageEndRequest, SamplesRequest,
)

API = "/api/v1"


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Load both frozen checkpoints once, and warm the graph, before serving."""
    m = get_models()
    # a dummy forward pass so the first real request is not the slow one
    m.infer(np.zeros((1, WINDOW, len(FEATS)), np.float32))
    print("[matrix] frozen models loaded on %s | tau=%.1fs k=%d"
          % (m.meta["device"], m.tau, m.meta["k"]))
    yield


app = FastAPI(
    lifespan=lifespan,
    title="MATRIX Inference API",
    version="1.0.0",
    description=(
        "Serving layer for the frozen MATRIX dead-reckoning system "
        "(delta-v model + absolute-v model + complementary filter, tau = 20 s). "
        "The models, scaler, feature order and fusion are frozen and are imported "
        "from model/ unchanged."
    ),
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

_STARTED = time.time()


@app.exception_handler(ValueError)
def _value_error(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# ---------------------------------------------------------------- diagnostics
@app.get(API + "/health")
def health():
    try:
        m = get_models()
        ok = True
        detail = None
    except Exception as exc:                       # pragma: no cover - startup failure path
        m, ok, detail = None, False, str(exc)
    return {
        "status": "ok" if ok else "degraded",
        "model_loaded": ok,
        "detail": detail,
        "uptime_s": round(time.time() - _STARTED, 1),
        "active_sessions": len(STORE),
        "device": m.meta["device"] if m else None,
        "demo_sessions": len(demo.catalogue()),
    }


@app.get(API + "/model/info", response_model=ModelInfo)
def model_info():
    m = get_models()
    return ModelInfo(
        name="MATRIX DR",
        version="1.0.0",
        device=m.meta["device"],
        window_samples=WINDOW,
        sampling_rate_hz=m.meta["sampling_rate_hz"],
        features=list(FEATS),
        prediction=["delta_v (dv5)", "yaw_rate"],
        fusion="complementary filter",
        tau_s=m.tau,
        k=m.meta["k"],
        dt_s=m.meta["dt_s"],
        n_params_abs_v=m.meta["n_params_abs_v"],
        n_params_delta_v=m.meta["n_params_delta_v"],
        checkpoints={
            "delta_v": {"file": m.meta["delta_v_checkpoint"],
                        "sha256": m.meta["delta_v_sha256"],
                        "epoch": m.meta["delta_v_epoch"],
                        "val_loss": m.meta["delta_v_val_loss"]},
            "abs_v": {"file": m.meta["abs_v_checkpoint"],
                      "sha256": m.meta["abs_v_sha256"],
                      "val_loss": m.meta["abs_v_val_loss"]},
            "scaler_sha256": m.meta["scaler_sha256"],
            "fusion_config_sha256": m.meta["fusion_config_sha256"],
        },
    )


@app.get(API + "/benchmarks")
def benchmarks():
    """Frozen TEST-split dead-reckoning benchmark, read from model/ as recorded.

    These are measured research results on 2 held-out sessions from one unseen
    driver, one phone and one vehicle. They are NOT a guarantee of real-world
    accuracy on other devices.
    """
    m = get_models()
    out = {
        "source": "model/experiments/complementary_fusion/frozen_fusion_config.json",
        "split": "test (2 sessions, driver B, unseen)",
        "metric": "median final position error (m)",
        "tau_s": m.tau,
        "disclaimer": ("Measured benchmark on the IO-VNBD test split "
                       "(Huawei P20 Pro in a Ford Fiesta, driver B). "
                       "Not a guarantee of accuracy on other devices or vehicles."),
        "validation_median_final_err_by_outage": m.fusion_config["median_final_err_by_outage"],
        "test": None,
    }
    if os.path.exists(config.TEST_SUMMARY):
        import csv
        with open(config.TEST_SUMMARY, newline="", encoding="utf-8") as fh:
            out["test"] = list(csv.DictReader(fh))
    if os.path.exists(config.TEST_METRICS):
        with open(config.TEST_METRICS, encoding="utf-8") as fh:
            out["test_metrics"] = json.load(fh)
    return out


# ------------------------------------------------------------ one-shot inference
@app.post(API + "/inference", response_model=InferenceResponse)
def inference(req: InferenceRequest):
    """Stateless: one frozen 50x6 window in, delta_v + yaw_rate + v_abs out.

    Note this endpoint deliberately does NOT return a position. A position
    requires the stateful complementary filter and an anchor — use the session
    endpoints below, which run the frozen filter over the whole outage.
    """
    m = get_models()
    X = np.asarray([[getattr(s, f) for f in FEATS] for s in req.samples], np.float32)[None]
    t0 = time.perf_counter()
    v_abs, dv, yaw = m.infer(X)
    return InferenceResponse(
        delta_v=float(dv[0]),
        yaw_rate=float(yaw[0]),
        v_abs_pred=float(v_abs[0]),
        latency_ms=round((time.perf_counter() - t0) * 1000.0, 2),
    )


# ------------------------------------------------------------------- sessions
@app.post(API + "/sessions", status_code=201)
def create_session():
    try:
        s = STORE.create()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return s.state()


@app.get(API + "/sessions/{sid}")
def get_session(sid: str):
    return _session(sid).state()


@app.delete(API + "/sessions/{sid}", status_code=204)
def delete_session(sid: str):
    STORE.drop(sid)


@app.post(API + "/sessions/{sid}/samples")
def push_samples(sid: str, req: SamplesRequest):
    """Stream IMU samples. Windows are formed and inferred server-side."""
    return _session(sid).ingest([s.model_dump() for s in req.samples])


@app.post(API + "/sessions/{sid}/outage/start")
def outage_start(sid: str, anchor: OutageAnchor):
    s = _session(sid)
    s.start_outage(anchor.model_dump())
    return s.state()


@app.post(API + "/sessions/{sid}/outage/end")
def outage_end(sid: str, req: OutageEndRequest):
    s = _session(sid)
    summary = s.end_outage(req.recovery.model_dump() if req.recovery else None)
    return {"outage": summary, "state": s.state()}


def _session(sid: str):
    try:
        return STORE.get(sid)
    except KeyError:
        raise HTTPException(status_code=404, detail="session %r not found or expired" % sid)


# ----------------------------------------------------------------- demo mode
@app.get(API + "/demo/sessions")
def demo_sessions():
    cat = demo.catalogue()
    if not cat:
        return {"sessions": [], "detail": ("No demo data exported. Run "
                                           "python backend/tools/export_demo_sessions.py")}
    return {"sessions": cat}


@app.get(API + "/demo/sessions/{session_id}")
def demo_session(session_id: str):
    d = demo.load(session_id)
    if d is None:
        raise HTTPException(status_code=404, detail="demo session %r not found" % session_id)
    return d
