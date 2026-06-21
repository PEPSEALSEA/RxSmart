"""
Web Bridge — exposes the local pipeline (camera / IMU / fusion) to the browser.

Run alongside main.py. GitHub Pages (or any web UI) can call:

  GET  /api/health
  GET  /api/state          → mode, stats, joint angles (JSON)
  GET  /api/frame.jpg      → latest annotated camera frame
  POST /api/mode           → { "mode": "CAMERA_ONLY" | "IOT_ONLY" | "FUSION" }

CORS is enabled so https://*.github.io can reach http://127.0.0.1 on this PC.
"""
from __future__ import annotations

import logging
import socket
import threading
import time
from typing import TYPE_CHECKING, Any, Optional

import cv2
import numpy as np

import config
from data_models import JointData, SystemMode

if TYPE_CHECKING:
    from system_mode_manager import SystemModeManager

_MODE_FROM_API = {
    "CAMERA_ONLY": SystemMode.CAMERA_ONLY,
    "IOT_ONLY": SystemMode.IOT_ONLY,
    "FUSION": SystemMode.FUSION,
}


def _joint_to_dict(j: JointData) -> dict[str, Any]:
    return {
        "elbow_left": round(j.elbow_left, 2),
        "elbow_right": round(j.elbow_right, 2),
        "knee_left": round(j.knee_left, 2),
        "knee_right": round(j.knee_right, 2),
        "shoulder_left": round(j.shoulder_left, 2),
        "shoulder_right": round(j.shoulder_right, 2),
        "source": j.source,
        "confidence": round(j.confidence, 3),
        "posture_state": j.posture_state,
        "rep_count": j.rep_count,
        "rep_target": j.rep_target,
        "speed_dps": round(j.speed_dps, 2),
        "session_state": j.session_state,
        "alert_level": j.alert_level,
    }


class WebBridgeServer:
    """HTTP bridge so the static web dashboard can read this machine's pipeline."""

    def __init__(self, manager: SystemModeManager) -> None:
        self._manager = manager
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._flask_server = None

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._serve,
            daemon=True,
            name="WebBridgeServer",
        )
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        if self._flask_server is not None:
            try:
                self._flask_server.shutdown()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5.0)

    def _serve(self) -> None:
        try:
            from flask import Flask, Response, jsonify, request
            from werkzeug.serving import make_server
        except ImportError:
            print(
                "[WebBridge] ERROR: flask not installed.\n"
                "  Run: pip install flask"
            )
            return

        logging.getLogger("werkzeug").setLevel(logging.ERROR)

        app = Flask(__name__)
        bridge = self

        def _cors(resp):
            resp.headers["Access-Control-Allow-Origin"] = "*"
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
            resp.headers["Cache-Control"] = "no-store"
            return resp

        @app.after_request
        def after_request(resp):
            return _cors(resp)

        @app.route("/api/health", methods=["GET", "OPTIONS"])
        def health():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))
            return jsonify({
                "ok": True,
                "service": "rxsmart-local-bridge",
                "version": 1,
            })

        @app.route("/api/state", methods=["GET", "OPTIONS"])
        def state():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))

            joint_data, cam_frame = bridge._manager.get_frame_and_data()
            stats = bridge._manager.stats

            payload: dict[str, Any] = {
                "ok": True,
                "ts": int(time.time() * 1000),
                "mode": bridge._manager.mode.value,
                "camera_status": stats.camera_status.value,
                "iot_status": stats.iot_status.value,
                "camera_fps": round(stats.camera_fps, 1),
                "camera_latency_ms": round(stats.camera_latency_ms, 1),
                "iot_poll_rate_hz": round(stats.iot_poll_rate_hz, 2),
                "iot_latency_ms": round(stats.iot_latency_ms, 1),
                "fusion_alpha": round(stats.fusion_alpha, 3),
                "has_frame": cam_frame is not None,
                "joints": _joint_to_dict(joint_data) if joint_data else None,
            }
            return jsonify(payload)

        @app.route("/api/frame.jpg", methods=["GET", "OPTIONS"])
        def frame_jpg():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))

            _, cam_frame = bridge._manager.get_frame_and_data()
            if cam_frame is None:
                placeholder = np.full(
                    (360, 640, 3), (245, 245, 245), dtype=np.uint8
                )
                cv2.putText(
                    placeholder,
                    "No camera frame",
                    (180, 180),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    config.COLOR_MUTED,
                    1,
                    cv2.LINE_AA,
                )
                cam_frame = placeholder

            ok, buf = cv2.imencode(
                ".jpg", cam_frame, [cv2.IMWRITE_JPEG_QUALITY, 82]
            )
            if not ok:
                return jsonify({"ok": False, "error": "encode failed"}), 500

            return Response(buf.tobytes(), mimetype="image/jpeg")

        @app.route("/api/mode", methods=["POST", "OPTIONS"])
        def set_mode():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))

            body = request.get_json(force=True, silent=True) or {}
            mode_key = str(body.get("mode", "")).upper()
            mode = _MODE_FROM_API.get(mode_key)
            if mode is None:
                return jsonify({
                    "ok": False,
                    "error": "mode must be CAMERA_ONLY, IOT_ONLY, or FUSION",
                }), 400

            bridge._manager.set_mode(mode)
            return jsonify({"ok": True, "mode": mode.value})

        host = config.WEB_BRIDGE_HOST
        port = config.WEB_BRIDGE_PORT
        local_ip = self._get_local_ip()

        print(
            f"\n[WebBridge] Browser bridge started:\n"
            f"  Local   → http://127.0.0.1:{port}/api/state\n"
            f"  LAN     → http://{local_ip}:{port}/api/state\n"
            f"  GitHub Pages can call 127.0.0.1 when this PC runs main.py\n"
        )

        srv = make_server(host, port, app)
        self._flask_server = srv
        srv.serve_forever()

    @staticmethod
    def _get_local_ip() -> str:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            return "127.0.0.1"
