"""
Module 1: CameraPoseEngine
Captures video in a background thread, runs MediaPipe Pose, and computes
joint angles (elbow, knee, shoulder) via vector math every frame.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from typing import Optional, Tuple

import cv2
import mediapipe as mp
import numpy as np

import config
from data_models import ConnectionStatus, JointData

mp_pose = mp.solutions.pose

# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _calc_angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """
    Returns the angle (degrees) at vertex *b* formed by rays b→a and b→c.
    Uses vector dot-product / arccos.
    """
    ba = a - b
    bc = c - b
    norm_ba = np.linalg.norm(ba)
    norm_bc = np.linalg.norm(bc)
    if norm_ba < 1e-8 or norm_bc < 1e-8:
        return 0.0
    cosine = float(np.dot(ba, bc) / (norm_ba * norm_bc))
    return float(np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0))))


def _lm_to_px(landmark, w: int, h: int) -> np.ndarray:
    """Convert a normalized MediaPipe landmark to pixel-space (x, y, z)."""
    return np.array([landmark.x * w, landmark.y * h, landmark.z * w], dtype=np.float32)


# ---------------------------------------------------------------------------
# CameraPoseEngine
# ---------------------------------------------------------------------------

class CameraPoseEngine:
    """
    Opens the webcam, runs MediaPipe Pose in a daemon thread, and exposes
    the latest JointData + annotated frame via thread-safe getters.

    Usage:
        engine = CameraPoseEngine()
        engine.start()
        joint_data, frame = engine.get_latest()
        engine.stop()
    """

    _L = mp_pose.PoseLandmark  # shorthand alias

    def __init__(self, camera_index: int = config.CAMERA_INDEX) -> None:
        self._camera_index = camera_index

        self._cap: Optional[cv2.VideoCapture] = None
        self._pose_model: Optional[mp_pose.Pose] = None

        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._running = False

        self._latest_joint_data: Optional[JointData] = None
        self._latest_annotated_frame: Optional[np.ndarray] = None
        self._latest_raw_frame: Optional[np.ndarray] = None

        self._status: ConnectionStatus = ConnectionStatus.DISCONNECTED
        self._fps: float = 0.0
        self._latency_ms: float = 0.0
        self._fps_window: deque = deque(maxlen=30)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._capture_loop,
            daemon=True,
            name="CameraPoseEngine",
        )
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=5.0)

    @property
    def status(self) -> ConnectionStatus:
        return self._status

    @property
    def fps(self) -> float:
        return self._fps

    @property
    def latency_ms(self) -> float:
        return self._latency_ms

    def get_latest(self) -> Tuple[Optional[JointData], Optional[np.ndarray]]:
        """Thread-safe snapshot → (JointData | None, annotated_frame | None)."""
        with self._lock:
            return self._latest_joint_data, self._latest_annotated_frame

    # ------------------------------------------------------------------
    # Background capture loop
    # ------------------------------------------------------------------

    def _capture_loop(self) -> None:
        self._pose_model = mp_pose.Pose(
            model_complexity=config.MEDIAPIPE_MODEL_COMPLEXITY,
            min_detection_confidence=config.MEDIAPIPE_MIN_DETECTION_CONFIDENCE,
            min_tracking_confidence=config.MEDIAPIPE_MIN_TRACKING_CONFIDENCE,
            enable_segmentation=False,
            smooth_landmarks=True,
        )

        self._cap = cv2.VideoCapture(self._camera_index)
        if not self._cap.isOpened():
            self._status = ConnectionStatus.ERROR
            return

        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)
        self._cap.set(cv2.CAP_PROP_FPS, config.CAMERA_TARGET_FPS)

        self._status = ConnectionStatus.CONNECTED
        prev_ts = time.perf_counter()

        while self._running:
            t_frame_start = time.perf_counter()

            ret, frame = self._cap.read()
            if not ret or frame is None:
                self._status = ConnectionStatus.DISCONNECTED
                time.sleep(0.15)
                # Attempt reconnect
                self._cap.release()
                self._cap = cv2.VideoCapture(self._camera_index)
                if self._cap.isOpened():
                    self._status = ConnectionStatus.CONNECTED
                continue

            h, w = frame.shape[:2]

            # MediaPipe requires RGB; mark non-writeable for performance
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rgb.flags.writeable = False
            results = self._pose_model.process(rgb)
            rgb.flags.writeable = True

            annotated = frame.copy()
            joint_data: Optional[JointData] = None

            if results.pose_landmarks:
                self._draw_minimal_skeleton(annotated, results.pose_landmarks, mp_pose)
                joint_data = self._compute_joints(
                    results.pose_landmarks.landmark, w, h, annotated
                )

            # FPS (rolling average over last 30 frames)
            now = time.perf_counter()
            delta = now - prev_ts
            if delta > 0:
                self._fps_window.append(1.0 / delta)
                self._fps = float(np.mean(self._fps_window))
            prev_ts = now

            self._latency_ms = (time.perf_counter() - t_frame_start) * 1000.0

            with self._lock:
                self._latest_joint_data = joint_data
                self._latest_annotated_frame = annotated
                self._latest_raw_frame = frame

        # Cleanup
        if self._cap:
            self._cap.release()
        if self._pose_model:
            self._pose_model.close()
        self._status = ConnectionStatus.DISCONNECTED

    # ------------------------------------------------------------------
    # Joint angle computation
    # ------------------------------------------------------------------

    def _compute_joints(
        self,
        landmarks,
        w: int,
        h: int,
        frame: np.ndarray,
    ) -> JointData:
        L = self._L

        def pt(idx: int) -> np.ndarray:
            return _lm_to_px(landmarks[idx], w, h)

        # --- Overall visibility score ---
        key_indices = [
            L.LEFT_SHOULDER, L.RIGHT_SHOULDER,
            L.LEFT_ELBOW, L.RIGHT_ELBOW,
            L.LEFT_WRIST, L.RIGHT_WRIST,
            L.LEFT_HIP, L.RIGHT_HIP,
            L.LEFT_KNEE, L.RIGHT_KNEE,
            L.LEFT_ANKLE, L.RIGHT_ANKLE,
        ]
        confidence = float(
            np.mean([landmarks[idx].visibility for idx in key_indices])
        )

        # --- Elbow angles (angle at elbow joint) ---
        elbow_left = _calc_angle(pt(L.LEFT_SHOULDER), pt(L.LEFT_ELBOW), pt(L.LEFT_WRIST))
        elbow_right = _calc_angle(pt(L.RIGHT_SHOULDER), pt(L.RIGHT_ELBOW), pt(L.RIGHT_WRIST))

        # --- Knee angles (angle at knee joint) ---
        knee_left = _calc_angle(pt(L.LEFT_HIP), pt(L.LEFT_KNEE), pt(L.LEFT_ANKLE))
        knee_right = _calc_angle(pt(L.RIGHT_HIP), pt(L.RIGHT_KNEE), pt(L.RIGHT_ANKLE))

        # --- Shoulder flexion (angle between trunk and upper arm) ---
        shoulder_left = _calc_angle(pt(L.LEFT_HIP), pt(L.LEFT_SHOULDER), pt(L.LEFT_ELBOW))
        shoulder_right = _calc_angle(pt(L.RIGHT_HIP), pt(L.RIGHT_SHOULDER), pt(L.RIGHT_ELBOW))

        # --- Draw angle labels on the annotated frame ---
        self._annotate_angle(frame, pt(L.LEFT_ELBOW), elbow_left, "EL")
        self._annotate_angle(frame, pt(L.RIGHT_ELBOW), elbow_right, "ER")
        self._annotate_angle(frame, pt(L.LEFT_KNEE), knee_left, "KL")
        self._annotate_angle(frame, pt(L.RIGHT_KNEE), knee_right, "KR")
        self._annotate_angle(frame, pt(L.LEFT_SHOULDER), shoulder_left, "SL")
        self._annotate_angle(frame, pt(L.RIGHT_SHOULDER), shoulder_right, "SR")

        return JointData(
            elbow_left=elbow_left,
            elbow_right=elbow_right,
            knee_left=knee_left,
            knee_right=knee_right,
            shoulder_left=shoulder_left,
            shoulder_right=shoulder_right,
            source="camera",
            confidence=confidence,
            timestamp_ms=time.time() * 1000,
            raw_landmarks=landmarks,
        )

    @staticmethod
    def _draw_minimal_skeleton(
        frame: np.ndarray,
        landmarks,
        mp_pose_module,
    ) -> None:
        h, w = frame.shape[:2]

        def px(idx: int) -> tuple[int, int]:
            lm = landmarks.landmark[idx]
            return int(lm.x * w), int(lm.y * h)

        for a, b in mp_pose_module.POSE_CONNECTIONS:
            cv2.line(frame, px(a), px(b), config.COLOR_SKELETON, 2, cv2.LINE_AA)

        for idx in [
            mp_pose_module.PoseLandmark.LEFT_SHOULDER,
            mp_pose_module.PoseLandmark.RIGHT_SHOULDER,
            mp_pose_module.PoseLandmark.LEFT_ELBOW,
            mp_pose_module.PoseLandmark.RIGHT_ELBOW,
            mp_pose_module.PoseLandmark.LEFT_WRIST,
            mp_pose_module.PoseLandmark.RIGHT_WRIST,
            mp_pose_module.PoseLandmark.LEFT_HIP,
            mp_pose_module.PoseLandmark.RIGHT_HIP,
            mp_pose_module.PoseLandmark.LEFT_KNEE,
            mp_pose_module.PoseLandmark.RIGHT_KNEE,
            mp_pose_module.PoseLandmark.LEFT_ANKLE,
            mp_pose_module.PoseLandmark.RIGHT_ANKLE,
        ]:
            x, y = px(idx)
            cv2.circle(frame, (x, y), 4, config.COLOR_SKELETON_ACTIVE, -1, cv2.LINE_AA)
            cv2.circle(frame, (x, y), 5, config.COLOR_ACCENT, 1, cv2.LINE_AA)

    @staticmethod
    def _annotate_angle(
        frame: np.ndarray,
        pos: np.ndarray,
        angle: float,
        label: str,
        color: tuple = None,
    ) -> None:
        if color is None:
            color = config.COLOR_ANGLE_LABEL
        x, y = int(pos[0]), int(pos[1])
        text = f"{label} {angle:.0f}"
        pad_x, pad_y = x + 8, y - 10
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1)
        cv2.rectangle(
            frame,
            (pad_x - 4, pad_y - th - 6),
            (pad_x + tw + 4, pad_y + 4),
            config.COLOR_HUD_BG,
            -1,
        )
        cv2.putText(frame, text, (pad_x, pad_y), cv2.FONT_HERSHEY_SIMPLEX, 0.42, color, 1, cv2.LINE_AA)
