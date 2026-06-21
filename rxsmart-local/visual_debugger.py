"""
Module 4: AdvancedVisualDebugger
Renders a split-panel OpenCV window:
  Left  — camera feed with MediaPipe skeleton + angle labels
  Right — live debug panel (mode, FPS, latency, joint angles, IoT metrics, log)

Keyboard controls (processed in main.py):
  1 / 2 / 3  →  switch mode (Camera / IoT / Fusion)
  d          →  toggle debug panel visibility
  q / ESC    →  quit
"""
from __future__ import annotations

from typing import Optional

import cv2
import numpy as np

import config
from data_models import ConnectionStatus, DebugStats, JointData, SystemMode

# ---------------------------------------------------------------------------
# Color / symbol maps
# ---------------------------------------------------------------------------

_STATUS_COLOR = {
    ConnectionStatus.CONNECTED: config.COLOR_OK,
    ConnectionStatus.DISCONNECTED: config.COLOR_ERROR,
    ConnectionStatus.TIMEOUT: config.COLOR_WARN,
    ConnectionStatus.ERROR: config.COLOR_ERROR,
}

_STATUS_ICON = {
    ConnectionStatus.CONNECTED: "✓",
    ConnectionStatus.DISCONNECTED: "✗",
    ConnectionStatus.TIMEOUT: "⏱",
    ConnectionStatus.ERROR: "!",
}

_MODE_COLOR = {
    SystemMode.CAMERA_ONLY: config.COLOR_CAMERA,
    SystemMode.IOT_ONLY: config.COLOR_IOT,
    SystemMode.FUSION: config.COLOR_FUSED,
}

_SRC_COLOR = {
    "camera": config.COLOR_CAMERA,
    "iot": config.COLOR_IOT,
    "fused": config.COLOR_FUSED,
}

_FONT = cv2.FONT_HERSHEY_SIMPLEX


# ---------------------------------------------------------------------------
# Low-level draw helpers
# ---------------------------------------------------------------------------

def _text(
    img: np.ndarray,
    text: str,
    x: int,
    y: int,
    color: tuple = config.COLOR_TEXT,
    scale: float = 0.52,
    bold: bool = False,
) -> int:
    """Draw text and return the y-coordinate of the next line."""
    thickness = 2 if bold else 1
    cv2.putText(img, text, (x, y), _FONT, scale, color, thickness, cv2.LINE_AA)
    return y + int(scale * 34) + 2


def _sep(img: np.ndarray, y: int, w: int) -> int:
    """Draw a horizontal separator line and return y of the next line."""
    cv2.line(img, (8, y), (w - 8, y), config.COLOR_DIVIDER, 1)
    return y + 8


def _clamp_y(y: int, limit: int) -> bool:
    """Returns True if there is still vertical space to draw."""
    return y < limit - 20


# ---------------------------------------------------------------------------
# AdvancedVisualDebugger
# ---------------------------------------------------------------------------

