"""MATRIX inference service.

A thin serving layer around the FROZEN MATRIX dead-reckoning system.

Nothing in this package re-implements model architecture, preprocessing,
normalisation, the Delta-v formulation, the yaw-rate target or the complementary
filter. Every one of those is imported from `model/` and called as-is.
See `backend/README.md` -> "Frozen-model contract".
"""
__version__ = "1.0.0"
