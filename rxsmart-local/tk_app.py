"""Tkinter GUI for RxSmart local pipeline — clickable controls + camera dropdown."""
from __future__ import annotations

import sys
import tkinter as tk
from tkinter import ttk
from typing import Callable, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image, ImageTk

import config
from camera_pose_engine import CameraPoseEngine
from data_models import ConnectionStatus, JointData, SystemMode
from iot_receiver import IoTReceiver
from serial_utils import list_serial_ports
from system_mode_manager import SystemModeManager
from visual_debugger import AdvancedVisualDebugger

MODES = [
    (SystemMode.CAMERA_ONLY, "Camera"),
    (SystemMode.IOT_ONLY, "IMU"),
    (SystemMode.FUSION, "Fusion"),
]


class RxSmartTkApp:
    def __init__(
        self,
        manager: SystemModeManager,
        camera: CameraPoseEngine,
        debugger: AdvancedVisualDebugger,
        iot: IoTReceiver,
        cameras: List[Tuple[int, str]],
        serial_ports: List[Tuple[str, str]],
        default_serial_port: str,
        default_camera: int,
        on_close: Callable[[], None],
    ) -> None:
        self._manager = manager
        self._camera = camera
        self._debugger = debugger
        self._iot = iot
        self._cameras = cameras
        self._serial_ports = list(serial_ports)
        self._default_serial_port = default_serial_port
        self._on_close = on_close
        self._photo: Optional[ImageTk.PhotoImage] = None
        self._mode_buttons: dict[SystemMode, tk.Button] = {}
        self._running = True

        self.root = tk.Tk()
        self.root.title(config.WINDOW_NAME)
        self.root.configure(bg="#fafafa")
        self.root.minsize(1024, 600)
        self.root.protocol("WM_DELETE_WINDOW", self._quit)
        self._apply_window_geometry()

        self._build_ui(default_camera, default_serial_port)
        self.root.after(30, self._tick)

    def _apply_window_geometry(self) -> None:
        if sys.platform == "win32":
            self.root.state("zoomed")
        elif sys.platform == "darwin":
            self.root.attributes("-zoomed", True)
        else:
            try:
                self.root.attributes("-fullscreen", True)
            except tk.TclError:
                self.root.geometry(f"{self.root.winfo_screenwidth()}x{self.root.winfo_screenheight()}+0+0")

    def run(self) -> None:
        self.root.mainloop()

    def _build_ui(self, default_camera: int, default_serial_port: str) -> None:
        main = tk.Frame(self.root, bg="#fafafa")
        main.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        left = tk.Frame(main, bg="#fafafa")
        left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self._video_label = tk.Label(left, bg="#171717", text="Starting camera…")
        self._video_label.pack(fill=tk.BOTH, expand=True)

        right = tk.Frame(main, bg="#fafafa", width=config.DEBUG_PANEL_WIDTH)
        right.pack(side=tk.RIGHT, fill=tk.Y, padx=(10, 0))
        right.pack_propagate(False)
        self._right_panel = right
        self._panel_visible = True

        tk.Label(
            right,
            text="RxSmart Local",
            font=("Segoe UI", 14, "bold"),
            bg="#fafafa",
            fg="#171717",
        ).pack(anchor=tk.W, pady=(0, 8))

        cam_row = tk.Frame(right, bg="#fafafa")
        cam_row.pack(fill=tk.X, pady=(0, 10))
        self._cam_row = cam_row

        tk.Label(cam_row, text="Camera", bg="#fafafa", fg="#737373", font=("Segoe UI", 9)).pack(
            anchor=tk.W
        )

        if len(self._cameras) <= 1:
            single = self._cameras[0][1] if self._cameras else "No camera detected"
            self._cam_status = tk.Label(
                cam_row,
                text=single,
                bg="#fafafa",
                fg="#171717",
                font=("Segoe UI", 10),
            )
            self._cam_status.pack(anchor=tk.W, pady=4)
            self._cam_var = tk.StringVar()
            self._cam_combo = None
        else:
            values = [label for _, label in self._cameras]
            self._cam_var = tk.StringVar()
            self._cam_combo = ttk.Combobox(
                cam_row,
                textvariable=self._cam_var,
                values=values,
                state="readonly",
                width=28,
            )
            self._cam_combo.pack(fill=tk.X, pady=4)
            self._cam_combo.bind("<<ComboboxSelected>>", lambda _e: self._apply_camera())
            self._set_combo_to_index(default_camera)
            self._set_combo_to_index(default_camera)
            self._cam_status = None

        port_row = tk.Frame(right, bg="#fafafa")
        port_row.pack(fill=tk.X, pady=(0, 10))

        tk.Label(port_row, text="Board (COM port)", bg="#fafafa", fg="#737373", font=("Segoe UI", 9)).pack(
            anchor=tk.W
        )

        port_controls = tk.Frame(port_row, bg="#fafafa")
        port_controls.pack(fill=tk.X, pady=4)

        self._port_var = tk.StringVar()
        self._port_combo = ttk.Combobox(
            port_controls,
            textvariable=self._port_var,
            state="readonly",
            width=24,
        )
        self._port_combo.pack(side=tk.LEFT, fill=tk.X, expand=True)

        tk.Button(
            port_controls,
            text="Refresh",
            command=self._refresh_serial_ports,
            relief=tk.FLAT,
            bg="#f5f5f5",
            padx=6,
            pady=4,
            cursor="hand2",
        ).pack(side=tk.LEFT, padx=(4, 0))

        tk.Button(
            port_row,
            text="Apply port",
            command=self._apply_serial_port,
            relief=tk.FLAT,
            bg="#171717",
            fg="white",
            activebackground="#262626",
            activeforeground="white",
            padx=8,
            pady=4,
            cursor="hand2",
        ).pack(anchor=tk.W, pady=(4, 0))

        self._populate_serial_ports(default_serial_port)

        mode_row = tk.Frame(right, bg="#fafafa")
        mode_row.pack(fill=tk.X, pady=(0, 10))

        tk.Label(mode_row, text="Tracking mode", bg="#fafafa", fg="#737373", font=("Segoe UI", 9)).pack(
            anchor=tk.W
        )

        btn_row = tk.Frame(mode_row, bg="#fafafa")
        btn_row.pack(fill=tk.X, pady=4)

        for mode, label in MODES:
            b = tk.Button(
                btn_row,
                text=label,
                command=lambda m=mode: self._set_mode(m),
                relief=tk.FLAT,
                padx=10,
                pady=6,
                cursor="hand2",
            )
            b.pack(side=tk.LEFT, padx=(0, 4))
            self._mode_buttons[mode] = b

        debug_row = tk.Frame(right, bg="#fafafa")
        debug_row.pack(fill=tk.X, pady=(0, 10))

        self._skeleton_debug_var = tk.BooleanVar(value=False)
        tk.Checkbutton(
            debug_row,
            text="Skeleton debug (black bg, no video)",
            variable=self._skeleton_debug_var,
            command=self._toggle_skeleton_debug,
            bg="#fafafa",
            fg="#171717",
            activebackground="#fafafa",
            selectcolor="#171717",
            font=("Segoe UI", 9),
            cursor="hand2",
        ).pack(anchor=tk.W)

        self._stats_var = tk.StringVar(value="")
        tk.Label(
            right,
            textvariable=self._stats_var,
            justify=tk.LEFT,
            bg="#fafafa",
            fg="#171717",
            font=("Consolas", 9),
            wraplength=config.DEBUG_PANEL_WIDTH - 20,
        ).pack(anchor=tk.W, pady=(0, 8))

        self._joints_var = tk.StringVar(value="Joint angles\n—")
        tk.Label(
            right,
            textvariable=self._joints_var,
            justify=tk.LEFT,
            bg="#ffffff",
            fg="#171717",
            font=("Consolas", 9),
            wraplength=config.DEBUG_PANEL_WIDTH - 20,
            padx=8,
            pady=8,
            relief=tk.SOLID,
            borderwidth=1,
        ).pack(fill=tk.X, pady=(0, 8))

        self._log_text = tk.Text(
            right,
            height=8,
            bg="#ffffff",
            fg="#737373",
            font=("Consolas", 8),
            relief=tk.SOLID,
            borderwidth=1,
            wrap=tk.WORD,
        )
        self._log_text.pack(fill=tk.BOTH, expand=True, pady=(0, 8))
        self._log_text.configure(state=tk.DISABLED)

        actions = tk.Frame(right, bg="#fafafa")
        actions.pack(fill=tk.X)

        tk.Button(
            actions,
            text="Hide panel",
            command=self._toggle_sidebar,
            relief=tk.FLAT,
            bg="#f5f5f5",
            padx=8,
            pady=6,
            cursor="hand2",
        ).pack(side=tk.LEFT, padx=(0, 6))

        tk.Button(
            actions,
            text="Quit",
            command=self._quit,
            relief=tk.FLAT,
            bg="#fee2e2",
            fg="#991b1b",
            padx=12,
            pady=6,
            cursor="hand2",
        ).pack(side=tk.RIGHT)

        self._refresh_mode_buttons(self._manager.mode)

    def _set_combo_to_index(self, index: int) -> None:
        for idx, label in self._cameras:
            if idx == index:
                self._cam_var.set(label)
                return
        if self._cameras:
            self._cam_var.set(self._cameras[0][1])

    def _populate_serial_ports(self, selected_port: str) -> None:
        if not self._serial_ports:
            self._serial_ports = list_serial_ports()
        labels = [label for _, label in self._serial_ports]
        if not labels:
            labels = [f"{selected_port} (manual)"]
            self._serial_ports = [(selected_port, labels[0])]
        self._port_combo.configure(values=labels)
        for port, label in self._serial_ports:
            if port == selected_port:
                self._port_var.set(label)
                return
        self._port_var.set(labels[0])

    def _refresh_serial_ports(self) -> None:
        current = self._selected_serial_port()
        self._serial_ports = list_serial_ports()
        self._populate_serial_ports(current or self._iot.get_serial_port())
        self._manager.stats.add_log(f"Serial ports refreshed ({len(self._serial_ports)} found)")

    def _selected_serial_port(self) -> Optional[str]:
        label = self._port_var.get()
        for port, port_label in self._serial_ports:
            if port_label == label:
                return port
        if label:
            return label.split(" — ", 1)[0].strip()
        return None

    def _apply_serial_port(self) -> None:
        port = self._selected_serial_port()
        if not port:
            self._manager.stats.add_log("No COM port selected")
            return
        self._iot.set_serial_port(port)
        self._manager.stats.add_log(f"Board port → {port}")

    def _selected_camera_index(self) -> Optional[int]:
        label = self._cam_var.get()
        for idx, cam_label in self._cameras:
            if cam_label == label:
                return idx
        return None

    def _apply_camera(self) -> None:
        idx = self._selected_camera_index()
        if idx is None:
            self._manager.stats.add_log("No camera selected")
            return
        self._camera.switch_camera(idx)
        self._manager.stats.add_log(f"Camera switched → index {idx}")

    def _set_mode(self, mode: SystemMode) -> None:
        self._manager.set_mode(mode)
        self._refresh_mode_buttons(mode)

    def _toggle_skeleton_debug(self) -> None:
        enabled = self._skeleton_debug_var.get()
        self._manager.set_skeleton_debug(enabled)

    def _refresh_mode_buttons(self, active: SystemMode) -> None:
        for mode, btn in self._mode_buttons.items():
            if mode == active:
                btn.configure(bg="#171717", fg="white", activebackground="#262626")
            else:
                btn.configure(bg="#f5f5f5", fg="#525252", activebackground="#e5e5e5")

    def _toggle_sidebar(self) -> None:
        self._panel_visible = not self._panel_visible
        if self._panel_visible:
            self._right_panel.pack(side=tk.RIGHT, fill=tk.Y, padx=(10, 0))
        else:
            self._right_panel.pack_forget()
        self._manager.stats.add_log("Side panel " + ("shown" if self._panel_visible else "hidden"))

    def _quit(self) -> None:
        if not self._running:
            return
        self._running = False
        self._on_close()
        self.root.destroy()

    def _tick(self) -> None:
        if not self._running:
            return

        joint_data, cam_frame = self._manager.get_frame_and_data()
        stats = self._manager.stats

        if cam_frame is not None:
            self._debugger.notify_new_frame()

        display = self._debugger.render(cam_frame, joint_data, stats)
        self._show_frame(display)
        self._update_stats(stats, joint_data)
        self._update_log(stats.log_messages)

        if self._skeleton_debug_var.get() != stats.skeleton_debug:
            self._skeleton_debug_var.set(stats.skeleton_debug)

        self.root.after(33, self._tick)

    def _video_bounds(self) -> tuple[int, int]:
        self.root.update_idletasks()
        w = self.root.winfo_width()
        h = self.root.winfo_height()
        if w < 100:
            w = self.root.winfo_screenwidth()
        if h < 100:
            h = self.root.winfo_screenheight()
        sidebar = config.DEBUG_PANEL_WIDTH + 30 if self._panel_visible else 0
        return max(640, w - sidebar - 20), max(480, h - 40)

    def _show_frame(self, bgr: np.ndarray) -> None:
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        max_w, max_h = self._video_bounds()
        scale = min(max_w / w, max_h / h, 1.0)
        if scale < 1.0:
            rgb = cv2.resize(rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

        img = Image.fromarray(rgb)
        self._photo = ImageTk.PhotoImage(image=img)
        self._video_label.configure(image=self._photo, text="")

    def _update_stats(self, stats, joint_data: Optional[JointData]) -> None:
        cam = stats.camera_status.value
        iot = stats.iot_status.value
        lines = [
            f"Mode: {stats.current_mode.value}",
            f"Poses in frame: {stats.pose_count} (max {config.MEDIAPIPE_MAX_POSES})",
            f"Camera: {cam}  ·  {stats.camera_fps:.1f} fps  ·  {stats.camera_latency_ms:.0f} ms",
            f"IoT: {iot}  ·  {stats.iot_poll_rate_hz:.1f} Hz  ·  {self._iot.get_serial_port()}",
            f"Skeleton debug: {'ON' if stats.skeleton_debug else 'OFF'}",
            f"Bridge: http://127.0.0.1:{config.WEB_BRIDGE_PORT}",
        ]
        if stats.current_mode == SystemMode.FUSION:
            lines.append(f"Fusion α: {stats.fusion_alpha:.2f}")
        self._stats_var.set("\n".join(lines))

        if joint_data:
            j = joint_data
            lines = [
                "Joint angles (°)",
                f"Elbow L/R: {j.elbow_left:.0f} / {j.elbow_right:.0f}",
                f"Knee L/R: {j.knee_left:.0f} / {j.knee_right:.0f}",
                f"Shldr L/R: {j.shoulder_left:.0f} / {j.shoulder_right:.0f}",
                f"Confidence: {j.confidence * 100:.0f}%  ·  {j.source}",
            ]
            if j.hand_left_detected or j.hand_right_detected:
                lines.append("")
                lines.append("Hand / palm check")
                if j.hand_left_detected:
                    lines.append(
                        f"L: {j.palm_left_facing}  "
                        f"{'OK' if j.palm_left_ok else 'CHECK'}  "
                        f"straight {j.finger_left_straight_score * 100:.0f}%"
                    )
                if j.hand_right_detected:
                    lines.append(
                        f"R: {j.palm_right_facing}  "
                        f"{'OK' if j.palm_right_ok else 'CHECK'}  "
                        f"straight {j.finger_right_straight_score * 100:.0f}%"
                    )
            self._joints_var.set("\n".join(lines))
        else:
            hint = "Stand in frame for MediaPipe" if stats.camera_status == ConnectionStatus.CONNECTED else "Check camera / Apply"
            self._joints_var.set(f"Joint angles\n{hint}")

    def _update_log(self, messages: List[str]) -> None:
        self._log_text.configure(state=tk.NORMAL)
        self._log_text.delete("1.0", tk.END)
        for msg in messages[-12:]:
            self._log_text.insert(tk.END, msg + "\n")
        self._log_text.configure(state=tk.DISABLED)
        self._log_text.see(tk.END)
