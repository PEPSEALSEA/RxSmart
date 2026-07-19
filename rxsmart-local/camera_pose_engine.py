"""
Module 1: CameraPoseEngine
Captures video in a background thread, runs MediaPipe Pose Landmarker (Tasks API),
and computes joint angles via vector math every frame.
"""
from __future__ import annotations

import threading
import time
import urllib.request
import sys
from collections import deque
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core import base_options as base_options_module
from mediapipe.tasks.python.vision import PoseLandmarksConnections

import config
from data_models import ConnectionStatus, JointData
from hand_analysis import (
    HandCheckResult,
    analyze_hand,
    apply_hands_to_joint_data,
    create_hand_landmarker,
    draw_hand_skeleton,
)
from pose_model import PoseFrameSmoother, compute_pose_frame

_MODEL_DIR = Path(__file__).resolve().parent / "models"
_MODEL_SPECS = {
    0: (
        "pose_landmarker_lite.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        5_777_746,
    ),
    1: (
        "pose_landmarker_full.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
        9_398_198,
    ),
    2: (
        "pose_landmarker_heavy.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
        30_664_242,
    ),
}

# BlazePose landmark indices
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


def _calc_angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    ba = a - b
    bc = c - b
    norm_ba = np.linalg.norm(ba)
    norm_bc = np.linalg.norm(bc)
    if norm_ba < 1e-8 or norm_bc < 1e-8:
        return 0.0
    cosine = float(np.dot(ba, bc) / (norm_ba * norm_bc))
    return float(np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0))))


def _lm_to_px(landmark, w: int, h: int) -> np.ndarray:
    return np.array([landmark.x * w, landmark.y * h, landmark.z * w], dtype=np.float32)


def _is_valid_task_file(path: Path, expected_size: int) -> bool:
    if not path.is_file():
        return False
    size = path.stat().st_size
    if size != expected_size:
        return False
    with path.open("rb") as fh:
        head = fh.read(4)
    return head == b"\x00\x00PK\x03" or head.startswith(b"PK\x03")


def _download_pose_model(path: Path, url: str, expected_size: int) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    req = urllib.request.Request(url, headers={"User-Agent": "RxSmart/1.0"})
    print(f"[CameraPoseEngine] Downloading model -> {path.name} ({expected_size // 1_048_576} MB)")
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read()
    if len(data) != expected_size:
        raise RuntimeError(
            f"Model download incomplete for {path.name}: got {len(data)} bytes, expected {expected_size}"
        )
    tmp.write_bytes(data)
    tmp.replace(path)


def _ensure_pose_model(complexity: int) -> Path:
    key = max(0, min(2, complexity))
    filename, url, expected_size = _MODEL_SPECS[key]
    _MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = _MODEL_DIR / filename
    if _is_valid_task_file(path, expected_size):
        return path
    if path.exists():
        print(f"[CameraPoseEngine] Model file corrupt or incomplete, re-downloading -> {path.name}")
        path.unlink(missing_ok=True)
    _download_pose_model(path, url, expected_size)
    return path


