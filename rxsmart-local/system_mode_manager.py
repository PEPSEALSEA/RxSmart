"""
Module 3: SystemModeManager + FusionEngine
Controls which data source is active (Camera / IoT / Fusion) and handles
the Complementary Filter that blends camera and IMU joint angles.
"""
from __future__ import annotations

import time
from typing import Optional, Tuple

import config
from camera_pose_engine import CameraPoseEngine
from data_models import ConnectionStatus, DebugStats, JointData, SystemMode
from exercise_engine import ExerciseSessionManager, SessionFeedback
from iot_receiver import IoTReceiver
from rehab_exercises import exercise_catalog


# ---------------------------------------------------------------------------
# FusionEngine — Complementary Filter
# ---------------------------------------------------------------------------

class FusionEngine:
    """
    Blends camera and IoT joint angles via a Complementary Filter:

        fused_angle = α × camera_angle + (1 − α) × imu_angle

    α (alpha) defaults to config.FUSION_ALPHA (0.6 = camera-dominant).
    When MediaPipe confidence drops below FUSION_CONFIDENCE_THRESHOLD,
    α is scaled down proportionally so the IMU contributes more.
    """

    def __init__(self, alpha: float = config.FUSION_ALPHA) -> None:
        self._base_alpha = alpha
        self._effective_alpha = alpha

    @property
    def current_alpha(self) -> float:
        return self._effective_alpha

    def fuse(self, camera: JointData, iot: JointData) -> JointData:
        alpha = self._base_alpha

        # Reduce camera weight if MediaPipe confidence is low
        if camera.confidence < config.FUSION_CONFIDENCE_THRESHOLD:
            scale = camera.confidence / config.FUSION_CONFIDENCE_THRESHOLD
            alpha = self._base_alpha * scale

        self._effective_alpha = alpha
        ia = 1.0 - alpha

        def blend(c: float, i: float) -> float:
            return alpha * c + ia * i

        fused_confidence = alpha * camera.confidence + ia * iot.confidence

        return JointData(
            elbow_left=blend(camera.elbow_left, iot.elbow_left),
            elbow_right=blend(camera.elbow_right, iot.elbow_right),
            knee_left=blend(camera.knee_left, iot.knee_left),
            knee_right=blend(camera.knee_right, iot.knee_right),
            shoulder_left=blend(camera.shoulder_left, iot.shoulder_left),
            shoulder_right=blend(camera.shoulder_right, iot.shoulder_right),
            source="fused",
            confidence=fused_confidence,
            timestamp_ms=time.time() * 1000,
            raw_landmarks=camera.raw_landmarks,
            raw_world_landmarks=camera.raw_world_landmarks,
            raw_hands=camera.raw_hands,
            raw_sensors=iot.raw_sensors,
            pose_frame=camera.pose_frame,
            # Carry all IoT metadata through to the display
            posture_state=iot.posture_state,
            posture_fault_mask=iot.posture_fault_mask,
            rep_count=iot.rep_count,
            rep_target=iot.rep_target,
            speed_dps=iot.speed_dps,
            session_state=iot.session_state,
            alert_level=iot.alert_level,
            alert_code=iot.alert_code,
        )


# ---------------------------------------------------------------------------
# SystemModeManager
# ---------------------------------------------------------------------------

