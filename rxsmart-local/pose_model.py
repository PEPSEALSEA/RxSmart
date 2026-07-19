"""
Pose model — converts 3D MediaPipe landmarks into the same 8-segment
biomechanical model the dashboard exercises are defined against
(elevation + plane for shoulders/hips, bend for elbows/knees), and smooths
the result so scoring doesn't flicker on per-frame landmark jitter.

Mirrors dashboard/src/lib/pose.ts so the same exercise targets can now be
judged from real camera angles instead of only a simulated skeleton.
"""
from __future__ import annotations

import math
from typing import Callable, Dict, Optional

import numpy as np

UPPER_KEYS = ["l_arm_upper", "r_arm_upper", "l_leg_upper", "r_leg_upper"]
LOWER_KEYS = ["l_arm_lower", "r_arm_lower", "l_leg_lower", "r_leg_lower"]
POSE_KEYS = UPPER_KEYS + LOWER_KEYS

# แขนห้อยข้างลำตัว มืออยู่ต้นขาด้านข้าง (anatomical rest) — mirrors ARM_REST in pose.ts
ARM_REST: Dict[str, float] = {"elevation": 8.0, "plane": 18.0}

NEUTRAL_POSE: Dict[str, Dict[str, float]] = {
    "l_arm_upper": dict(ARM_REST),
    "r_arm_upper": dict(ARM_REST),
    "l_arm_lower": {"bend": 6.0},
    "r_arm_lower": {"bend": 6.0},
    "l_leg_upper": {"elevation": 0.0, "plane": 0.0},
    "r_leg_upper": {"elevation": 0.0, "plane": 0.0},
    "l_leg_lower": {"bend": 0.0},
    "r_leg_lower": {"bend": 0.0},
}


class _P:
    LEFT_SHOULDER = 11
    RIGHT_SHOULDER = 12
    LEFT_ELBOW = 13
    RIGHT_ELBOW = 14
    LEFT_WRIST = 15
    RIGHT_WRIST = 16
    LEFT_HIP = 23
    RIGHT_HIP = 24
    LEFT_KNEE = 25
    RIGHT_KNEE = 26
    LEFT_ANKLE = 27
    RIGHT_ANKLE = 28


