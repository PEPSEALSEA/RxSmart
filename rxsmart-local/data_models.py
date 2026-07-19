from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class SystemMode(Enum):
    CAMERA_ONLY = "CAMERA_ONLY"
    IOT_ONLY = "IOT_ONLY"
    FUSION = "FUSION"


class ConnectionStatus(Enum):
    CONNECTED = "CONNECTED"
    DISCONNECTED = "DISCONNECTED"
    TIMEOUT = "TIMEOUT"
    ERROR = "ERROR"


@dataclass
class JointData:
    elbow_left: float = 0.0
    elbow_right: float = 0.0
    knee_left: float = 0.0
    knee_right: float = 0.0
    shoulder_left: float = 0.0
    shoulder_right: float = 0.0

    source: str = "unknown"       # "camera" | "iot" | "fused"
    confidence: float = 0.0       # 0.0–1.0
    timestamp_ms: float = field(default_factory=lambda: time.time() * 1000)

    raw_landmarks: Any = field(default=None, repr=False)
    raw_hands: Optional[list] = field(default=None, repr=False)
    raw_sensors: Optional[dict] = field(default=None, repr=False)
    sensor_channels: Optional[list] = field(default=None, repr=False)

    # Smoothed 8-segment elevation/plane/bend model (camera source only),
    # consumed by exercise_engine.ExerciseSessionManager for pose scoring.
    pose_frame: Optional[dict] = field(default=None, repr=False)

    # IoT-specific metadata (populated only when source is "iot" or "fused")
    posture_state: str = "unknown"
    posture_fault_mask: int = 0
    rep_count: int = 0
    rep_target: int = 0
    speed_dps: float = 0.0
    session_state: str = "idle"
    alert_level: str = "none"
    alert_code: int = 0

    hand_left_detected: bool = False
    hand_right_detected: bool = False
    palm_left_facing: str = "unknown"
    palm_right_facing: str = "unknown"
    palm_left_ok: bool = False
    palm_right_ok: bool = False
    fingers_left_extended: bool = False
    fingers_right_extended: bool = False
    fingers_left_straight: bool = False
    fingers_right_straight: bool = False
    finger_left_straight_score: float = 0.0
    finger_right_straight_score: float = 0.0


@dataclass
class DebugStats:
    camera_fps: float = 0.0
    camera_latency_ms: float = 0.0
    iot_poll_rate_hz: float = 0.0
    iot_latency_ms: float = 0.0
    fusion_alpha: float = 0.6

    camera_status: ConnectionStatus = ConnectionStatus.DISCONNECTED
    iot_status: ConnectionStatus = ConnectionStatus.DISCONNECTED
    current_mode: SystemMode = SystemMode.CAMERA_ONLY

    log_messages: list = field(default_factory=list)
    skeleton_debug: bool = False
    pose_count: int = 0
    _max_logs: int = field(default=20, init=False, repr=False)

    def add_log(self, message: str) -> None:
        ts = time.strftime("%H:%M:%S")
        self.log_messages.append(f"{ts} {message}")
        if len(self.log_messages) > self._max_logs:
            self.log_messages = self.log_messages[-self._max_logs :]
