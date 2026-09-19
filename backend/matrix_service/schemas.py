"""Request/response schemas for the MATRIX inference API.

Validation here is defensive only. It enforces the FROZEN input contract
(50 samples x 6 channels at 10 Hz, fixed channel order) — it never reshapes,
resamples, rescales or otherwise repairs data to make it fit. Out-of-spec input
is rejected with 422 rather than silently coerced.
"""
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

from .frozen import FEATS, WINDOW


class ImuSample(BaseModel):
    """One 6-axis IMU sample. Units must match the frozen training distribution:
    acceleration in m/s^2 WITH gravity retained, angular rate in rad/s."""
    t: float = Field(..., description="monotonic sample time in seconds")
    acc_x: float
    acc_y: float
    acc_z: float
    gyro_x: float
    gyro_y: float
    gyro_z: float


class GnssFix(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    speed_mps: Optional[float] = Field(None, ge=0)
    bearing_deg: Optional[float] = None
    accuracy_m: Optional[float] = Field(None, ge=0)
    satellites: Optional[int] = Field(None, ge=0)
    timestamp_s: Optional[float] = None


class OutageAnchor(BaseModel):
    """The velocity/position anchor the frozen filter needs at outage start.

    RUN.md section 17 gap #10: offline evaluation anchors on ground-truth VBOX
    velocity. In production this must come from the last good GNSS fix, and its
    error propagates into the dead-reckoned track.
    """
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    speed_mps: float = Field(..., ge=0, le=120)
    bearing_deg: Optional[float] = Field(None, ge=0, lt=360)
    timestamp_s: Optional[float] = None


class SamplesRequest(BaseModel):
    samples: List[ImuSample] = Field(..., min_length=1)


class InferenceRequest(BaseModel):
    """One-shot stateless inference over exactly one frozen window."""
    samples: List[ImuSample] = Field(..., min_length=WINDOW, max_length=WINDOW)
    anchor: Optional[OutageAnchor] = None

    @field_validator("samples")
    @classmethod
    def _check_cadence(cls, v):
        span = v[-1].t - v[0].t
        nominal = (WINDOW - 1) * 0.1
        if abs(span - nominal) >= 0.1 * nominal:
            raise ValueError(
                "window spans %.3f s; the frozen model requires %d samples at 10 Hz "
                "(%.1f s +/- 10%%)" % (span, WINDOW, nominal))
        return v


class InferenceResponse(BaseModel):
    delta_v: float = Field(..., description="dv5 = v[t] - v[t-5], m/s over 0.5 s")
    yaw_rate: float = Field(..., description="rad/s")
    v_abs_pred: float = Field(..., description="absolute-velocity anchor model, m/s")
    window_samples: int = WINDOW
    features: List[str] = list(FEATS)
    latency_ms: float


class OutageEndRequest(BaseModel):
    recovery: Optional[GnssFix] = None


class ModelInfo(BaseModel):
    name: str
    version: str
    device: str
    window_samples: int
    sampling_rate_hz: float
    features: List[str]
    prediction: List[str]
    fusion: str
    tau_s: float
    k: int
    dt_s: float
    n_params_abs_v: int
    n_params_delta_v: int
    checkpoints: dict
    frozen: bool = True
