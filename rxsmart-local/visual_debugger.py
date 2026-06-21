"""
Module 4: AdvancedVisualDebugger
Split-panel OpenCV UI — minimal style aligned with RxSmart dashboard.

Left  — camera + MediaPipe skeleton + HUD overlay
Right — mode tabs, metrics, joint cards, log (fade in/out on toggle)

Keyboard (main.py): 1/2/3 mode · d panel · q/ESC quit
"""
from __future__ import annotations

from typing import Optional

import cv2
import numpy as np

import config
from data_models import ConnectionStatus, DebugStats, JointData, SystemMode

_FONT = cv2.FONT_HERSHEY_SIMPLEX

_MODE_LABELS = {
    SystemMode.CAMERA_ONLY: "Camera",
    SystemMode.IOT_ONLY: "IMU",
    SystemMode.FUSION: "Fusion",
}

_MODE_COLOR = {
    SystemMode.CAMERA_ONLY: config.COLOR_CAMERA,
    SystemMode.IOT_ONLY: config.COLOR_IOT,
    SystemMode.FUSION: config.COLOR_FUSED,
}

_STATUS_COLOR = {
    ConnectionStatus.CONNECTED: config.COLOR_OK,
    ConnectionStatus.DISCONNECTED: config.COLOR_MUTED,
    ConnectionStatus.TIMEOUT: config.COLOR_WARN,
    ConnectionStatus.ERROR: config.COLOR_ERROR,
}

_SRC_COLOR = {
    "camera": config.COLOR_CAMERA,
    "iot": config.COLOR_IOT,
    "fused": config.COLOR_FUSED,
}

_JOINT_ROWS = [
    ("Elbow L", "elbow_left"),
    ("Elbow R", "elbow_right"),
    ("Knee L", "knee_left"),
    ("Knee R", "knee_right"),
    ("Shoulder L", "shoulder_left"),
    ("Shoulder R", "shoulder_right"),
]


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * max(0.0, min(1.0, t))


def _text(
    img: np.ndarray,
    text: str,
    x: int,
    y: int,
    color: tuple = config.COLOR_TEXT,
    scale: float = 0.45,
    thickness: int = 1,
    bold: bool = False,
) -> int:
    t = 2 if bold else thickness
    cv2.putText(img, text, (x, y), _FONT, scale, color, t, cv2.LINE_AA)
    return y + int(scale * 32) + 4


def _rounded_rect(
    img: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    color: tuple,
    radius: int = 8,
) -> None:
    cv2.rectangle(img, (x + radius, y), (x + w - radius, y + h), color, -1)
    cv2.rectangle(img, (x, y + radius), (x + w, y + h - radius), color, -1)
    cv2.circle(img, (x + radius, y + radius), radius, color, -1, cv2.LINE_AA)
    cv2.circle(img, (x + w - radius, y + radius), radius, color, -1, cv2.LINE_AA)
    cv2.circle(img, (x + radius, y + h - radius), radius, color, -1, cv2.LINE_AA)
    cv2.circle(img, (x + w - radius, y + h - radius), radius, color, -1, cv2.LINE_AA)


def _draw_hbar(
    img: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    ratio: float,
    fill: tuple,
    bg: tuple = config.COLOR_BORDER,
) -> None:
    _rounded_rect(img, x, y, w, h, bg, radius=4)
    inner_w = max(0, int((w - 4) * max(0.0, min(1.0, ratio))))
    if inner_w > 0:
        _rounded_rect(img, x + 2, y + 2, inner_w, h - 4, fill, radius=3)