def _normalize(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    if n < 1e-8:
        return np.zeros(3, dtype=np.float32)
    return v / n


def normalize_plane(angle: float) -> float:
    return ((angle % 360.0) + 360.0) % 360.0


def shortest_plane_delta(frm: float, to: float) -> float:
    diff = ((to - frm) % 360.0 + 360.0) % 360.0
    if diff > 180.0:
        diff -= 360.0
    return diff


def resolve_pose(base: Dict[str, Dict[str, float]], partial: Dict[str, dict]) -> Dict[str, Dict[str, float]]:
    """Port of resolvePose() in pose.ts — merges partial joint targets onto a base pose."""
    result: Dict[str, Dict[str, float]] = {k: dict(v) for k, v in base.items()}
    for key in UPPER_KEYS:
        t = partial.get(key)
        if not t:
            continue
        if "elevation" in t:
            result[key]["elevation"] = t["elevation"]
        if "plane" in t:
            result[key]["plane"] = normalize_plane(t["plane"])
    for key in LOWER_KEYS:
        t = partial.get(key)
        if t and "bend" in t:
            result[key]["bend"] = t["bend"]
    return result


def _elevation_plane(
    direction: np.ndarray,
    up: np.ndarray,
    lateral: np.ndarray,
    forward: np.ndarray,
    side_sign: float,
) -> tuple[float, float]:
    """
    Inverse of upperLimbDirection() in pose.ts: given the real limb direction
    (in the torso's local basis) recover (elevation, plane) in degrees.
    elevation: 0=down (rest), 90=horizontal, 180=straight up.
    plane: 0=own side, 90=front, 180=across body, 270=back.
    """
    d = _normalize(direction)
    cos_e = float(np.clip(np.dot(d, -up), -1.0, 1.0))
    elevation = math.degrees(math.acos(cos_e))
    sin_e = math.sqrt(max(0.0, 1.0 - cos_e * cos_e))
    if sin_e < 1e-4:
        return elevation, 0.0
    local_lateral = float(np.dot(d, lateral)) * side_sign
    local_forward = float(np.dot(d, forward))
    cos_p = max(-1.0, min(1.0, local_lateral / sin_e))
    sin_p = max(-1.0, min(1.0, local_forward / sin_e))
    plane = normalize_plane(math.degrees(math.atan2(sin_p, cos_p)))
    return elevation, plane


def _joint_angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """Interior angle at vertex b, in degrees (180 = straight)."""
    ba = a - b
    bc = c - b
    na, nc = float(np.linalg.norm(ba)), float(np.linalg.norm(bc))
    if na < 1e-8 or nc < 1e-8:
        return 180.0
    cosine = float(np.dot(ba, bc) / (na * nc))
    return math.degrees(math.acos(np.clip(cosine, -1.0, 1.0)))


def _bend(joint_angle_deg: float) -> float:
    """0 = straight, up to ~180 = fully flexed."""
    return max(0.0, 180.0 - joint_angle_deg)


def compute_pose_frame(pt: Callable[[int], np.ndarray]) -> Dict[str, Dict[str, float]]:
    """
    pt: callable(landmark_index) -> np.ndarray([x, y, z]) in a consistent space
    (pixel or normalized — only relative directions matter).
    Returns the 8-key elevation/plane/bend model used by rehab_exercises.py.
    """
    L = _P
    hip_center = (pt(L.LEFT_HIP) + pt(L.RIGHT_HIP)) / 2.0
    shoulder_center = (pt(L.LEFT_SHOULDER) + pt(L.RIGHT_SHOULDER)) / 2.0

    up = _normalize(shoulder_center - hip_center)
    right_raw = _normalize(pt(L.RIGHT_SHOULDER) - pt(L.LEFT_SHOULDER))
    # `forward` points toward the camera/viewer — i.e. the direction the
    # person's chest faces when standing in front of a webcam, which is
    # what "plane 90 = ข้างหน้า (front)" means for these exercises.
    forward = _normalize(np.cross(right_raw, up))
    right = _normalize(np.cross(up, forward))  # re-orthogonalize

    frame: Dict[str, Dict[str, float]] = {}

    def upper(key: str, origin_idx: int, next_idx: int, side_sign: float) -> None:
        direction = pt(next_idx) - pt(origin_idx)
        elevation, plane = _elevation_plane(direction, up, right, forward, side_sign)
        frame[key] = {"elevation": elevation, "plane": plane}

    upper("l_arm_upper", L.LEFT_SHOULDER, L.LEFT_ELBOW, -1.0)
    upper("r_arm_upper", L.RIGHT_SHOULDER, L.RIGHT_ELBOW, 1.0)
    upper("l_leg_upper", L.LEFT_HIP, L.LEFT_KNEE, -1.0)
    upper("r_leg_upper", L.RIGHT_HIP, L.RIGHT_KNEE, 1.0)

    frame["l_arm_lower"] = {"bend": _bend(_joint_angle(pt(L.LEFT_SHOULDER), pt(L.LEFT_ELBOW), pt(L.LEFT_WRIST)))}
    frame["r_arm_lower"] = {"bend": _bend(_joint_angle(pt(L.RIGHT_SHOULDER), pt(L.RIGHT_ELBOW), pt(L.RIGHT_WRIST)))}
    frame["l_leg_lower"] = {"bend": _bend(_joint_angle(pt(L.LEFT_HIP), pt(L.LEFT_KNEE), pt(L.LEFT_ANKLE)))}
    frame["r_leg_lower"] = {"bend": _bend(_joint_angle(pt(L.RIGHT_HIP), pt(L.RIGHT_KNEE), pt(L.RIGHT_ANKLE)))}

    return frame


class PoseFrameSmoother:
    """
    Exponential smoothing per field (with shortest-path handling for the
    circular `plane` angle). This is what removes MediaPipe's per-frame
    jitter before it reaches the scoring engine — without it, a noisy ±3°
    wobble around a tolerance boundary flips angleOk every frame, which is
    exactly what produced the old "score jumps between 0 and 100" bug.
    """

    def __init__(self, alpha: float = 0.35) -> None:
        self._alpha = alpha
        self._state: Optional[Dict[str, Dict[str, float]]] = None

    def reset(self) -> None:
        self._state = None

    def smooth(self, frame: Dict[str, Dict[str, float]]) -> Dict[str, Dict[str, float]]:
        if self._state is None:
            self._state = {k: dict(v) for k, v in frame.items()}
            return {k: dict(v) for k, v in self._state.items()}

        a = self._alpha
        out: Dict[str, Dict[str, float]] = {}
        for key, values in frame.items():
            prev = self._state.get(key, values)
            smoothed: Dict[str, float] = {}
            for field_name, value in values.items():
                prev_value = prev.get(field_name, value)
                if field_name == "plane":
                    delta = shortest_plane_delta(prev_value, value)
                    smoothed[field_name] = normalize_plane(prev_value + a * delta)
                else:
                    smoothed[field_name] = prev_value + a * (value - prev_value)
            out[key] = smoothed
        self._state = {k: dict(v) for k, v in out.items()}
        return {k: dict(v) for k, v in out.items()}