class AdvancedVisualDebugger:
    """
    Composes the final display frame from the camera feed and debug panel.
    All rendering is done on the calling thread (main loop).
    """

    PANEL_W: int = config.DEBUG_PANEL_WIDTH
    PAD: int = 12        # horizontal padding inside panel
    LINE_SCALE: float = 0.50
    HEAD_SCALE: float = 0.54
    TITLE_SCALE: float = 0.62

    def __init__(self) -> None:
        self._show_panel: bool = True
        self._no_cam_frame: Optional[np.ndarray] = None  # lazy-initialised placeholder

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def render(
        self,
        camera_frame: Optional[np.ndarray],
        joint_data: Optional[JointData],
        stats: DebugStats,
    ) -> np.ndarray:
        """Return the fully composed BGR display frame (not shown — caller does imshow)."""
        cam_h, cam_w = self._resolve_camera_frame_dims(camera_frame)
        cam_display = self._prepare_camera_display(camera_frame, cam_h, cam_w)

        if self._show_panel:
            panel = self._build_panel(cam_h, joint_data, stats)
            return np.hstack([cam_display, panel])

        # Minimal HUD overlay (no panel)
        result = cam_display.copy()
        self._draw_hud_overlay(result, stats)
        return result

    def toggle_panel(self) -> None:
        self._show_panel = not self._show_panel

    # ------------------------------------------------------------------
    # Camera display
    # ------------------------------------------------------------------

    def _resolve_camera_frame_dims(
        self, frame: Optional[np.ndarray]
    ) -> tuple:
        if frame is not None:
            h, w = frame.shape[:2]
            return h, w
        return config.CAMERA_HEIGHT, config.CAMERA_WIDTH

    def _prepare_camera_display(
        self,
        frame: Optional[np.ndarray],
        h: int,
        w: int,
    ) -> np.ndarray:
        if frame is not None:
            return frame

        # Lazy-initialise the "camera disconnected" placeholder
        if (
            self._no_cam_frame is None
            or self._no_cam_frame.shape[:2] != (h, w)
        ):
            placeholder = np.zeros((h, w, 3), dtype=np.uint8)
            msg = "CAMERA DISCONNECTED"
            (tw, th), _ = cv2.getTextSize(msg, _FONT, 0.9, 2)
            cv2.putText(
                placeholder, msg,
                ((w - tw) // 2, (h + th) // 2),
                _FONT, 0.9, config.COLOR_ERROR, 2, cv2.LINE_AA,
            )
            # subtle grid pattern
            for gx in range(0, w, 60):
                cv2.line(placeholder, (gx, 0), (gx, h), (28, 28, 40), 1)
            for gy in range(0, h, 60):
                cv2.line(placeholder, (0, gy), (w, gy), (28, 28, 40), 1)
            self._no_cam_frame = placeholder
        return self._no_cam_frame

    # ------------------------------------------------------------------
    # Minimal HUD (panel hidden)
    # ------------------------------------------------------------------

    def _draw_hud_overlay(self, frame: np.ndarray, stats: DebugStats) -> None:
        h, w = frame.shape[:2]
        mode_col = _MODE_COLOR.get(stats.current_mode, config.COLOR_TEXT)
        _text(frame, f"MODE: {stats.current_mode.value}", 10, 32, mode_col, 0.7, bold=True)
        _text(frame, f"FPS: {stats.camera_fps:.1f}  Lat: {stats.camera_latency_ms:.0f}ms",
              10, 64, config.COLOR_TEXT, 0.55)

        cam_col = _STATUS_COLOR.get(stats.camera_status, config.COLOR_TEXT)
        iot_col = _STATUS_COLOR.get(stats.iot_status, config.COLOR_TEXT)
        _text(frame, f"CAM: {stats.camera_status.value}", 10, 90, cam_col, 0.50)
        _text(frame, f"IoT: {stats.iot_status.value}", 10, 112, iot_col, 0.50)

        cv2.putText(frame, "[1]Cam [2]IoT [3]Fusion  [d]Panel  [q]Quit",
                    (10, h - 14), _FONT, 0.40, (90, 90, 110), 1, cv2.LINE_AA)

    # ------------------------------------------------------------------
    # Debug panel builder
    # ------------------------------------------------------------------

    def _build_panel(
        self,
        height: int,
        joint_data: Optional[JointData],
        stats: DebugStats,
    ) -> np.ndarray:
        w = self.PANEL_W
        panel = np.full((height, w, 3), config.COLOR_PANEL_BG, dtype=np.uint8)
        p = self.PAD
        limit = height

        # ---------- Header ----------
        y = 18
        y = _text(panel, "RxSmart  Local  Pipeline", p, y, config.COLOR_TEXT, self.TITLE_SCALE, bold=True)

        mode_col = _MODE_COLOR.get(stats.current_mode, config.COLOR_TEXT)
        mode_label = f"MODE: [ {stats.current_mode.value} ]"
        y = _text(panel, mode_label, p, y + 2, mode_col, self.TITLE_SCALE, bold=True)

        if not _clamp_y(y, limit): return panel
        y = _sep(panel, y + 2, w)

        # ---------- Performance ----------
        y = _text(panel, "PERFORMANCE", p, y, config.COLOR_TEXT, self.HEAD_SCALE, bold=True)
        y = _text(panel, f"  Cam FPS      : {stats.camera_fps:>6.1f}", p, y, config.COLOR_TEXT, self.LINE_SCALE)
        y = _text(panel, f"  Cam Latency  : {stats.camera_latency_ms:>6.1f} ms", p, y, config.COLOR_TEXT, self.LINE_SCALE)
        y = _text(panel, f"  IoT Rate     : {stats.iot_poll_rate_hz:>6.1f} Hz", p, y, config.COLOR_TEXT, self.LINE_SCALE)
        y = _text(panel, f"  IoT Latency  : {stats.iot_latency_ms:>6.1f} ms", p, y, config.COLOR_TEXT, self.LINE_SCALE)
        if stats.current_mode == SystemMode.FUSION:
            alpha_col = _MODE_COLOR[SystemMode.FUSION]
            y = _text(panel, f"  Fusion α     : {stats.fusion_alpha:.2f}  (cam weight)",
                      p, y, alpha_col, self.LINE_SCALE)

        if not _clamp_y(y, limit): return panel
        y = _sep(panel, y + 2, w)

        # ---------- Connections ----------
        y = _text(panel, "CONNECTIONS", p, y, config.COLOR_TEXT, self.HEAD_SCALE, bold=True)
        for label, st in [("Camera", stats.camera_status), ("IoT   ", stats.iot_status)]:
            icon = _STATUS_ICON.get(st, "?")
            col = _STATUS_COLOR.get(st, config.COLOR_TEXT)
            y = _text(panel, f"  {label}: {icon}  {st.value}", p, y, col, self.LINE_SCALE)

        if not _clamp_y(y, limit): return panel
        y = _sep(panel, y + 2, w)

        # ---------- Joint Angles ----------
        y = _text(panel, "JOINT ANGLES (degrees)", p, y, config.COLOR_TEXT, self.HEAD_SCALE, bold=True)

        if joint_data is not None:
            src_col = _SRC_COLOR.get(joint_data.source, config.COLOR_TEXT)
            conf_pct = int(joint_data.confidence * 100)
            src_tag = f"[{joint_data.source}]"

            rows = [
                ("Elbow  Left ", joint_data.elbow_left),
                ("Elbow  Right", joint_data.elbow_right),
                ("Knee   Left ", joint_data.knee_left),
                ("Knee   Right", joint_data.knee_right),
                ("Shldr  Left ", joint_data.shoulder_left),
                ("Shldr  Right", joint_data.shoulder_right),
            ]
            for label, val in rows:
                if not _clamp_y(y, limit): break
                y = _text(panel, f"  {label}: {val:6.1f}  {src_tag}", p, y, src_col, self.LINE_SCALE)

            if _clamp_y(y, limit):
                y = _text(panel, f"  Confidence   : {conf_pct:3d}%", p, y, config.COLOR_TEXT, self.LINE_SCALE)
        else:
            y = _text(panel, "  (no data available)", p, y, config.COLOR_ERROR, self.LINE_SCALE)

        if not _clamp_y(y, limit): return panel
        y = _sep(panel, y + 2, w)

        # ---------- IoT Metrics (only when IoT data present) ----------
        has_iot_meta = (
            joint_data is not None
            and joint_data.raw_sensors is not None
        )
        if has_iot_meta:
            y = _text(panel, "IoT METRICS", p, y, config.COLOR_TEXT, self.HEAD_SCALE, bold=True)
            posture_col = (
                config.COLOR_OK if joint_data.posture_state == "correct" else config.COLOR_WARN
            )
            y = _text(panel, f"  Posture  : {joint_data.posture_state}", p, y, posture_col, self.LINE_SCALE)
            y = _text(panel, f"  Reps     : {joint_data.rep_count} / {joint_data.rep_target}", p, y, config.COLOR_TEXT, self.LINE_SCALE)
            y = _text(panel, f"  Speed    : {joint_data.speed_dps:.1f} deg/s", p, y, config.COLOR_TEXT, self.LINE_SCALE)
            y = _text(panel, f"  Session  : {joint_data.session_state}", p, y, config.COLOR_TEXT, self.LINE_SCALE)

            alert_col = (
                config.COLOR_ERROR
                if joint_data.alert_level in ("warn", "critical")
                else config.COLOR_OK
            )
            y = _text(
                panel,
                f"  Alert    : {joint_data.alert_level}  (code={joint_data.alert_code})",
                p, y, alert_col, self.LINE_SCALE,
            )

            if not _clamp_y(y, limit): return panel
            y = _sep(panel, y + 2, w)

        # ---------- Scrolling log ----------
        log_top = y
        if _clamp_y(y, limit):
            y = _text(panel, "LOG", p, y, config.COLOR_TEXT, self.HEAD_SCALE, bold=True)
            line_h = int(self.LINE_SCALE * 34) + 2
            max_lines = max(1, (limit - y - 26) // line_h)
            for msg in stats.log_messages[-max_lines:]:
                if not _clamp_y(y, limit):
                    break
                y = _text(panel, f"  {msg}", p, y, (145, 145, 160), 0.43)

        # ---------- Keyboard hints (always at bottom) ----------
        hints = "[1]Cam  [2]IoT  [3]Fusion  [d]Panel  [q]Quit"
        cv2.putText(panel, hints, (p, height - 10), _FONT, 0.37,
                    (80, 80, 100), 1, cv2.LINE_AA)

        # Left border accent
        cv2.line(panel, (0, 0), (0, height), config.COLOR_DIVIDER, 2)

        return panel