class SystemModeManager:
    """
    Orchestrates CameraPoseEngine + IoTReceiver and returns the appropriate
    JointData based on the active SystemMode.

    Mode switching is thread-safe and takes effect immediately.

    Keyboard shortcuts (handled by main.py):
        1 → CAMERA_ONLY
        2 → IOT_ONLY
        3 → FUSION
    """

    def __init__(
        self,
        camera: CameraPoseEngine,
        iot: IoTReceiver,
        initial_mode: SystemMode = SystemMode.CAMERA_ONLY,
    ) -> None:
        self._camera = camera
        self._iot = iot
        self._mode = initial_mode
        self._fusion = FusionEngine()
        self._stats = DebugStats(current_mode=initial_mode)
        self._exercise = ExerciseSessionManager()

        # Track previous statuses to detect transitions for logging
        self._prev_cam_status: Optional[ConnectionStatus] = None
        self._prev_iot_status: Optional[ConnectionStatus] = None

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    @property
    def mode(self) -> SystemMode:
        return self._mode

    @property
    def stats(self) -> DebugStats:
        return self._stats

    def set_mode(self, mode: SystemMode) -> None:
        if mode != self._mode:
            self._mode = mode
            self._stats.current_mode = mode
            self._stats.add_log(f"Mode switched -> {mode.value}")

    def set_skeleton_debug(self, enabled: bool) -> None:
        self._camera.set_skeleton_debug(enabled)
        self._stats.skeleton_debug = enabled
        self._stats.add_log("Skeleton debug ON" if enabled else "Skeleton debug OFF")

    @property
    def skeleton_debug(self) -> bool:
        return self._camera.skeleton_debug

    def get_frame_and_data(self) -> Tuple[Optional[JointData], Optional[object]]:
        """
        Returns (active_JointData, annotated_camera_frame).
        Both may be None if the relevant source is unavailable.
        A single lock acquisition per source keeps consistency.
        """
        cam_data, cam_frame = self._camera.get_latest()
        iot_data = self._iot.get_latest()

        cam_status = self._camera.status
        iot_status = self._iot.status

        cam_ok = cam_data is not None and cam_status == ConnectionStatus.CONNECTED
        # Keep last IMU sample during brief TIMEOUT so dashboard does not blank out.
        iot_ok = iot_data is not None and iot_status in (
            ConnectionStatus.CONNECTED,
            ConnectionStatus.TIMEOUT,
        )

        self._refresh_stats(cam_status, iot_status)

        active: Optional[JointData] = None

        if self._mode == SystemMode.CAMERA_ONLY:
            active = cam_data if cam_ok else None

        elif self._mode == SystemMode.IOT_ONLY:
            active = iot_data if iot_ok else None

        else:  # FUSION
            if cam_ok and iot_ok:
                active = self._fusion.fuse(cam_data, iot_data)
            elif cam_ok:
                self._stats.add_log("Fusion: IoT unavailable — camera only")
                active = cam_data
            elif iot_ok:
                self._stats.add_log("Fusion: camera unavailable — IoT only")
                active = iot_data
            else:
                active = None

        return active, cam_frame

    # ------------------------------------------------------------------
    # Exercise judging — runs entirely on this machine (see exercise_engine.py)
    # ------------------------------------------------------------------

    def exercise_catalog(self) -> list:
        return exercise_catalog()

    @property
    def current_exercise_id(self) -> str:
        return self._exercise.exercise.id

    def select_exercise(self, exercise_id: str) -> bool:
        return self._exercise.select_exercise(exercise_id)

    def exercise_session_action(self, action: str) -> bool:
        return self._exercise.handle_action(action)

    def get_session_feedback(self, joint_data: Optional[JointData]) -> SessionFeedback:
        pose_frame = None
        score_plane = True
        if joint_data is not None:
            pose_frame = joint_data.pose_frame
            # Single-pitch IMU has no rotate XYZ — score elevation/bend only.
            if joint_data.source == "iot":
                score_plane = False
        return self._exercise.tick(pose_frame, score_plane=score_plane)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _refresh_stats(
        self,
        cam_status: ConnectionStatus,
        iot_status: ConnectionStatus,
    ) -> None:
        self._stats.camera_fps = self._camera.fps
        self._stats.camera_latency_ms = self._camera.latency_ms
        self._stats.iot_poll_rate_hz = self._iot.poll_rate_hz
        self._stats.iot_latency_ms = self._iot.latency_ms
        self._stats.fusion_alpha = self._fusion.current_alpha
        self._stats.camera_status = cam_status
        self._stats.iot_status = iot_status
        self._stats.skeleton_debug = self._camera.skeleton_debug
        self._stats.pose_count = self._camera.pose_count

        # Log status transitions once (avoid repeating every frame)
        if self._prev_cam_status is not None and cam_status != self._prev_cam_status:
            self._stats.add_log(f"Camera: {self._prev_cam_status.value} → {cam_status.value}")
        if self._prev_iot_status is not None and iot_status != self._prev_iot_status:
            self._stats.add_log(f"IoT: {self._prev_iot_status.value} → {iot_status.value}")

        self._prev_cam_status = cam_status
        self._prev_iot_status = iot_status