class CameraPoseEngine:
    def __init__(self, camera_index: int = config.CAMERA_INDEX) -> None:
        self._camera_index = camera_index
        self._cap: Optional[cv2.VideoCapture] = None
        self._landmarker: Optional[vision.PoseLandmarker] = None
        self._hand_landmarker: Optional[vision.HandLandmarker] = None

        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._running = False

        self._latest_joint_data: Optional[JointData] = None
        self._latest_annotated_frame: Optional[np.ndarray] = None

        self._status: ConnectionStatus = ConnectionStatus.DISCONNECTED
        self._fps: float = 0.0
        self._latency_ms: float = 0.0
        self._fps_window: deque = deque(maxlen=30)
        self._video_ts_ms: int = 0
        self._skeleton_debug: bool = False
        self._pose_count: int = 0
        self._pose_smoother = PoseFrameSmoother(alpha=config.ANGLE_SMOOTHING_ALPHA)

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
        with self._lock:
            return self._latest_joint_data, self._latest_annotated_frame

    @property
    def camera_index(self) -> int:
        return self._camera_index

    @property
    def skeleton_debug(self) -> bool:
        with self._lock:
            return self._skeleton_debug

    @property
    def pose_count(self) -> int:
        with self._lock:
            return self._pose_count

    def set_skeleton_debug(self, enabled: bool) -> None:
        with self._lock:
            self._skeleton_debug = enabled

    def switch_camera(self, camera_index: int) -> None:
        if camera_index == self._camera_index and self._running:
            return
        was_running = self._running
        self.stop()
        self._camera_index = camera_index
        self._latest_joint_data = None
        self._latest_annotated_frame = None
        if was_running:
            self.start()

    @staticmethod
    def _open_capture(camera_index: int) -> cv2.VideoCapture:
        if sys.platform == "win32":
            return cv2.VideoCapture(camera_index, cv2.CAP_DSHOW)
        return cv2.VideoCapture(camera_index)

    def _create_landmarker(self) -> vision.PoseLandmarker:
        model_path = str(_ensure_pose_model(config.MEDIAPIPE_MODEL_COMPLEXITY))
        max_poses = max(1, min(4, config.MEDIAPIPE_MAX_POSES))
        options = vision.PoseLandmarkerOptions(
            base_options=base_options_module.BaseOptions(model_asset_path=model_path),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=max_poses,
            min_pose_detection_confidence=config.MEDIAPIPE_MIN_DETECTION_CONFIDENCE,
            min_pose_presence_confidence=config.MEDIAPIPE_MIN_TRACKING_CONFIDENCE,
            min_tracking_confidence=config.MEDIAPIPE_MIN_TRACKING_CONFIDENCE,
        )
        return vision.PoseLandmarker.create_from_options(options)

    @staticmethod
    def _pose_confidence(landmarks: List) -> float:
        key_indices = [
            _P.LEFT_SHOULDER, _P.RIGHT_SHOULDER,
            _P.LEFT_HIP, _P.RIGHT_HIP,
        ]
        visibilities = [
            getattr(landmarks[idx], "visibility", 1.0) or 1.0
            for idx in key_indices
        ]
        return float(np.mean(visibilities))

    @staticmethod
    def _pick_primary_pose(landmarks_list: List[List]) -> int:
        if not landmarks_list:
            return 0
        if len(landmarks_list) == 1:
            return 0
        scores = [CameraPoseEngine._pose_confidence(lm) for lm in landmarks_list]
        return int(np.argmax(scores))

    def _capture_loop(self) -> None:
        try:
            self._landmarker = self._create_landmarker()
            if config.HAND_TRACKING_ENABLED:
                self._hand_landmarker = create_hand_landmarker()
        except Exception as exc:
            print(f"[CameraPoseEngine] Failed to init MediaPipe: {exc}")
            self._status = ConnectionStatus.ERROR
            return

        self._cap = self._open_capture(self._camera_index)
        if not self._cap.isOpened():
            self._status = ConnectionStatus.ERROR
            return

        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.CAMERA_WIDTH)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.CAMERA_HEIGHT)
        self._cap.set(cv2.CAP_PROP_FPS, config.CAMERA_TARGET_FPS)

        self._status = ConnectionStatus.CONNECTED
        prev_ts = time.perf_counter()
        self._video_ts_ms = 0

        while self._running:
            t_frame_start = time.perf_counter()

            ret, frame = self._cap.read()
            if not ret or frame is None:
                self._status = ConnectionStatus.DISCONNECTED
                time.sleep(0.15)
                self._cap.release()
                self._cap = self._open_capture(self._camera_index)
                if self._cap.isOpened():
                    self._status = ConnectionStatus.CONNECTED
                continue

            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

            self._video_ts_ms += max(1, int(1000 / max(1, config.CAMERA_TARGET_FPS)))
            result = self._landmarker.detect_for_video(mp_image, self._video_ts_ms)

            with self._lock:
                skeleton_debug = self._skeleton_debug

            if skeleton_debug:
                annotated = np.zeros((h, w, 3), dtype=np.uint8)
            else:
                annotated = frame.copy()

            joint_data: Optional[JointData] = None
            pose_count = 0

            if result.pose_landmarks:
                pose_count = len(result.pose_landmarks)
                primary_idx = self._pick_primary_pose(result.pose_landmarks)

                for person_idx, landmarks in enumerate(result.pose_landmarks):
                    line_color, joint_color = config.PERSON_SKELETON_COLORS[
                        person_idx % len(config.PERSON_SKELETON_COLORS)
                    ]
                    self._draw_minimal_skeleton(
                        annotated,
                        landmarks,
                        w,
                        h,
                        line_color=line_color,
                        joint_color=joint_color,
                    )
                    if person_idx == primary_idx:
                        joint_data = self._compute_joints(
                            landmarks,
                            w,
                            h,
                            annotated,
                            draw_angles=not skeleton_debug,
                        )

                if pose_count > 1 or skeleton_debug:
                    for person_idx, landmarks in enumerate(result.pose_landmarks):
                        self._label_pose(annotated, landmarks, w, h, person_idx + 1)
            else:
                self._pose_smoother.reset()

            if skeleton_debug:
                cv2.putText(
                    annotated,
                    "Skeleton debug",
                    (12, 28),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.65,
                    (200, 200, 200),
                    1,
                    cv2.LINE_AA,
                )
            elif pose_count > 1:
                cv2.putText(
                    annotated,
                    f"{pose_count} people",
                    (12, 28),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    config.COLOR_ANGLE_LABEL,
                    1,
                    cv2.LINE_AA,
                )

            if config.HAND_TRACKING_ENABLED and self._hand_landmarker is not None:
                hand_result = self._hand_landmarker.detect_for_video(mp_image, self._video_ts_ms)
                left_hand: Optional[HandCheckResult] = None
                right_hand: Optional[HandCheckResult] = None

                raw_hands_payload: list = []

                if hand_result.hand_landmarks:
                    for idx, hand_lms in enumerate(hand_result.hand_landmarks):
                        handedness = "Unknown"
                        if hand_result.handedness and idx < len(hand_result.handedness):
                            categories = hand_result.handedness[idx]
                            if categories and len(categories) > 0:
                                handedness = categories[0].category_name or "Unknown"

                        check = analyze_hand(hand_lms, handedness)
                        draw_hand_skeleton(annotated, hand_lms, w, h, check)
                        raw_hands_payload.append({"label": check.label, "landmarks": hand_lms})

                        if check.label == "Left":
                            left_hand = check
                        else:
                            right_hand = check

                if joint_data is not None:
                    apply_hands_to_joint_data(left_hand, right_hand, joint_data)
                    joint_data.raw_hands = raw_hands_payload or None
                elif left_hand or right_hand:
                    joint_data = JointData(source="camera", confidence=0.0)
                    apply_hands_to_joint_data(left_hand, right_hand, joint_data)
                    joint_data.raw_hands = raw_hands_payload or None

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
                self._pose_count = pose_count

        if self._cap:
            self._cap.release()
        if self._landmarker:
            self._landmarker.close()
        if self._hand_landmarker:
            self._hand_landmarker.close()
        self._status = ConnectionStatus.DISCONNECTED

    def _compute_joints(
        self,
        landmarks: List,
        w: int,
        h: int,
        frame: np.ndarray,
        draw_angles: bool = True,
    ) -> JointData:
        L = _P

        def pt(idx: int) -> np.ndarray:
            return _lm_to_px(landmarks[idx], w, h)

        key_indices = [
            L.LEFT_SHOULDER, L.RIGHT_SHOULDER,
            L.LEFT_ELBOW, L.RIGHT_ELBOW,
            L.LEFT_WRIST, L.RIGHT_WRIST,
            L.LEFT_HIP, L.RIGHT_HIP,
            L.LEFT_KNEE, L.RIGHT_KNEE,
            L.LEFT_ANKLE, L.RIGHT_ANKLE,
        ]
        visibilities = [
            getattr(landmarks[idx], "visibility", 1.0) or 1.0
            for idx in key_indices
        ]
        confidence = float(np.mean(visibilities))

        elbow_left = _calc_angle(pt(L.LEFT_SHOULDER), pt(L.LEFT_ELBOW), pt(L.LEFT_WRIST))
        elbow_right = _calc_angle(pt(L.RIGHT_SHOULDER), pt(L.RIGHT_ELBOW), pt(L.RIGHT_WRIST))
        knee_left = _calc_angle(pt(L.LEFT_HIP), pt(L.LEFT_KNEE), pt(L.LEFT_ANKLE))
        knee_right = _calc_angle(pt(L.RIGHT_HIP), pt(L.RIGHT_KNEE), pt(L.RIGHT_ANKLE))
        shoulder_left = _calc_angle(pt(L.LEFT_HIP), pt(L.LEFT_SHOULDER), pt(L.LEFT_ELBOW))
        shoulder_right = _calc_angle(pt(L.RIGHT_HIP), pt(L.RIGHT_SHOULDER), pt(L.RIGHT_ELBOW))

        # Full 8-segment elevation/plane/bend model (matches the exercise
        # targets 1:1) — smoothed so the exercise engine gets a stable
        # signal instead of raw per-frame MediaPipe jitter.
        raw_pose_frame = compute_pose_frame(pt)
        pose_frame = self._pose_smoother.smooth(raw_pose_frame)

        if draw_angles:
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
            pose_frame=pose_frame,
        )

    @staticmethod
    def _draw_minimal_skeleton(
        frame: np.ndarray,
        landmarks: List,
        w: int,
        h: int,
        line_color: tuple = config.COLOR_SKELETON,
        joint_color: tuple = config.COLOR_SKELETON_ACTIVE,
    ) -> None:
        def px(idx: int) -> tuple[int, int]:
            lm = landmarks[idx]
            return int(lm.x * w), int(lm.y * h)

        for conn in PoseLandmarksConnections.POSE_LANDMARKS:
            cv2.line(frame, px(conn.start), px(conn.end), line_color, 2, cv2.LINE_AA)

        for idx in [
            _P.LEFT_SHOULDER, _P.RIGHT_SHOULDER,
            _P.LEFT_ELBOW, _P.RIGHT_ELBOW,
            _P.LEFT_WRIST, _P.RIGHT_WRIST,
            _P.LEFT_HIP, _P.RIGHT_HIP,
            _P.LEFT_KNEE, _P.RIGHT_KNEE,
            _P.LEFT_ANKLE, _P.RIGHT_ANKLE,
        ]:
            x, y = px(idx)
            cv2.circle(frame, (x, y), 4, joint_color, -1, cv2.LINE_AA)
            cv2.circle(frame, (x, y), 5, config.COLOR_ACCENT, 1, cv2.LINE_AA)

    @staticmethod
    def _label_pose(
        frame: np.ndarray,
        landmarks: List,
        w: int,
        h: int,
        person_num: int,
    ) -> None:
        lm = landmarks[_P.LEFT_SHOULDER]
        x, y = int(lm.x * w), int(lm.y * h) - 16
        text = f"P{person_num}"
        cv2.putText(frame, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (220, 220, 220), 1, cv2.LINE_AA)

    @staticmethod
    def _annotate_angle(
        frame: np.ndarray,
        pos: np.ndarray,
        angle: float,
        label: str,
        color: tuple | None = None,
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
