"""Streaming dead-reckoning sessions.

This module holds STATE and BOOKKEEPING only. Every quantity that affects
accuracy is produced by a frozen function imported from `matrix_service.frozen`:

    v_abs, dv, yaw  <- frozen.FrozenModels.infer   (frozen architecture + scaler)
    va_anch         <- frozen.v_abs_anchored
    v               <- frozen.complementary(..., tau)   tau from frozen_fusion_config
    x, y, heading   <- frozen.dead_reckon

To guarantee a streaming outage is identical to the offline evaluation, each
update re-runs the frozen filter over the WHOLE outage so far rather than
transcribing its recursion incrementally. An outage is at most 3000 samples, so
this costs microseconds and removes any chance of the streaming path drifting
away from the frozen one.
"""
import time
import uuid
from collections import deque
from typing import Any, Optional

import numpy as np

from . import config, geo
from .frozen import (
    FEATS, WINDOW, DT, K, complementary, dead_reckon, get_models, v_abs_anchored,
)

# Frozen window-contiguity rule, as used by dv_common.dense:
#   a window is usable only if its time span is within 10% of (W-1)*DT.
_SPAN_NOMINAL = (WINDOW - 1) * DT
_SPAN_TOL = 0.1 * _SPAN_NOMINAL


class OutageState:
    """One GNSS outage: anchor, accumulated predictions and the fused track."""

    def __init__(self, anchor: dict, started_at_s: float):
        self.anchor = anchor
        self.started_at_s = started_at_s
        self.v0 = float(anchor["speed_mps"])
        self.lat0 = float(anchor["latitude"])
        self.lon0 = float(anchor["longitude"])
        self.heading0 = float(anchor.get("bearing_deg") or 0.0)
        self.dv: list = []
        self.va: list = []
        self.yaw: list = []
        self.t: list = []
        self.path: list = []
        self.v = np.zeros(0)
        self.h = np.zeros(0)
        self.x = np.zeros(0)
        self.y = np.zeros(0)

    @property
    def n(self) -> int:
        return len(self.dv)

    @property
    def duration_s(self) -> float:
        return 0.0 if not self.t else float(self.t[-1] - self.started_at_s)

    def append(self, dv: float, va: float, yaw: float, t: float) -> None:
        self.dv.append(float(dv))
        self.va.append(float(va))
        self.yaw.append(float(yaw))
        self.t.append(float(t))

    def recompute(self, tau: float) -> None:
        """Re-run the frozen fusion + dead reckoning over the whole outage."""
        if not self.dv:
            return
        dv = np.asarray(self.dv, float)
        va = np.asarray(self.va, float)
        yaw = np.asarray(self.yaw, float)
        va_anch = v_abs_anchored(va, self.v0)               # frozen
        self.v = complementary(dv, va_anch, self.v0, tau)   # frozen (tau = 20 s)
        self.x, self.y, self.h = dead_reckon(self.v, yaw)   # frozen
        lats, lons = geo.local_to_latlon(self.x, self.y, self.lat0, self.lon0, self.heading0)
        self.path = list(zip(lats, lons))

    def snapshot(self) -> dict:
        if not self.path:
            return {
                "active": True, "samples": 0, "duration_s": 0.0,
                "latitude": self.lat0, "longitude": self.lon0,
                "velocity_mps": self.v0, "heading_deg": self.heading0,
                "distance_m": 0.0, "delta_v": None, "yaw_rate": None,
            }
        lat, lon = self.path[-1]
        return {
            "active": True,
            "samples": self.n,
            "duration_s": round(self.duration_s, 2),
            "latitude": lat,
            "longitude": lon,
            "velocity_mps": float(self.v[-1]),
            "heading_deg": geo.bearing_from_frozen_heading(self.heading0, float(self.h[-1])),
            "distance_m": float(np.hypot(self.x[-1], self.y[-1])),
            "delta_v": self.dv[-1],
            "yaw_rate": self.yaw[-1],
        }


