"""
Module 2: IoTReceiver
Receives telemetry from the ESP32 via Serial (USB, primary) or HTTP poll
(Cloudflare Worker API, fallback).  Runs in a daemon thread and exposes
the latest JointData via a thread-safe getter.

Serial line format emitted by printRealtimeDebug() every 500 ms:
  [DBG] t=<ms> state=<idle|…> cal=<0|1> rep=<n>/<target>
        posture=<ok|bad> speed=<float> alert=<none|warn|critical> code=<uint>
        i2c=<sda>/<scl> mpu68=<ok|err|na> mpu69=<ok|err|na>
        rawA=<float> rawB=<float>
        elbowL=<float> elbowR=<float> kneeL=<float> kneeR=<float>
"""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Optional

import config
from data_models import ConnectionStatus, JointData

# ---------------------------------------------------------------------------
# Pre-compiled regex for the ESP32 Serial debug line
# ---------------------------------------------------------------------------
_DBG_RE = re.compile(
    r"\[DBG\]\s+"
    r"t=(\d+)\s+"
    r"state=(\S+)\s+"
    r"cal=(\d)\s+"
    r"rep=(\d+)/(\d+)\s+"
    r"posture=(\S+)\s+"
    r"speed=([\d.]+)\s+"
    r"alert=(\S+)\s+"
    r"code=(\d+)\s+"
    r"i2c=(\d+)/(\d+)\s+"
    r"mpu68=(\S+)\s+"
    r"mpu69=(\S+)\s+"
    r"rawA=([\d.]+)\s+"
    r"rawB=([\d.]+)\s+"
    r"elbowL=([\d.]+)\s+"
    r"elbowR=([\d.]+)\s+"
    r"kneeL=([\d.]+)\s+"
    r"kneeR=([\d.]+)"
)


