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
# Pre-compiled regex for the ESP32 Serial debug block
# ---------------------------------------------------------------------------
# ESP32: i2c=21/22  ·  Pico: i2c=GP4/GP5
_DBG_HEADER_RE = re.compile(
    r"\[DBG\]\s+"
    r"t=(\d+)\s+"
    r"state=(\S+)\s+"
    r"cal=(\d)\s+"
    r"rep=(\d+)/(\d+)\s+"
    r"posture=(\S+)\s+"
    r"speed=([\d.]+)\s+"
    r"alert=(\S+)\s+"
    r"code=(\d+)\s+"
    r"i2c=(?:GP)?(\d+)/(?:GP)?(\d+)"
)

_DBG_ANGLES_RE = re.compile(
    r"angles:\s+"
    r"elbowL=([\d.]+)\s+"
    r"elbowR=([\d.]+)\s+"
    r"kneeL=([\d.]+)\s+"
    r"kneeR=([\d.]+)"
)

_DBG_CH_RE = re.compile(
    r"CH(\d+)\s+\[(\S+)\s*\]\s+"
    r"raw=([\d.]+)\s+"
    r"cal=([\d.]+)\s+"
    r"(\S+)"
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

    def __init__(
        self,
        transport: str = config.IOT_TRANSPORT,
        serial_port: Optional[str] = None,
    ) -> None:
        if transport not in ("serial", "http", "server"):
            raise ValueError(
                f"Unknown IoT transport: {transport!r}. Use 'serial', 'http', or 'server'."
            )
        self._transport = transport
        self._serial_port = serial_port or config.SERIAL_PORT_FALLBACK

        self._lock = threading.Lock()
        self._port_lock = threading.Lock()
        self._force_serial_reconnect = False
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._flask_server = None   # werkzeug server instance (server mode only)

        self._latest: Optional[JointData] = None
        self._status: ConnectionStatus = ConnectionStatus.DISCONNECTED
        self._last_received_ts: float = 0.0
        self._serial_opened_at: float = 0.0
        self._open_fail_streak: int = 0
        self._poll_times: list = []
        self._latency_ms: float = 0.0
        self._device_id: str = config.DEVICE_ID

        # Multi-line [DBG] block accumulator (header + angles + 8× CH lines)
        self._dbg_block: Optional[dict] = None

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
        """Returns TIMEOUT only after at least one packet, then silence too long."""
        if self._status == ConnectionStatus.CONNECTED and self._last_received_ts > 0:
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

    def get_serial_port(self) -> str:
        with self._port_lock:
            return self._serial_port

    def set_serial_port(self, port: str) -> None:
        """Switch USB serial port; reconnect loop picks up the new port."""
        port = port.strip()
        if not port:
            return
        with self._port_lock:
            if port == self._serial_port:
                return
            self._serial_port = port
            self._force_serial_reconnect = True
        print(f"[IoTReceiver] Serial port changed → {port}")

    def _take_serial_reconnect(self) -> bool:
        with self._port_lock:
            if not self._force_serial_reconnect:
                return False
            self._force_serial_reconnect = False
            return True

    def _current_serial_port(self) -> str:
        with self._port_lock:
            return self._serial_port

    # ------------------------------------------------------------------
    # Serial transport
    # ------------------------------------------------------------------

    def _try_auto_repick_port(self, reason: str) -> None:
        """If SERIAL_PORT=auto, pick another board COM when current port is silent/failing."""
        if config.SERIAL_PORT != "auto":
            return
        try:
            from serial_utils import pick_default_port
        except ImportError:
            return

        current = self._current_serial_port()
        candidate = pick_default_port(exclude=current)
        if not candidate or candidate == current:
            candidate = pick_default_port()
        if candidate and candidate != current:
            print(f"[IoTReceiver] Auto-repick port ({reason}): {current} → {candidate}")
            self.set_serial_port(candidate)

    def _open_serial(self, serial_mod, port: str):
        """Open COM without hard-resetting the MCU via DTR when possible."""
        ser = serial_mod.Serial()
        ser.port = port
        ser.baudrate = config.SERIAL_BAUDRATE
        ser.timeout = config.SERIAL_TIMEOUT
        try:
            ser.dtr = False
            ser.rts = False
        except Exception:
            pass
        ser.open()
        try:
            ser.reset_input_buffer()
        except Exception:
            pass
        return ser

    def _serial_loop(self) -> None:
        try:
            import serial  # pyserial
        except ImportError:
            print("[IoTReceiver] ERROR: pyserial not installed. Run: pip install pyserial")
            self._status = ConnectionStatus.ERROR
            return

        ser = None
        no_packet_grace_s = max(8.0, config.IOT_WATCHDOG_TIMEOUT_S * 2)
        while self._running:
            if self._take_serial_reconnect() and ser is not None:
                try:
                    ser.close()
                except Exception:
                    pass
                ser = None
                self._status = ConnectionStatus.DISCONNECTED
                self._dbg_block = None

            # --- Establish / re-establish connection ---
            if ser is None or not ser.is_open:
                port = self._current_serial_port()
                try:
                    ser = self._open_serial(serial, port)
                    self._status = ConnectionStatus.CONNECTED
                    self._serial_opened_at = time.time()
                    self._open_fail_streak = 0
                    self._dbg_block = None
                    print(f"[IoTReceiver] Serial connected on {port}")
                except Exception as exc:
                    self._open_fail_streak += 1
                    print(f"[IoTReceiver] Serial open failed ({port}): {exc}. Retrying in 2 s…")
                    self._status = ConnectionStatus.ERROR
                    if self._open_fail_streak >= 3:
                        self._try_auto_repick_port("open_failed")
                        self._open_fail_streak = 0
                    time.sleep(2.0)
                    continue

            # Opened but never got a valid [DBG] block → wrong COM or firmware silent
            if (
                self._last_received_ts == 0
                and self._serial_opened_at > 0
                and time.time() - self._serial_opened_at > no_packet_grace_s
            ):
                print(
                    f"[IoTReceiver] No [DBG] telemetry on {self._current_serial_port()} "
                    f"for {no_packet_grace_s:.0f}s — reconnecting…"
                )
                try:
                    ser.close()
                except Exception:
                    pass
                ser = None
                self._status = ConnectionStatus.TIMEOUT
                self._try_auto_repick_port("no_telemetry")
                self._serial_opened_at = 0.0
                time.sleep(1.0)
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
                    self._status = ConnectionStatus.CONNECTED
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
        """Parse multi-line [DBG] block emitted by printRealtimeDebug()."""
        if line.startswith("[DBG]"):
            m = _DBG_HEADER_RE.search(line)
            if not m:
                if not getattr(self, "_warned_dbg_header", False):
                    print(f"[IoTReceiver] Unrecognized [DBG] header (check firmware): {line[:120]}")
                    self._warned_dbg_header = True
                return None
            self._warned_dbg_header = False
            (
                t_ms, state, cal,
                rep_count, rep_target,
                posture, speed,
                alert_level, alert_code,
                i2c_sda, i2c_scl,
            ) = m.groups()
            self._dbg_block = {
                "t_ms": t_ms,
                "state": state,
                "cal": cal,
                "rep_count": rep_count,
                "rep_target": rep_target,
                "posture": posture,
                "speed": speed,
                "alert_level": alert_level,
                "alert_code": alert_code,
                "i2c_sda": i2c_sda,
                "i2c_scl": i2c_scl,
                "channels": {},
            }
            return None

        if not self._dbg_block:
            return None

        angles_m = _DBG_ANGLES_RE.search(line)
        if angles_m:
            self._dbg_block["elbow_l"], self._dbg_block["elbow_r"], \
                self._dbg_block["knee_l"], self._dbg_block["knee_r"] = angles_m.groups()
            return None

        ch_m = _DBG_CH_RE.search(line)
        if ch_m:
            ch_idx, key, raw, cal, status = ch_m.groups()
            self._dbg_block["channels"][int(ch_idx)] = {
                "channel": int(ch_idx),
                "key": key,
                "raw": float(raw),
                "calibrated": float(cal),
                "status": status,
            }
            if len(self._dbg_block["channels"]) >= 8:
                return self._finalize_dbg_block()
            return None

        return None

    def _finalize_dbg_block(self) -> Optional[JointData]:
        block = self._dbg_block
        self._dbg_block = None
        if not block:
            return None

        channels = block.get("channels", {})
        sensor_list = [channels[i] for i in sorted(channels.keys())]

        calibrated = int(block.get("cal", 0)) == 1
        elbow_l = float(block.get("elbow_l", 0))
        elbow_r = float(block.get("elbow_r", 0))
        knee_l = float(block.get("knee_l", 0))
        knee_r = float(block.get("knee_r", 0))

        return JointData(
            elbow_left=elbow_l,
            elbow_right=elbow_r,
            knee_left=knee_l,
            knee_right=knee_r,
            shoulder_left=0.0,
            shoulder_right=0.0,
            source="iot",
            confidence=1.0 if calibrated else 0.5,
            timestamp_ms=float(block.get("t_ms", time.time() * 1000)),
            raw_sensors={
                "sensors": sensor_list,
                "angles": {
                    "elbow_left": elbow_l,
                    "elbow_right": elbow_r,
                    "knee_left": knee_l,
                    "knee_right": knee_r,
                },
            },
            sensor_channels=sensor_list,
            posture_state="correct" if block.get("posture") == "ok" else "incorrect",
            posture_fault_mask=0,
            rep_count=int(block.get("rep_count", 0)),
            rep_target=int(block.get("rep_target", 0)),
            speed_dps=float(block.get("speed", 0)),
            session_state=block.get("state", "idle"),
            alert_level=block.get("alert_level", "none"),
            alert_code=int(block.get("alert_code", 0)),
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

            sensor_channels = [
                {
                    "channel": idx,
                    "key": s.get("key", ""),
                    "raw": float(s.get("raw", 0)),
                    "calibrated": float(s.get("calibrated", 0)),
                }
                for idx, s in enumerate(sensors_raw)
            ]

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
                sensor_channels=sensor_channels or None,
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

    def _extract_sensor_channels(self, sensors_raw: list) -> Optional[list]:
        if not sensors_raw:
            return None
        return [
            {
                "channel": idx,
                "key": s.get("key", ""),
                "raw": float(s.get("raw", 0)),
                "calibrated": float(s.get("calibrated", 0)),
            }
            for idx, s in enumerate(sensors_raw)
            if isinstance(s, dict)
        ]

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
                sensors_raw = data.get("sensors", [])
                sensor_channels = self._extract_sensor_channels(sensors_raw)
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
                    sensor_channels=sensor_channels,
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
