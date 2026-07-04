"""MediaPipe hand landmarks — finger skeleton + palm orientation checks."""
from __future__ import annotations

import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core import base_options as base_options_module
from mediapipe.tasks.python.vision import HandLandmarksConnections

import config

_MODEL_DIR = Path(__file__).resolve().parent / "models"
_HAND_MODEL = (
    "hand_landmarker.task",
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    7_819_105,
)

_FINGER_CHAINS = [
    (5, 6, 7, 8),
    (9, 10, 11, 12),
    (13, 14, 15, 16),
    (17, 18, 19, 20),
]


class _H:
    WRIST = 0
    THUMB_CMC = 1
    THUMB_MCP = 2
    THUMB_IP = 3
    THUMB_TIP = 4
    INDEX_MCP = 5
    INDEX_PIP = 6
    INDEX_DIP = 7
    INDEX_TIP = 8
    MIDDLE_MCP = 9
    PINKY_MCP = 17


@dataclass
class HandCheckResult:
    detected: bool = False
    label: str = ""
    palm_facing: str = "unknown"
    palm_ok: bool = False
    fingers_extended: bool = False
    fingers_straight: bool = False
    finger_straight_score: float = 0.0
    palm_dot: float = 0.0


def _is_valid_task_file(path: Path, expected_size: int) -> bool:
    if not path.is_file():
        return False
    if path.stat().st_size != expected_size:
        return False
    with path.open("rb") as fh:
        head = fh.read(4)
    return head == b"\x00\x00PK\x03" or head.startswith(b"PK\x03")


def _download_model(path: Path, url: str, expected_size: int) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    req = urllib.request.Request(url, headers={"User-Agent": "RxSmart/1.0"})
    print(f"[HandAnalysis] Downloading model -> {path.name}")
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read()
    if len(data) != expected_size:
        raise RuntimeError(
            f"Hand model download incomplete: got {len(data)} bytes, expected {expected_size}"
        )
    tmp.write_bytes(data)
    tmp.replace(path)


def ensure_hand_model() -> Path:
    filename, url, expected_size = _HAND_MODEL
    _MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = _MODEL_DIR / filename
    if _is_valid_task_file(path, expected_size):
        return path
    if path.exists():
        path.unlink(missing_ok=True)
    _download_model(path, url, expected_size)
    return path


def create_hand_landmarker() -> vision.HandLandmarker:
    model_path = str(ensure_hand_model())
    max_hands = max(1, min(4, config.HAND_MAX_NUM))
    options = vision.HandLandmarkerOptions(
        base_options=base_options_module.BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=max_hands,
        min_hand_detection_confidence=config.HAND_MIN_DETECTION_CONFIDENCE,
        min_hand_presence_confidence=config.HAND_MIN_TRACKING_CONFIDENCE,
        min_tracking_confidence=config.HAND_MIN_TRACKING_CONFIDENCE,
    )
    return vision.HandLandmarker.create_from_options(options)


def _lm3(landmark) -> np.ndarray:
    return np.array([landmark.x, landmark.y, landmark.z], dtype=np.float32)


def _lm_px(landmark, w: int, h: int) -> tuple[int, int]:
    return int(landmark.x * w), int(landmark.y * h)


