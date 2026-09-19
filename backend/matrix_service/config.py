"""Paths and service configuration.

Every path below points INTO the frozen `model/` tree and is opened READ-ONLY.
The service never writes to `model/`.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.dirname(HERE)
PROJECT_ROOT = os.path.dirname(BACKEND_ROOT)

MODEL_ROOT = os.environ.get("MATRIX_MODEL_ROOT", os.path.join(PROJECT_ROOT, "model"))

BASELINE_DIR = os.path.join(MODEL_ROOT, "baseline")
DELTA_V_DIR = os.path.join(MODEL_ROOT, "experiments", "delta_v")
FUSION_DIR = os.path.join(MODEL_ROOT, "experiments", "complementary_fusion")
PREPROCESSING_DIR = os.path.join(MODEL_ROOT, "preprocessing")
DATASET_CORE = os.path.join(PREPROCESSING_DIR, "training_dataset", "core")

# --- frozen artifacts --------------------------------------------------------
CKPT_ABS_V = os.path.join(BASELINE_DIR, "checkpoints", "best_huber.pt")
CKPT_DELTA_V = os.path.join(DELTA_V_DIR, "checkpoints", "best_k5_huber.pt")
SCALER_JSON = os.path.join(DATASET_CORE, "scaler", "scaler.json")
FUSION_CONFIG = os.path.join(FUSION_DIR, "frozen_fusion_config.json")
FEATURE_SCHEMA = os.path.join(PREPROCESSING_DIR, "outputs", "feature_schema.json")
TEST_METRICS = os.path.join(FUSION_DIR, "test_results", "metrics.json")
TEST_SUMMARY = os.path.join(FUSION_DIR, "test_results", "test_summary.csv")

# --- demo data (written by tools/export_demo_sessions.py, lives OUTSIDE model/) ---
DEMO_DIR = os.path.join(BACKEND_ROOT, "demo_data")

# --- service limits ----------------------------------------------------------
MAX_SAMPLES_PER_REQUEST = int(os.environ.get("MATRIX_MAX_SAMPLES", "600"))
MAX_ACTIVE_SESSIONS = int(os.environ.get("MATRIX_MAX_SESSIONS", "32"))
SESSION_TTL_SECONDS = int(os.environ.get("MATRIX_SESSION_TTL", "3600"))
CORS_ORIGINS = os.environ.get("MATRIX_CORS_ORIGINS", "*").split(",")