class AdvancedVisualDebugger:
    PANEL_W: int = config.DEBUG_PANEL_WIDTH
    PAD: int = 14

    def __init__(self) -> None:
        self._show_panel: bool = True
        self._panel_alpha: float = 1.0
        self._target_panel_alpha: float = 1.0
        self._mode_flash: float = 0.0
        self._last_mode: SystemMode = SystemMode.CAMERA_ONLY
        self._no_cam_frame: Optional[np.ndarray] = None
        self._prev_cam: Optional[np.ndarray] = None
        self._cam_blend: float = 1.0

    def tick(self, stats: DebugStats) -> None:
        step = 1.0 / max(1, config.UI_FADE_FRAMES)
        self._panel_alpha = _lerp(self._panel_alpha, self._target_panel_alpha, step)

        if stats.current_mode != self._last_mode:
            self._mode_flash = 1.0
            self._last_mode = stats.current_mode
        if self._mode_flash > 0:
            self._mode_flash = max(0.0, self._mode_flash - step * 1.4)

        self._cam_blend = _lerp(self._cam_blend, 1.0, step * 1.2)

    def render(
        self,
        camera_frame: Optional[np.ndarray],
        joint_data: Optional[JointData],
        stats: DebugStats,
    ) -> np.ndarray:
        self.tick(stats)
        cam_h, cam_w = self._resolve_camera_frame_dims(camera_frame)
        cam_display = self._prepare_camera_display(camera_frame, cam_h, cam_w, stats, joint_data)
        cam_display = self._apply_cam_fade(cam_display)

        if self._panel_alpha < 0.02:
            result = cam_display.copy()
            self._draw_hud_overlay(result, stats, joint_data)
            return result

        panel = self._build_panel(cam_h, joint_data, stats)
        if self._panel_alpha >= 0.98:
            return np.hstack([cam_display, panel])

        panel_part = int(self.PANEL_W * self._panel_alpha)
        if panel_part < 8:
            return cam_display

        cropped = panel[:, :panel_part]
        if panel_part < self.PANEL_W:
            pad = np.full((cam_h, self.PANEL_W - panel_part, 3), config.COLOR_PANEL_BG, dtype=np.uint8)
            cropped = np.hstack([cropped, pad])

        blended_panel = cv2.addWeighted(
            np.full((cam_h, self.PANEL_W, 3), config.COLOR_PANEL_BG, dtype=np.uint8),
            1.0 - self._panel_alpha,
            cropped,
            self._panel_alpha,
            0,
        )
        return np.hstack([cam_display, blended_panel])

    def toggle_panel(self) -> None:
        self._show_panel = not self._show_panel
        self._target_panel_alpha = 1.0 if self._show_panel else 0.0

    def notify_new_frame(self) -> None:
        self._cam_blend = 0.72

    def _apply_cam_fade(self, frame: np.ndarray) -> np.ndarray:
        if self._prev_cam is None or self._prev_cam.shape != frame.shape:
            self._prev_cam = frame.copy()
            return frame
        out = cv2.addWeighted(self._prev_cam, 1.0 - self._cam_blend, frame, self._cam_blend, 0)
        self._prev_cam = out.copy()
        return out

    def _resolve_camera_frame_dims(self, frame: Optional[np.ndarray]) -> tuple[int, int]:
        if frame is not None:
            h, w = frame.shape[:2]
            return h, w
        return config.CAMERA_HEIGHT, config.CAMERA_WIDTH

    def _prepare_camera_display(
        self,
        frame: Optional[np.ndarray],
        h: int,
        w: int,
        stats: DebugStats,
        joint_data: Optional[JointData],
    ) -> np.ndarray:
        if frame is not None:
            out = frame.copy()
            self._draw_camera_hud(out, stats, joint_data)
            if self._mode_flash > 0:
                flash = np.full_like(out, _MODE_COLOR.get(stats.current_mode, config.COLOR_ACCENT))
                out = cv2.addWeighted(out, 1.0 - self._mode_flash * 0.35, flash, self._mode_flash * 0.35, 0)
            return out

        if self._no_cam_frame is None or self._no_cam_frame.shape[:2] != (h, w):
            ph = np.full((h, w, 3), (245, 245, 245), dtype=np.uint8)
            for gx in range(0, w, 48):
                cv2.line(ph, (gx, 0), (gx, h), (235, 235, 235), 1)
            for gy in range(0, h, 48):
                cv2.line(ph, (0, gy), (w, gy), (235, 235, 235), 1)
            msg = "Camera disconnected"
            sub = "Check CAMERA_INDEX in config.py"
            (tw, _), _ = cv2.getTextSize(msg, _FONT, 0.75, 2)
            cv2.putText(ph, msg, ((w - tw) // 2, h // 2 - 10), _FONT, 0.75, config.COLOR_ERROR, 2, cv2.LINE_AA)
            (sw, _), _ = cv2.getTextSize(sub, _FONT, 0.45, 1)
            cv2.putText(ph, sub, ((w - sw) // 2, h // 2 + 22), _FONT, 0.45, config.COLOR_MUTED, 1, cv2.LINE_AA)
            self._no_cam_frame = ph

        out = self._no_cam_frame.copy()
        self._draw_camera_hud(out, stats, joint_data)
        return out

    def _draw_camera_hud(
        self,
        frame: np.ndarray,
        stats: DebugStats,
        joint_data: Optional[JointData],
    ) -> None:
        h, w = frame.shape[:2]
        overlay = frame.copy()

        cv2.rectangle(overlay, (0, 0), (w, 52), config.COLOR_HUD_BG, -1)
        cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)

        mode_col = _MODE_COLOR.get(stats.current_mode, config.COLOR_TEXT)
        _text(frame, "RxSmart", 16, 22, (255, 255, 255), 0.55, bold=True)
        _text(frame, _MODE_LABELS.get(stats.current_mode, "?"), 16, 44, mode_col, 0.42)

        cam_st = stats.camera_status
        cam_col = _STATUS_COLOR.get(cam_st, config.COLOR_MUTED)
        status_txt = f"Cam {cam_st.value}  ·  {stats.camera_fps:.0f} fps  ·  {stats.camera_latency_ms:.0f}ms"
        _text(frame, status_txt, 130, 36, cam_col, 0.42)

        if joint_data is not None and joint_data.source in ("camera", "fused"):
            conf = int(joint_data.confidence * 100)
            _text(frame, f"Pose {conf}%", w - 110, 36, (255, 255, 255), 0.42)
            _draw_hbar(frame, w - 108, 42, 92, 6, joint_data.confidence, config.COLOR_CAMERA)
        elif stats.current_mode == SystemMode.CAMERA_ONLY:
            pulse = 0.5 + 0.5 * abs(np.sin(cv2.getTickCount() / cv2.getTickFrequency() * 3))
            hint = "Stand in frame — MediaPipe tracking"
            cv2.putText(
                frame, hint, (w // 2 - 160, h // 2),
                _FONT, 0.55, (int(200 * pulse), int(200 * pulse), int(200 * pulse)), 1, cv2.LINE_AA,
            )

        bottom = frame.copy()
        cv2.rectangle(bottom, (0, h - 36), (w, h), config.COLOR_HUD_BG, -1)
        cv2.addWeighted(bottom, 0.55, frame, 0.45, 0, frame)
        hints = "[1] Camera   [2] IMU   [3] Fusion   [d] Panel   [q] Quit"
        cv2.putText(frame, hints, (12, h - 12), _FONT, 0.38, (180, 180, 180), 1, cv2.LINE_AA)

    def _draw_hud_overlay(
        self,
        frame: np.ndarray,
        stats: DebugStats,
        joint_data: Optional[JointData],
    ) -> None:
        self._draw_camera_hud(frame, stats, joint_data)

    def _build_panel(
        self,
        height: int,
        joint_data: Optional[JointData],
        stats: DebugStats,
    ) -> np.ndarray:
        w = self.PANEL_W
        panel = np.full((height, w, 3), config.COLOR_PANEL_BG, dtype=np.uint8)
        p = self.PAD
        y = 20

        y = _text(panel, "Hybrid Tracking", p, y, config.COLOR_MUTED, 0.38)
        y = _text(panel, "Local Pipeline", p, y + 2, config.COLOR_TEXT, 0.62, bold=True)

        y = self._draw_mode_tabs(panel, p, y + 8, w - p * 2, stats.current_mode)
        y += 10
        cv2.line(panel, (p, y), (w - p, y), config.COLOR_DIVIDER, 1)
        y += 14

        y = _text(panel, "Performance", p, y, config.COLOR_TEXT, 0.48, bold=True)
        metrics = [
            ("Camera FPS", f"{stats.camera_fps:.1f}"),
            ("Latency", f"{stats.camera_latency_ms:.0f} ms"),
            ("IoT rate", f"{stats.iot_poll_rate_hz:.1f} Hz"),
            ("IoT latency", f"{stats.iot_latency_ms:.0f} ms"),
        ]
        if stats.current_mode == SystemMode.FUSION:
            metrics.append(("Fusion α", f"{stats.fusion_alpha:.2f}"))

        col_w = (w - p * 2 - 8) // 2
        for i, (label, val) in enumerate(metrics):
            cx = p + (i % 2) * (col_w + 8)
            cy = y + (i // 2) * 38
            _rounded_rect(panel, cx, cy, col_w, 32, config.COLOR_SURFACE, radius=6)
            cv2.rectangle(panel, (cx, cy), (cx + col_w, cy + 32), config.COLOR_BORDER, 1)
            _text(panel, label, cx + 8, cy + 14, config.COLOR_MUTED, 0.32)
            _text(panel, val, cx + 8, cy + 28, config.COLOR_TEXT, 0.42, bold=True)

        y += ((len(metrics) + 1) // 2) * 38 + 8
        cv2.line(panel, (p, y), (w - p, y), config.COLOR_DIVIDER, 1)
        y += 14

        y = _text(panel, "Connections", p, y, config.COLOR_TEXT, 0.48, bold=True)
        for label, st in [("Camera", stats.camera_status), ("IoT", stats.iot_status)]:
            col = _STATUS_COLOR.get(st, config.COLOR_MUTED)
            dot_x, dot_y = p + 6, y - 4
            cv2.circle(panel, (dot_x, dot_y), 4, col, -1, cv2.LINE_AA)
            y = _text(panel, f"{label}: {st.value}", p + 16, y, config.COLOR_TEXT, 0.40)
        y += 4
        cv2.line(panel, (p, y), (w - p, y), config.COLOR_DIVIDER, 1)
        y += 14

        y = _text(panel, "Joint angles", p, y, config.COLOR_TEXT, 0.48, bold=True)
        if joint_data is not None:
            src_col = _SRC_COLOR.get(joint_data.source, config.COLOR_TEXT)
            conf = int(joint_data.confidence * 100)
            y = _text(panel, f"Source: {joint_data.source}  ·  {conf}%", p, y, src_col, 0.36)
            y = self._draw_joint_cards(panel, p, y + 4, w - p * 2, joint_data, height)
        else:
            y = _text(panel, "No pose data yet", p, y + 4, config.COLOR_MUTED, 0.40)

        if joint_data and joint_data.raw_sensors is not None and y < height - 120:
            y += 8
            cv2.line(panel, (p, y), (w - p, y), config.COLOR_DIVIDER, 1)
            y += 14
            y = _text(panel, "IoT session", p, y, config.COLOR_TEXT, 0.48, bold=True)
            posture_col = config.COLOR_OK if joint_data.posture_state == "correct" else config.COLOR_WARN
            for line, col in [
                (f"Posture: {joint_data.posture_state}", posture_col),
                (f"Rep: {joint_data.rep_count}/{joint_data.rep_target}", config.COLOR_TEXT),
                (f"Speed: {joint_data.speed_dps:.1f} dps", config.COLOR_TEXT),
                (f"Session: {joint_data.session_state}", config.COLOR_TEXT),
            ]:
                y = _text(panel, line, p + 4, y, col, 0.38)

        if y < height - 80:
            y += 8
            cv2.line(panel, (p, y), (w - p, y), config.COLOR_DIVIDER, 1)
            y += 14
            y = _text(panel, "Log", p, y, config.COLOR_TEXT, 0.48, bold=True)
            line_h = 16
            max_lines = max(1, (height - y - 24) // line_h)
            for msg in stats.log_messages[-max_lines:]:
                if y > height - 28:
                    break
                y = _text(panel, msg[:42], p + 2, y, config.COLOR_MUTED, 0.34)

        cv2.line(panel, (0, 0), (0, height), config.COLOR_BORDER, 2)
        return panel

    def _draw_mode_tabs(
        self,
        panel: np.ndarray,
        x: int,
        y: int,
        total_w: int,
        active: SystemMode,
    ) -> int:
        modes = [SystemMode.CAMERA_ONLY, SystemMode.IOT_ONLY, SystemMode.FUSION]
        tab_w = (total_w - 8) // 3
        for i, mode in enumerate(modes):
            tx = x + i * (tab_w + 4)
            is_active = mode == active
            bg = config.COLOR_ACCENT if is_active else config.COLOR_SURFACE
            fg = (255, 255, 255) if is_active else config.COLOR_MUTED
            _rounded_rect(panel, tx, y, tab_w, 28, bg, radius=6)
            if not is_active:
                cv2.rectangle(panel, (tx, y), (tx + tab_w, y + 28), config.COLOR_BORDER, 1)
            label = _MODE_LABELS[mode]
            (lw, _), _ = cv2.getTextSize(label, _FONT, 0.38, 1)
            cv2.putText(
                panel, label,
                (tx + (tab_w - lw) // 2, y + 19),
                _FONT, 0.38, fg, 1, cv2.LINE_AA,
            )
        return y + 28

    def _draw_joint_cards(
        self,
        panel: np.ndarray,
        x: int,
        y: int,
        total_w: int,
        joint_data: JointData,
        height_limit: int,
    ) -> int:
        card_w = (total_w - 6) // 2
        for i, (label, attr) in enumerate(_JOINT_ROWS):
            if y > height_limit - 40:
                break
            val = getattr(joint_data, attr, 0.0)
            cx = x + (i % 2) * (card_w + 6)
            cy = y + (i // 2) * 36
            _rounded_rect(panel, cx, cy, card_w, 30, config.COLOR_SURFACE, radius=5)
            cv2.rectangle(panel, (cx, cy), (cx + card_w, cy + 30), config.COLOR_BORDER, 1)
            _text(panel, label, cx + 6, cy + 12, config.COLOR_MUTED, 0.30)
            _text(panel, f"{val:.1f}", cx + 6, cy + 26, config.COLOR_TEXT, 0.44, bold=True)
        return y + ((min(len(_JOINT_ROWS), 6) + 1) // 2) * 36 + 4
