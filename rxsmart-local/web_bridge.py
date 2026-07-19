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
from sensor_mapper import (
    SensorMappingManager,
    calibrated_to_degrees,
    sensors_to_angles,
)

if TYPE_CHECKING:
    from system_mode_manager import SystemModeManager

_MODE_FROM_API = {
    "CAMERA_ONLY": SystemMode.CAMERA_ONLY,
    "IOT_ONLY": SystemMode.IOT_ONLY,
    "FUSION": SystemMode.FUSION,
}


def _lm_dict(lm: Any) -> dict[str, float]:
    return {
        "x": round(float(lm.x), 5),
        "y": round(float(lm.y), 5),
        "z": round(float(lm.z), 5),
        "visibility": round(float(getattr(lm, "visibility", 1.0) or 1.0), 3),
    }


def _pose_landmarks_payload(joint_data: Optional[JointData]) -> Optional[list[dict[str, float]]]:
    if joint_data is None or not joint_data.raw_landmarks:
        return None
    return [_lm_dict(lm) for lm in joint_data.raw_landmarks]


def _hands_payload(joint_data: Optional[JointData]) -> list[dict[str, Any]]:
    if joint_data is None or not joint_data.raw_hands:
        return []
    hands: list[dict[str, Any]] = []
    for hand in joint_data.raw_hands:
        landmarks = hand.get("landmarks") if isinstance(hand, dict) else None
        label = hand.get("label", "Unknown") if isinstance(hand, dict) else "Unknown"
        if not landmarks:
            continue
        hands.append({
            "label": label,
            "landmarks": [_lm_dict(lm) for lm in landmarks],
        })
    return hands


def _joint_to_dict(j: JointData, sensor_map: Optional[dict] = None) -> dict[str, Any]:
    payload = {
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
        "hand_left_detected": j.hand_left_detected,
        "hand_right_detected": j.hand_right_detected,
        "palm_left_facing": j.palm_left_facing,
        "palm_right_facing": j.palm_right_facing,
        "palm_left_ok": j.palm_left_ok,
        "palm_right_ok": j.palm_right_ok,
        "fingers_left_extended": j.fingers_left_extended,
        "fingers_right_extended": j.fingers_right_extended,
        "fingers_left_straight": j.fingers_left_straight,
        "fingers_right_straight": j.fingers_right_straight,
        "finger_left_straight_score": round(j.finger_left_straight_score, 2),
        "finger_right_straight_score": round(j.finger_right_straight_score, 2),
    }
    if j.sensor_channels:
        payload["sensors"] = [
            {
                "channel": s.get("channel", idx),
                "key": s.get("key", ""),
                "calibrated": s.get("calibrated", 0),
                "degrees": round(calibrated_to_degrees(float(s.get("calibrated", 0))), 2),
            }
            for idx, s in enumerate(j.sensor_channels)
        ]
    if sensor_map:
        payload["sensor_map"] = {str(k): v for k, v in sorted(sensor_map.items())}
    return payload


def _channel_degrees(joint_data: Optional[JointData]) -> Optional[list[float]]:
    if not joint_data or not joint_data.sensor_channels:
        return None
    by_ch = {
        int(s.get("channel", idx)): calibrated_to_degrees(float(s.get("calibrated", 0)))
        for idx, s in enumerate(joint_data.sensor_channels)
    }
    if len(by_ch) < 8:
        return None
    return [by_ch[i] for i in range(8)]


def _apply_sensor_mapping(
    joint_data: Optional[JointData],
    mapper: SensorMappingManager,
) -> Optional[JointData]:
    if joint_data is None:
        return None

    degrees = _channel_degrees(joint_data)
    if degrees is None:
        return joint_data

    mapper.ingest_channels(degrees)

    mapped = sensors_to_angles(degrees, mapper.channel_map, mapper.pose_defaults)
    return JointData(
        elbow_left=mapped["elbow_left"],
        elbow_right=mapped["elbow_right"],
        knee_left=mapped["knee_left"],
        knee_right=mapped["knee_right"],
        shoulder_left=mapped["shoulder_left"],
        shoulder_right=mapped["shoulder_right"],
        source=joint_data.source,
        confidence=joint_data.confidence,
        timestamp_ms=joint_data.timestamp_ms,
        raw_landmarks=joint_data.raw_landmarks,
        raw_hands=joint_data.raw_hands,
        raw_sensors=joint_data.raw_sensors,
        sensor_channels=joint_data.sensor_channels,
        pose_frame=joint_data.pose_frame,
        posture_state=joint_data.posture_state,
        posture_fault_mask=joint_data.posture_fault_mask,
        rep_count=joint_data.rep_count,
        rep_target=joint_data.rep_target,
        speed_dps=joint_data.speed_dps,
        session_state=joint_data.session_state,
        alert_level=joint_data.alert_level,
        alert_code=joint_data.alert_code,
        hand_left_detected=joint_data.hand_left_detected,
        hand_right_detected=joint_data.hand_right_detected,
        palm_left_facing=joint_data.palm_left_facing,
        palm_right_facing=joint_data.palm_right_facing,
        palm_left_ok=joint_data.palm_left_ok,
        palm_right_ok=joint_data.palm_right_ok,
        fingers_left_extended=joint_data.fingers_left_extended,
        fingers_right_extended=joint_data.fingers_right_extended,
        fingers_left_straight=joint_data.fingers_left_straight,
        fingers_right_straight=joint_data.fingers_right_straight,
        finger_left_straight_score=joint_data.finger_left_straight_score,
        finger_right_straight_score=joint_data.finger_right_straight_score,
    )


