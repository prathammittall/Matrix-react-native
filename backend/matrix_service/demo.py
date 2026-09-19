"""Demo Mode data access.

Demo sessions are REAL recorded drives with REAL stored predictions from the
frozen models — exported once by `backend/tools/export_demo_sessions.py` from
`model/experiments/complementary_fusion/predictions/dense/` and
`model/preprocessing/smartphone_core/`. Nothing here is synthesised: if the
export has not been run, the API reports the demo catalogue as empty rather
than fabricating a trajectory.
"""
import json
import os
from functools import lru_cache
from typing import Optional

from . import config


@lru_cache(maxsize=1)
def catalogue() -> list:
    index = os.path.join(config.DEMO_DIR, "index.json")
    if not os.path.exists(index):
        return []
    with open(index, encoding="utf-8") as fh:
        return json.load(fh)["sessions"]


@lru_cache(maxsize=8)
def load(session_id: str) -> Optional[dict]:
    safe = os.path.basename(session_id)
    path = os.path.join(config.DEMO_DIR, "%s.json" % safe)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)
