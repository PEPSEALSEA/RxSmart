# =============================================================================
# config.py  —  RxSmart Local Pipeline configuration
# Edit this file to match your hardware setup before running main.py
# =============================================================================

# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------
CAMERA_INDEX: int = 0           # 0 = default webcam; try 1, 2 … if multiple cameras
CAMERA_WIDTH: int = 1280        # requested resolution (camera may fall back to lower)
CAMERA_HEIGHT: int = 720
CAMERA_TARGET_FPS: int = 30

# ---------------------------------------------------------------------------
# MediaPipe Pose
# ---------------------------------------------------------------------------
MEDIAPIPE_MODEL_COMPLEXITY: int = 1     # 0=lite (fast), 1=full, 2=heavy (accurate)
MEDIAPIPE_MIN_DETECTION_CONFIDENCE: float = 0.5
MEDIAPIPE_MIN_TRACKING_CONFIDENCE: float = 0.5

# ---------------------------------------------------------------------------
# IoT  —  choose transport:
#   "serial"  — USB cable, lowest latency (~500 ms cycle)
#   "http"    — polls Cloudflare Worker over internet (~1-3 s, needs WiFi only)
#   "server"  — Python listens as local HTTP server; ESP32 POSTs directly
#               over LAN (~50 ms, no cable, requires both on same WiFi)
# ---------------------------------------------------------------------------
IOT_TRANSPORT: str = "server"   # "serial" | "http" | "server"

# Serial (USB) settings
# Windows: "COM3", "COM4", …  — check Device Manager
# Linux  : "/dev/ttyUSB0" or "/dev/ttyACM0"
# macOS  : "/dev/cu.usbserial-XXXX"
SERIAL_PORT: str = "COM3"
SERIAL_BAUDRATE: int = 115200
SERIAL_TIMEOUT: float = 2.0     # seconds per readline() call
IOT_WATCHDOG_TIMEOUT_S: float = 3.0    # declare TIMEOUT if no packet for this long

# HTTP poll settings (used when IOT_TRANSPORT = "http")
API_BASE_URL: str = "https://rxsmart-worker.sealseapep.workers.dev"
HTTP_POLL_INTERVAL_S: float = 1.0
DEVICE_ID: str = ""             # leave empty to auto-detect from first packet

# ---------------------------------------------------------------------------
# Local Server settings (used when IOT_TRANSPORT = "server")
# Python listens for POST /telemetry from the ESP32 on the same WiFi network.
#
# Step 1: Find your computer's local IP (cmd → ipconfig, look for IPv4 under WiFi)
# Step 2: Flash the firmware snippet in firmware_local_server_snippet.ino
#         and set LOCAL_SERVER_URL = "http://<your_ip>:LOCAL_SERVER_PORT"
# ---------------------------------------------------------------------------
LOCAL_SERVER_HOST: str = "0.0.0.0"     # listen on all interfaces
LOCAL_SERVER_PORT: int = 8765           # ESP32 will POST to http://<pc_ip>:8765/telemetry

# ---------------------------------------------------------------------------
# Sensor Fusion (Complementary Filter)
# ---------------------------------------------------------------------------
FUSION_ALPHA: float = 0.6               # camera weight; (1-α) = IMU weight
FUSION_CONFIDENCE_THRESHOLD: float = 0.7  # below this, camera α is reduced proportionally

# ---------------------------------------------------------------------------
# Display / OpenCV Window
# ---------------------------------------------------------------------------
DEBUG_PANEL_WIDTH: int = 430    # width of the right-hand debug info panel (pixels)
WINDOW_NAME: str = "RxSmart Local Pipeline"
MAX_LOG_LINES: int = 20

# ---------------------------------------------------------------------------
# Colors  (BGR format used by OpenCV)
# ---------------------------------------------------------------------------
COLOR_CAMERA = (255, 140, 60)    # warm blue — camera-sourced values
COLOR_IOT = (60, 200, 60)        # green     — IoT-sourced values
COLOR_FUSED = (60, 220, 220)     # cyan      — fused values
COLOR_TEXT = (210, 210, 210)     # light grey — general text
COLOR_OK = (80, 200, 80)         # green
COLOR_WARN = (50, 170, 255)      # orange
COLOR_ERROR = (60, 60, 220)      # red
COLOR_PANEL_BG = (18, 18, 28)    # near-black panel background
COLOR_DIVIDER = (55, 55, 75)     # subtle separator lines
