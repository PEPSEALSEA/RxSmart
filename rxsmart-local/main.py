"""
main.py  —  RxSmart Local Pipeline entry point

Tkinter GUI (clickable) + camera dropdown + web bridge for browser.
"""
from __future__ import annotations

import sys

from runtime_check import ensure_standard_python

ensure_standard_python()

import config
from camera_pose_engine import CameraPoseEngine
from camera_utils import detect_cameras, pick_default_index
from data_models import SystemMode
from iot_receiver import IoTReceiver
from serial_utils import list_serial_ports, pick_default_port
from system_mode_manager import SystemModeManager
from tk_app import RxSmartTkApp
from visual_debugger import AdvancedVisualDebugger
from web_bridge import WebBridgeServer


def main() -> None:
    print("=" * 60)
    print("  RxSmart Local Pipeline")
    print(f"  IoT transport : {config.IOT_TRANSPORT}")
    print(f"  Fusion α      : {config.FUSION_ALPHA}")
    print(f"  Web bridge    : http://127.0.0.1:{config.WEB_BRIDGE_PORT}/api/state")
    print("=" * 60)

    print("[main] Detecting cameras…")
    cameras = detect_cameras()
    default_idx = pick_default_index(cameras, config.CAMERA_INDEX)
    if cameras:
        print(f"[main] Found {len(cameras)} camera(s), using index {default_idx}")
    else:
        print("[main] No camera detected — you can retry from the dropdown after connecting one")

    serial_ports = list_serial_ports()
    if config.SERIAL_PORT == "auto":
        default_port = pick_default_port()
    else:
        default_port = config.SERIAL_PORT
    print(f"[main] Serial port: {default_port} ({len(serial_ports)} port(s) detected)")

    camera = CameraPoseEngine(camera_index=default_idx)
    iot = IoTReceiver(transport=config.IOT_TRANSPORT, serial_port=default_port)
    manager = SystemModeManager(camera, iot, initial_mode=SystemMode.CAMERA_ONLY)
    debugger = AdvancedVisualDebugger(embed_mode=True)
    bridge = WebBridgeServer(manager)

    camera.start()
    iot.start()
    bridge.start()

    manager.stats.add_log("Pipeline started")
    manager.stats.add_log(f"Transport: {config.IOT_TRANSPORT.upper()}")
    manager.stats.add_log(f"Serial port: {default_port}")
    manager.stats.add_log(f"Camera index: {default_idx}")

    def shutdown() -> None:
        print("[main] Stopping threads…")
        camera.stop()
        iot.stop()
        bridge.stop()
        print("[main] Done.")

    app = RxSmartTkApp(
        manager=manager,
        camera=camera,
        debugger=debugger,
        iot=iot,
        cameras=cameras,
        serial_ports=serial_ports,
        default_serial_port=default_port,
        default_camera=default_idx,
        on_close=shutdown,
    )

    try:
        app.run()
    except KeyboardInterrupt:
        shutdown()
    finally:
        sys.exit(0)


if __name__ == "__main__":
    main()
