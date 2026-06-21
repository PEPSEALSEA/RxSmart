"""
main.py  —  RxSmart Local Pipeline entry point

Wires CameraPoseEngine + IoTReceiver + SystemModeManager + AdvancedVisualDebugger
into a single event loop and handles keyboard input.

Run:
    python main.py

Keyboard controls:
    1  →  Camera Only mode
    2  →  IoT Only mode
    3  →  Fusion mode
    d  →  Toggle debug panel
    q / ESC  →  Quit
"""
from __future__ import annotations

import sys

import cv2

import config
from camera_pose_engine import CameraPoseEngine
from data_models import SystemMode
from iot_receiver import IoTReceiver
from system_mode_manager import SystemModeManager
from visual_debugger import AdvancedVisualDebugger

_KEY_MODE_MAP = {
    ord("1"): SystemMode.CAMERA_ONLY,
    ord("2"): SystemMode.IOT_ONLY,
    ord("3"): SystemMode.FUSION,
}


def main() -> None:
    print("=" * 60)
    print("  RxSmart Local Pipeline")
    print(f"  IoT transport : {config.IOT_TRANSPORT}")
    if config.IOT_TRANSPORT == "serial":
        print(f"  Serial port   : {config.SERIAL_PORT}  @ {config.SERIAL_BAUDRATE} baud")
    else:
        print(f"  API base URL  : {config.API_BASE_URL}")
    print(f"  Camera index  : {config.CAMERA_INDEX}")
    print(f"  Fusion α      : {config.FUSION_ALPHA}")
    print("=" * 60)

    # --- Instantiate modules ---
    camera = CameraPoseEngine(camera_index=config.CAMERA_INDEX)
    iot = IoTReceiver(transport=config.IOT_TRANSPORT)
    manager = SystemModeManager(camera, iot, initial_mode=SystemMode.CAMERA_ONLY)
    debugger = AdvancedVisualDebugger()

    # --- Start background threads ---
    camera.start()
    iot.start()

    manager.stats.add_log("Pipeline started")
    manager.stats.add_log(f"Transport: {config.IOT_TRANSPORT.upper()}")
    manager.stats.add_log("Press 1/2/3 to switch mode")

    # --- OpenCV window ---
    cv2.namedWindow(config.WINDOW_NAME, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(
        config.WINDOW_NAME,
        config.CAMERA_WIDTH + config.DEBUG_PANEL_WIDTH,
        config.CAMERA_HEIGHT,
    )

    print("[main] Running. Press 'q' or ESC in the OpenCV window to quit.")

    try:
        while True:
            joint_data, cam_frame = manager.get_frame_and_data()
            stats = manager.stats

            display = debugger.render(cam_frame, joint_data, stats)
            cv2.imshow(config.WINDOW_NAME, display)

            key = cv2.waitKey(1) & 0xFF

            # Quit
            if key in (ord("q"), 27):  # 27 = ESC
                break

            # Mode switch
            if key in _KEY_MODE_MAP:
                manager.set_mode(_KEY_MODE_MAP[key])

            # Toggle debug panel
            elif key == ord("d"):
                debugger.toggle_panel()
                manager.stats.add_log("Debug panel toggled")

            # Window closed via OS (X button)
            if cv2.getWindowProperty(config.WINDOW_NAME, cv2.WND_PROP_VISIBLE) < 1:
                break

    except KeyboardInterrupt:
        print("\n[main] KeyboardInterrupt — shutting down.")
    finally:
        print("[main] Stopping threads…")
        camera.stop()
        iot.stop()
        cv2.destroyAllWindows()
        print("[main] Done.")
        sys.exit(0)


if __name__ == "__main__":
    main()