class WebBridgeServer:
    """HTTP bridge so the static web dashboard can read this machine's pipeline."""

    def __init__(self, manager: SystemModeManager) -> None:
        self._manager = manager
        self._mapper = SensorMappingManager()
        self._mapper.load()
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

            mapped_joints = _apply_sensor_mapping(joint_data, bridge._mapper)
            session_feedback = bridge._manager.get_session_feedback(mapped_joints)

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
                "skeleton_debug": stats.skeleton_debug,
                "pose_count": stats.pose_count,
                "max_poses": max(1, min(4, config.MEDIAPIPE_MAX_POSES)),
                "pose_landmarks": _pose_landmarks_payload(joint_data),
                "hand_landmarks": _hands_payload(joint_data),
                "joints": _joint_to_dict(mapped_joints, bridge._mapper.channel_map)
                if mapped_joints
                else None,
                "sensor_mapping": bridge._mapper.to_api_dict(),
                "exercise_id": bridge._manager.current_exercise_id,
                "session_feedback": session_feedback.to_dict(),
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

        @app.route("/api/debug", methods=["POST", "OPTIONS"])
        def set_debug():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))

            body = request.get_json(force=True, silent=True) or {}
            if "skeleton_debug" not in body:
                return jsonify({
                    "ok": False,
                    "error": "skeleton_debug (boolean) required",
                }), 400

            enabled = bool(body.get("skeleton_debug"))
            bridge._manager.set_skeleton_debug(enabled)
            return jsonify({
                "ok": True,
                "skeleton_debug": bridge._manager.skeleton_debug,
            })

        @app.route("/api/exercises", methods=["GET", "OPTIONS"])
        def exercises():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))
            return jsonify({
                "ok": True,
                "exercises": bridge._manager.exercise_catalog(),
                "current": bridge._manager.current_exercise_id,
            })

        @app.route("/api/exercise", methods=["POST", "OPTIONS"])
        def select_exercise():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))

            body = request.get_json(force=True, silent=True) or {}
            exercise_id = str(body.get("id", ""))
            if not bridge._manager.select_exercise(exercise_id):
                return jsonify({"ok": False, "error": f"unknown exercise: {exercise_id}"}), 400

            return jsonify({"ok": True, "current": bridge._manager.current_exercise_id})

        @app.route("/api/session", methods=["POST", "OPTIONS"])
        def session_action():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))

            body = request.get_json(force=True, silent=True) or {}
            action = str(body.get("action", "")).lower()
            if not bridge._manager.exercise_session_action(action):
                return jsonify({
                    "ok": False,
                    "error": "action must be start, stop, or reset",
                }), 400

            return jsonify({"ok": True, "action": action})

        @app.route("/api/sensor-map", methods=["GET", "POST", "OPTIONS"])
        def sensor_map():
            if request.method == "OPTIONS":
                return _cors(Response(status=204))

            if request.method == "GET":
                return jsonify({"ok": True, **bridge._mapper.to_api_dict()})

            body = request.get_json(force=True, silent=True) or {}
            action = str(body.get("action", "set")).lower()

            if action == "reset":
                bridge._mapper.reset_to_default()
            elif action == "auto_recheck":
                joint_data = bridge._manager.get_frame_and_data()[0]
                fw_angles = None
                if joint_data:
                    fw_angles = {
                        "elbow_left": joint_data.elbow_left,
                        "elbow_right": joint_data.elbow_right,
                        "knee_left": joint_data.knee_left,
                        "knee_right": joint_data.knee_right,
                    }
                result = bridge._mapper.run_auto_recheck(fw_angles)
                return jsonify({"ok": True, **result})
            elif action == "calibrate_start":
                bridge._mapper.start_guided_calibration()
            elif action == "calibrate_next":
                step = bridge._mapper.advance_calibration_step()
                return jsonify({
                    "ok": True,
                    "step": step,
                    **bridge._mapper.to_api_dict(),
                })
            elif action == "set":
                raw_map = body.get("channel_map", {})
                if isinstance(raw_map, dict) and raw_map:
                    channel_map = {int(k): str(v) for k, v in raw_map.items()}
                    bridge._mapper.set_map(
                        channel_map,
                        float(body.get("confidence", 1.0)),
                    )
            else:
                return jsonify({"ok": False, "error": f"unknown action: {action}"}), 400

            return jsonify({"ok": True, **bridge._mapper.to_api_dict()})

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