def _angle_3d(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    ba = a - b
    bc = c - b
    n1 = np.linalg.norm(ba)
    n2 = np.linalg.norm(bc)
    if n1 < 1e-8 or n2 < 1e-8:
        return 0.0
    cos = float(np.dot(ba, bc) / (n1 * n2))
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


def _palm_normal(landmarks: List, is_left: bool) -> Optional[np.ndarray]:
    wrist = _lm3(landmarks[_H.WRIST])
    index_mcp = _lm3(landmarks[_H.INDEX_MCP])
    pinky_mcp = _lm3(landmarks[_H.PINKY_MCP])
    v1 = index_mcp - wrist
    v2 = pinky_mcp - wrist
    normal = np.cross(v2, v1) if is_left else np.cross(v1, v2)
    norm = float(np.linalg.norm(normal))
    if norm < 1e-8:
        return None
    return normal / norm


def classify_palm_facing(normal: np.ndarray) -> Tuple[str, float]:
    camera = np.array([0.0, 0.0, -1.0], dtype=np.float32)
    dot = float(np.dot(normal, camera))
    if dot > config.PALM_FACING_THRESHOLD:
        return "toward_camera", dot
    if dot < -config.PALM_FACING_THRESHOLD:
        return "away", dot
    return "edge", dot


def _finger_extended(landmarks: List, mcp: int, pip: int, tip: int) -> bool:
    wrist = _lm3(landmarks[_H.WRIST])
    tip_v = _lm3(landmarks[tip])
    pip_v = _lm3(landmarks[pip])
    return float(np.linalg.norm(tip_v - wrist)) > float(np.linalg.norm(pip_v - wrist)) * 1.05


def _finger_straight(landmarks: List, mcp: int, pip: int, dip: int, tip: int) -> float:
    a = _lm3(landmarks[mcp])
    b = _lm3(landmarks[pip])
    c = _lm3(landmarks[dip])
    d = _lm3(landmarks[tip])
    angle_pip = _angle_3d(a, b, c)
    angle_tip = _angle_3d(b, c, d)
    straight_pip = max(0.0, min(1.0, (angle_pip - 140.0) / 40.0))
    straight_tip = max(0.0, min(1.0, (angle_tip - 140.0) / 40.0))
    return (straight_pip + straight_tip) * 0.5


def analyze_hand(landmarks: List, handedness: str) -> HandCheckResult:
    is_left = handedness.lower().startswith("l")
    label = "Left" if is_left else "Right"

    normal = _palm_normal(landmarks, is_left)
    if normal is None:
        return HandCheckResult(detected=True, label=label)

    facing, dot = classify_palm_facing(normal)
    palm_ok = facing == config.PALM_EXPECTED_FACING

    fingers_extended = all(
        _finger_extended(landmarks, chain[0], chain[1], chain[3])
        for chain in _FINGER_CHAINS
    )
    thumb_extended = _finger_extended(
        landmarks, _H.THUMB_CMC, _H.THUMB_IP, _H.THUMB_TIP
    )
    fingers_extended = fingers_extended and thumb_extended

    straight_scores = [
        _finger_straight(landmarks, *chain)
        for chain in _FINGER_CHAINS
    ]
    finger_straight_score = float(np.mean(straight_scores)) if straight_scores else 0.0
    fingers_straight = finger_straight_score >= config.FINGER_STRAIGHT_THRESHOLD

    if config.PALM_REQUIRE_FINGERS_EXTENDED:
        palm_ok = palm_ok and fingers_extended
    if config.PALM_REQUIRE_FINGERS_STRAIGHT:
        palm_ok = palm_ok and fingers_straight

    return HandCheckResult(
        detected=True,
        label=label,
        palm_facing=facing,
        palm_ok=palm_ok,
        fingers_extended=fingers_extended,
        fingers_straight=fingers_straight,
        finger_straight_score=finger_straight_score,
        palm_dot=dot,
    )


def _facing_label(facing: str) -> str:
    return {
        "toward_camera": "Palm -> camera",
        "away": "Back of hand",
        "edge": "Palm edge-on",
        "unknown": "Unknown",
    }.get(facing, facing)


def draw_hand_skeleton(
    frame: np.ndarray,
    landmarks: List,
    w: int,
    h: int,
    result: HandCheckResult,
) -> None:
    line_color = config.COLOR_HAND_OK if result.palm_ok else config.COLOR_HAND_WARN
    tip_color = config.COLOR_HAND_FINGER_TIP

    for conn in HandLandmarksConnections.HAND_CONNECTIONS:
        x1, y1 = _lm_px(landmarks[conn.start], w, h)
        x2, y2 = _lm_px(landmarks[conn.end], w, h)
        cv2.line(frame, (x1, y1), (x2, y2), line_color, 2, cv2.LINE_AA)

    for idx in range(21):
        x, y = _lm_px(landmarks[idx], w, h)
        color = tip_color if idx in (4, 8, 12, 16, 20) else line_color
        cv2.circle(frame, (x, y), 3, color, -1, cv2.LINE_AA)

    wx, wy = _lm_px(landmarks[_H.WRIST], w, h)
    mx, my = _lm_px(landmarks[_H.MIDDLE_MCP], w, h)
    status = "OK" if result.palm_ok else "CHECK"
    status_color = config.COLOR_OK if result.palm_ok else config.COLOR_ERROR
    text = f"{result.label[0]}H {status} | {_facing_label(result.palm_facing)}"
    if result.fingers_straight:
        text += f" | straight {result.finger_straight_score * 100:.0f}%"
    cv2.putText(
        frame,
        text,
        (wx, wy - 14),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.42,
        status_color,
        1,
        cv2.LINE_AA,
    )

    is_left = result.label == "Left"
    normal = _palm_normal(landmarks, is_left)
    if normal is not None:
        arrow_scale = 40.0
        end_x = int(mx + normal[0] * arrow_scale)
        end_y = int(my + normal[1] * arrow_scale)
        cv2.arrowedLine(frame, (mx, my), (end_x, end_y), status_color, 2, cv2.LINE_AA, tipLength=0.35)


def apply_hands_to_joint_data(
    left: Optional[HandCheckResult],
    right: Optional[HandCheckResult],
    joint_data,
) -> None:
    if left and left.detected:
        joint_data.hand_left_detected = True
        joint_data.palm_left_facing = left.palm_facing
        joint_data.palm_left_ok = left.palm_ok
        joint_data.fingers_left_extended = left.fingers_extended
        joint_data.fingers_left_straight = left.fingers_straight
        joint_data.finger_left_straight_score = left.finger_straight_score
    if right and right.detected:
        joint_data.hand_right_detected = True
        joint_data.palm_right_facing = right.palm_facing
        joint_data.palm_right_ok = right.palm_ok
        joint_data.fingers_right_extended = right.fingers_extended
        joint_data.fingers_right_straight = right.fingers_straight
        joint_data.finger_right_straight_score = right.finger_straight_score