class DRSession:
    """A navigation session: rolling IMU window + at most one live outage."""

    def __init__(self) -> None:
        self.id = uuid.uuid4().hex
        self.created_at = time.time()
        self.last_seen = self.created_at
        self.models = get_models()
        self._buf: deque = deque(maxlen=WINDOW)
        self.outage: Optional[OutageState] = None
        self.completed_outages: list = []
        self.samples_ingested = 0
        self.windows_inferred = 0
        self.last_telemetry: Optional[dict] = None
        self.last_inference_ms: Optional[float] = None
        self.rejected_windows = 0

    # ---------------------------------------------------------------- ingest
    def ingest(self, samples: list) -> dict:
        """Append IMU samples, run the frozen models on every complete window."""
        if len(samples) > config.MAX_SAMPLES_PER_REQUEST:
            raise ValueError("at most %d samples per request" % config.MAX_SAMPLES_PER_REQUEST)
        self.last_seen = time.time()

        windows, ends = [], []
        for s in samples:
            self._buf.append((float(s["t"]), [float(s[f]) for f in FEATS]))
            self.samples_ingested += 1
            if len(self._buf) < WINDOW:
                continue
            times = [b[0] for b in self._buf]
            span = times[-1] - times[0]
            if abs(span - _SPAN_NOMINAL) >= _SPAN_TOL:
                # Out of specification: the frozen model assumes exactly 10 Hz.
                self.rejected_windows += 1
                continue
            block = np.asarray([b[1] for b in self._buf], np.float32)
            if not np.isfinite(block).all():
                self.rejected_windows += 1
                continue
            windows.append(block)
            ends.append(times[-1])

        if windows:
            t0 = time.perf_counter()
            v_abs, dv, yaw = self.models.infer(np.stack(windows))
            self.last_inference_ms = (time.perf_counter() - t0) * 1000.0
            self.windows_inferred += len(windows)
            self.last_telemetry = {
                "timestamp_s": ends[-1],
                "delta_v": float(dv[-1]),
                "yaw_rate": float(yaw[-1]),
                "v_abs_pred": float(v_abs[-1]),
            }
            if self.outage is not None:
                for i, t in enumerate(ends):
                    self.outage.append(dv[i], v_abs[i], yaw[i], t)
                self.outage.recompute(self.models.tau)

        return self.state()

    # --------------------------------------------------------------- outages
    def start_outage(self, anchor: dict) -> None:
        if self.outage is not None:
            raise ValueError("an outage is already active on this session")
        started = anchor.get("timestamp_s")
        if started is None:
            started = self._buf[-1][0] if self._buf else 0.0
        self.outage = OutageState(anchor, float(started))

    def end_outage(self, recovery: Optional[dict]) -> dict:
        if self.outage is None:
            raise ValueError("no outage is active on this session")
        o, self.outage = self.outage, None
        snap = o.snapshot()
        summary = {
            "started_at_s": o.started_at_s,
            "duration_s": snap["duration_s"],
            "samples": snap["samples"],
            "dr_distance_m": snap["distance_m"],
            "anchor": {"latitude": o.lat0, "longitude": o.lon0,
                       "speed_mps": o.v0, "bearing_deg": o.heading0},
            "estimated": {"latitude": snap["latitude"], "longitude": snap["longitude"],
                          "velocity_mps": snap["velocity_mps"],
                          "heading_deg": snap["heading_deg"]},
            "path": [{"latitude": la, "longitude": lo} for la, lo in o.path],
            "recovery": None,
            "recovery_error_m": None,
            "heading_error_deg": None,
        }
        if recovery and recovery.get("latitude") is not None:
            rl, ro = float(recovery["latitude"]), float(recovery["longitude"])
            summary["recovery"] = {"latitude": rl, "longitude": ro,
                                   "speed_mps": recovery.get("speed_mps"),
                                   "bearing_deg": recovery.get("bearing_deg")}
            summary["recovery_error_m"] = geo.haversine_m(
                snap["latitude"], snap["longitude"], rl, ro)
            if recovery.get("bearing_deg") is not None:
                d = (float(recovery["bearing_deg"]) - snap["heading_deg"] + 180.0) % 360.0 - 180.0
                summary["heading_error_deg"] = d
        self.completed_outages.append(summary)
        return summary

    # ----------------------------------------------------------------- state
    def state(self) -> dict:
        return {
            "session_id": self.id,
            "mode": "DEAD_RECKONING" if self.outage is not None else "GNSS",
            "samples_ingested": self.samples_ingested,
            "windows_inferred": self.windows_inferred,
            "rejected_windows": self.rejected_windows,
            "buffer_fill": len(self._buf),
            "buffer_required": WINDOW,
            "last_inference_ms": (round(self.last_inference_ms, 2)
                                  if self.last_inference_ms is not None else None),
            "telemetry": self.last_telemetry,
            "outage": self.outage.snapshot() if self.outage else None,
            "completed_outages": len(self.completed_outages),
            "k": K,
            "tau_s": self.models.tau,
        }


class SessionStore:
    """Bounded, TTL-evicted in-memory session registry."""

    def __init__(self) -> None:
        self._sessions: dict = {}

    def create(self) -> DRSession:
        self._evict()
        if len(self._sessions) >= config.MAX_ACTIVE_SESSIONS:
            raise RuntimeError("too many active sessions")
        s = DRSession()
        self._sessions[s.id] = s
        return s

    def get(self, sid: str) -> DRSession:
        self._evict()
        s = self._sessions.get(sid)
        if s is None:
            raise KeyError(sid)
        return s

    def drop(self, sid: str) -> None:
        self._sessions.pop(sid, None)

    def _evict(self) -> None:
        cutoff = time.time() - config.SESSION_TTL_SECONDS
        for sid in [k for k, v in self._sessions.items() if v.last_seen < cutoff]:
            self._sessions.pop(sid, None)

    def __len__(self) -> int:
        return len(self._sessions)


STORE = SessionStore()
