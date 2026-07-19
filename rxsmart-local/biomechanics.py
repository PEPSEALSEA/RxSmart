"""
Per-joint limits/tolerances used to judge whether a camera-measured angle is
"correct" for the active exercise phase.

Ported 1:1 from dashboard/src/lib/biomechanics.ts so Python judges pose
correctness with the exact same numbers the dashboard used to use client-side.
"""
from __future__ import annotations

from typing import Dict

UPPER_JOINT_LIMITS: Dict[str, Dict[str, dict]] = {
    "l_arm_upper": {
        "elevation": {"min": 0, "max": 180, "rest": 8, "maxVelocity": 55, "idealVelocityMin": 15, "idealVelocityMax": 45, "tolerance": 10},
        "plane": {"min": 0, "max": 360, "rest": 18, "maxVelocity": 75, "idealVelocityMin": 20, "idealVelocityMax": 55, "tolerance": 12},
    },
    "r_arm_upper": {
        "elevation": {"min": 0, "max": 180, "rest": 8, "maxVelocity": 55, "idealVelocityMin": 15, "idealVelocityMax": 45, "tolerance": 10},
        "plane": {"min": 0, "max": 360, "rest": 18, "maxVelocity": 75, "idealVelocityMin": 20, "idealVelocityMax": 55, "tolerance": 12},
    },
    "l_leg_upper": {
        "elevation": {"min": 0, "max": 130, "rest": 0, "maxVelocity": 42, "idealVelocityMin": 12, "idealVelocityMax": 35, "tolerance": 8},
        "plane": {"min": 0, "max": 360, "rest": 0, "maxVelocity": 50, "idealVelocityMin": 10, "idealVelocityMax": 40, "tolerance": 12},
    },
    "r_leg_upper": {
        "elevation": {"min": 0, "max": 130, "rest": 0, "maxVelocity": 42, "idealVelocityMin": 12, "idealVelocityMax": 35, "tolerance": 8},
        "plane": {"min": 0, "max": 360, "rest": 0, "maxVelocity": 50, "idealVelocityMin": 10, "idealVelocityMax": 40, "tolerance": 12},
    },
}

LOWER_JOINT_LIMITS: Dict[str, Dict[str, dict]] = {
    "l_arm_lower": {
        "bend": {"min": 0, "max": 145, "rest": 6, "maxVelocity": 70, "idealVelocityMin": 20, "idealVelocityMax": 50, "tolerance": 6},
    },
    "r_arm_lower": {
        "bend": {"min": 0, "max": 145, "rest": 6, "maxVelocity": 70, "idealVelocityMin": 20, "idealVelocityMax": 50, "tolerance": 6},
    },
    "l_leg_lower": {
        "bend": {"min": 0, "max": 135, "rest": 0, "maxVelocity": 50, "idealVelocityMin": 15, "idealVelocityMax": 38, "tolerance": 6},
    },
    "r_leg_lower": {
        "bend": {"min": 0, "max": 135, "rest": 0, "maxVelocity": 50, "idealVelocityMin": 15, "idealVelocityMax": 38, "tolerance": 6},
    },
}