class IoTReceiver:
    """
    Receives ESP32 telemetry and converts it to JointData.

    Transports:
      - "serial"  : reads USB Serial at 115200 baud (~500 ms, requires USB cable)
      - "http"    : polls Cloudflare Worker /api/debug/telemetry (~1-3 s, needs WiFi)
      - "server"  : Python runs a local HTTP server; ESP32 POSTs directly over LAN
                    (~50 ms, no cable — both devices must be on the same WiFi network)

    Usage:
        receiver = IoTReceiver(transport="server")
        receiver.start()
        data = receiver.get_latest()   # Optional[JointData]
        receiver.stop()
    """

    def __init__(self, transport: str = config.IOT_TRANSPORT) -> None:
        if transport not in ("serial", "http", "server"):
            raise ValueError(
                f"Unknown IoT transport: {transport!r}. Use 'serial', 'http', or 'server'."
            )
        self._transport = transport

        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._flask_server = None   # werkzeug server instance (server mode only)

        self._latest: Optional[JointData] = None
        self._status: ConnectionStatus = ConnectionStatus.DISCONNECTED
        self._last_received_ts: float = 0.0
        self._poll_times: list = []
        self._latency_ms: float = 0.0
        self._device_id: str = config.DEVICE_ID

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        target = {
            "serial": self._serial_loop,
            "http": self._http_loop,
            "server": self._server_loop,
        }[self._transport]
        self._thread = threading.Thread(
            target=target,
            daemon=True,
            name=f"IoTReceiver-{self._transport}",
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

    @property
    def status(self) -> ConnectionStatus:
        """Returns TIMEOUT if no packet has been received within the watchdog window."""
        if self._status == ConnectionStatus.CONNECTED:
            if time.time() - self._last_received_ts > config.IOT_WATCHDOG_TIMEOUT_S:
                return ConnectionStatus.TIMEOUT
        return self._status

    @property
    def poll_rate_hz(self) -> float:
        if len(self._poll_times) < 2:
            return 0.0
        intervals = [
            self._poll_times[i + 1] - self._poll_times[i]
            for i in range(len(self._poll_times) - 1)
        ]
        avg = sum(intervals) / len(intervals)
        return 1.0 / avg if avg > 0 else 0.0

    @property
    def latency_ms(self) -> float:
        return self._latency_ms

    def get_latest(self) -> Optional[JointData]:
        """Thread-safe snapshot of the most recent JointData from the ESP32."""
        with self._lock:
            return self._latest

    # ------------------------------------------------------------------
    # Serial transport
    # ------------------------------------------------------------------

    def _serial_loop(self) -> None:
        try:
            import serial  # pyserial
        except ImportError:
            print("[IoTReceiver] ERROR: pyserial not installed. Run: pip install pyserial")
            self._status = ConnectionStatus.ERROR
            return

        ser = None
        while self._running:
            # --- Establish / re-establish connection ---
            if ser is None or not ser.is_open:
                try:
                    ser = serial.Serial(
                        port=config.SERIAL_PORT,
                        baudrate=config.SERIAL_BAUDRATE,
                        timeout=config.SERIAL_TIMEOUT,
                    )
                    self._status = ConnectionStatus.CONNECTED
                    print(f"[IoTReceiver] Serial connected on {config.SERIAL_PORT}")
                except Exception as exc:
                    print(f"[IoTReceiver] Serial open failed: {exc}. Retrying in 2 s…")
                    self._status = ConnectionStatus.ERROR
                    time.sleep(2.0)
                    continue

            # --- Read one line ---
            try:
                t_start = time.perf_counter()
                raw_bytes = ser.readline()
                self._latency_ms = (time.perf_counter() - t_start) * 1000.0

                if not raw_bytes:
                    continue

                line = raw_bytes.decode("utf-8", errors="replace").strip()
                jd = self._parse_serial_line(line)
                if jd is not None:
                    self._record_packet()
                    with self._lock:
                        self._latest = jd

            except Exception as exc:
                print(f"[IoTReceiver] Serial read error: {exc}. Reconnecting…")
                self._status = ConnectionStatus.ERROR
                try:
                    ser.close()
                except Exception:
                    pass
                ser = None
                time.sleep(1.0)

        if ser and ser.is_open:
            ser.close()

    def _parse_serial_line(self, line: str) -> Optional[JointData]:
        """Parse the [DBG] formatted line emitted by printRealtimeDebug()."""
        m = _DBG_RE.search(line)
        if not m:
            return None
        (
            t_ms, state, cal,
            rep_count, rep_target,
            posture, speed,
            alert_level, alert_code,
            i2c_sda, i2c_scl,
            mpu68, mpu69,
            raw_a, raw_b,
            elbow_l, elbow_r,
            knee_l, knee_r,
        ) = m.groups()

        calibrated = int(cal) == 1

        return JointData(
            elbow_left=float(elbow_l),
            elbow_right=float(elbow_r),
            knee_left=float(knee_l),
            knee_right=float(knee_r),
            shoulder_left=0.0,   # not in Serial output
            shoulder_right=0.0,
            source="iot",
            confidence=1.0 if calibrated else 0.5,
            timestamp_ms=float(t_ms),
            raw_sensors={
                "raw_a": float(raw_a),
                "raw_b": float(raw_b),
                "mpu68": mpu68,
                "mpu69": mpu69,
                "i2c_sda": int(i2c_sda),
                "i2c_scl": int(i2c_scl),
            },
            posture_state="correct" if posture == "ok" else "incorrect",
            posture_fault_mask=0,
            rep_count=int(rep_count),
            rep_target=int(rep_target),
            speed_dps=float(speed),
            session_state=state,
            alert_level=alert_level,
            alert_code=int(alert_code),
        )

    # ------------------------------------------------------------------
    # HTTP transport
    # ------------------------------------------------------------------

    def _http_loop(self) -> None:
        try:
            import requests
        except ImportError:
            print("[IoTReceiver] ERROR: requests not installed. Run: pip install requests")
            self._status = ConnectionStatus.ERROR
            return

        while self._running:
            t_start = time.perf_counter()
            try:
                device_param = f"&device_id={self._device_id}" if self._device_id else ""
                url = f"{config.API_BASE_URL}/api/debug/telemetry?limit=1{device_param}"
                resp = requests.get(url, timeout=5.0)
                self._latency_ms = (time.perf_counter() - t_start) * 1000.0

                if resp.status_code == 200:
                    data = resp.json()
                    # Worker returns {"rows": [...]} or {"data": [...]}
                    rows = data.get("rows") or data.get("data") or []
                    if rows:
                        jd = self._parse_http_row(rows[0])
                        if jd is not None:
                            self._record_packet()
                            self._status = ConnectionStatus.CONNECTED
                            with self._lock:
                                self._latest = jd
                else:
                    self._status = ConnectionStatus.ERROR

            except Exception as exc:
                self._latency_ms = (time.perf_counter() - t_start) * 1000.0
                print(f"[IoTReceiver] HTTP poll error: {exc}")
                self._status = ConnectionStatus.ERROR

            time.sleep(config.HTTP_POLL_INTERVAL_S)

    def _parse_http_row(self, row: dict) -> Optional[JointData]:
        """Parse a Google Sheets row returned by the Cloudflare Worker."""
        try:
            payload_raw = row.get("Payload_JSON") or row.get("payload_json") or "{}"
            payload: dict = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw

            angles: dict = payload.get("angles", {})
            posture: dict = payload.get("posture", {})
            alerts: list = payload.get("alerts", [])
            sensors_raw: list = payload.get("sensors", [])

            alert_level = alerts[0].get("level", "none") if alerts else "none"
            alert_code = int(alerts[0].get("code", 0)) if alerts else 0

            # Auto-detect device_id for subsequent polls
            device_id = row.get("Device_ID", "")
            if device_id and not self._device_id:
                self._device_id = device_id

            calibrated = bool(payload.get("calibrated", False))

            return JointData(
                elbow_left=float(angles.get("elbow_left", 0.0)),
                elbow_right=float(angles.get("elbow_right", 0.0)),
                knee_left=float(angles.get("knee_left", 0.0)),
                knee_right=float(angles.get("knee_right", 0.0)),
                shoulder_left=0.0,
                shoulder_right=0.0,
                source="iot",
                confidence=1.0 if calibrated else 0.5,
                timestamp_ms=float(payload.get("device_ts_ms", time.time() * 1000)),
                raw_sensors={"sensors": sensors_raw},
                posture_state=posture.get("state", "unknown"),
                posture_fault_mask=int(posture.get("fault_mask", 0)),
                rep_count=int(payload.get("rep_count", 0)),
                rep_target=int(payload.get("rep_target", 0)),
                speed_dps=float(payload.get("speed_dps", 0.0)),
                session_state=payload.get("session_state", "idle"),
                alert_level=alert_level,
                alert_code=alert_code,
            )
        except Exception as exc:
            print(f"[IoTReceiver] HTTP row parse error: {exc}")
            return None

    # ------------------------------------------------------------------
    # Local HTTP server transport  (IOT_TRANSPORT = "server")
    # ------------------------------------------------------------------

    def _server_loop(self) -> None:
        """
        Runs a Flask HTTP server so the ESP32 can POST telemetry directly
        to this machine over WiFi — no USB cable required.

        Endpoints:
          POST /telemetry   — receive compact JSON from the ESP32 firmware patch
          GET  /status      — health-check (returns latest connection info)
        """
        try:
            from flask import Flask, jsonify, request
            from werkzeug.serving import make_server
        except ImportError:
            print(
                "[IoTReceiver] ERROR: flask not installed.\n"
                "  Run: pip install flask"
            )
            self._status = ConnectionStatus.ERROR
            return

        import logging
        logging.getLogger("werkzeug").setLevel(logging.ERROR)

        app = Flask(__name__)
        receiver = self  # closure reference

        @app.route("/telemetry", methods=["POST"])
        def recv_telemetry():
            t_recv = time.perf_counter()
            body = request.get_json(force=True, silent=True)
            if body is None:
                return jsonify({"ok": False, "error": "invalid JSON"}), 400
            jd = receiver._parse_local_json(body)
            if jd is None:
                return jsonify({"ok": False, "error": "parse failed"}), 422
            receiver._latency_ms = (time.perf_counter() - t_recv) * 1000.0
            receiver._record_packet()
            receiver._status = ConnectionStatus.CONNECTED
            with receiver._lock:
                receiver._latest = jd
            return jsonify({"ok": True})

        @app.route("/status", methods=["GET"])
        def srv_status():
            with receiver._lock:
                has_data = receiver._latest is not None
            return jsonify({
                "status": receiver._status.value,
                "last_received_ago_s": round(time.time() - receiver._last_received_ts, 2),
                "poll_rate_hz": round(receiver.poll_rate_hz, 2),
                "has_data": has_data,
            })

        local_ip = self._get_local_ip()
        print(
            f"\n[IoTReceiver] Local server started:\n"
            f"  Listening → http://0.0.0.0:{config.LOCAL_SERVER_PORT}/telemetry\n"
            f"  Your LAN IP → http://{local_ip}:{config.LOCAL_SERVER_PORT}/telemetry\n"
            f"  Set LOCAL_SERVER_URL in firmware to: http://{local_ip}:{config.LOCAL_SERVER_PORT}\n"
        )

        srv = make_server(
            config.LOCAL_SERVER_HOST,
            config.LOCAL_SERVER_PORT,
            app,
        )
        self._flask_server = srv
        srv.serve_forever()

    def _parse_local_json(self, data: dict) -> Optional[JointData]:
        """
        Parse the compact JSON POSTed by the ESP32 firmware patch.
        Accepts both the compact format (firmware snippet) and the full
        telemetry-v2 format so either payload works.
        """
        try:
            # --- Full telemetry-v2 format (same as Cloudflare Worker) ---
            if "angles" in data:
                angles = data.get("angles", {})
                posture = data.get("posture", {})
                alerts = data.get("alerts", [])
                calibrated = bool(data.get("calibrated", False))
                alert_level = alerts[0].get("level", "none") if alerts else "none"
                alert_code = int(alerts[0].get("code", 0)) if alerts else 0
                return JointData(
                    elbow_left=float(angles.get("elbow_left", 0.0)),
                    elbow_right=float(angles.get("elbow_right", 0.0)),
                    knee_left=float(angles.get("knee_left", 0.0)),
                    knee_right=float(angles.get("knee_right", 0.0)),
                    shoulder_left=0.0,
                    shoulder_right=0.0,
                    source="iot",
                    confidence=1.0 if calibrated else 0.5,
                    timestamp_ms=float(data.get("device_ts_ms", time.time() * 1000)),
                    raw_sensors=data,
                    posture_state=posture.get("state", "unknown"),
                    posture_fault_mask=int(posture.get("fault_mask", 0)),
                    rep_count=int(data.get("rep_count", 0)),
                    rep_target=int(data.get("rep_target", 0)),
                    speed_dps=float(data.get("speed_dps", 0.0)),
                    session_state=data.get("session_state", "idle"),
                    alert_level=alert_level,
                    alert_code=alert_code,
                )

            # --- Compact format from firmware_local_server_snippet.ino ---
            return JointData(
                elbow_left=float(data.get("elbow_left", data.get("elbowL", 0.0))),
                elbow_right=float(data.get("elbow_right", data.get("elbowR", 0.0))),
                knee_left=float(data.get("knee_left", data.get("kneeL", 0.0))),
                knee_right=float(data.get("knee_right", data.get("kneeR", 0.0))),
                shoulder_left=0.0,
                shoulder_right=0.0,
                source="iot",
                confidence=1.0 if data.get("cal", 0) else 0.5,
                timestamp_ms=float(data.get("t_ms", time.time() * 1000)),
                raw_sensors=data,
                posture_state="correct" if data.get("posture", "bad") == "ok" else "incorrect",
                posture_fault_mask=0,
                rep_count=int(data.get("rep_count", 0)),
                rep_target=int(data.get("rep_target", 0)),
                speed_dps=float(data.get("speed_dps", 0.0)),
                session_state=data.get("state", "idle"),
                alert_level=data.get("alert", "none"),
                alert_code=int(data.get("alert_code", 0)),
            )
        except Exception as exc:
            print(f"[IoTReceiver] Local JSON parse error: {exc}")
            return None

    @staticmethod
    def _get_local_ip() -> str:
        """Best-effort detection of the machine's LAN IP address."""
        import socket
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            return "127.0.0.1"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _record_packet(self) -> None:
        """Track reception timestamp for poll-rate calculation."""
        now = time.time()
        self._last_received_ts = now
        self._poll_times.append(now)
        if len(self._poll_times) > 30:
            self._poll_times = self._poll_times[-30:]
