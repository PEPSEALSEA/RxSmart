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
SERIAL_PORT: str = "COM3"
SERIAL_BAUDRATE: int = 115200
SERIAL_TIMEOUT: float = 2.0
IOT_WATCHDOG_TIMEOUT_S: float = 3.0

# HTTP poll settings (used when IOT_TRANSPORT = "http")
API_BASE_URL: str = "https://rxsmart-worker.sealseapep.workers.dev"
HTTP_POLL_INTERVAL_S: float = 1.0
DEVICE_ID: str = ""

# Local Server settings (used when IOT_TRANSPORT = "server")
LOCAL_SERVER_HOST: str = "0.0.0.0"
LOCAL_SERVER_PORT: int = 8765

# Web bridge — GitHub Pages / browser calls Python on this PC
WEB_BRIDGE_HOST: str = "0.0.0.0"
WEB_BRIDGE_PORT: int = 8766

# ---------------------------------------------------------------------------
# Sensor Fusion (Complementary Filter)
# ---------------------------------------------------------------------------
FUSION_ALPHA: float = 0.6
FUSION_CONFIDENCE_THRESHOLD: float = 0.7

# ---------------------------------------------------------------------------
# Display / OpenCV Window
# ---------------------------------------------------------------------------
DEBUG_PANEL_WIDTH: int = 400
WINDOW_NAME: str = "RxSmart — Camera & Fusion"
MAX_LOG_LINES: int = 16
UI_FADE_FRAMES: int = 18          # frames for panel/mode fade (~300ms @ 60fps)

# ---------------------------------------------------------------------------
# Colors  (BGR — minimal palette aligned with dashboard)
# ---------------------------------------------------------------------------
COLOR_BG = (250, 250, 250)           # #fafafa panel
COLOR_SURFACE = (255, 255, 255)      # white cards
COLOR_TEXT = (23, 23, 23)             # #171717
COLOR_MUTED = (115, 115, 115)        # #737373
COLOR_BORDER = (229, 229, 229)       # #e5e5e5
COLOR_ACCENT = (10, 10, 10)          # #0a0a0a

COLOR_CAMERA = (180, 120, 40)        # warm accent — camera source
COLOR_IOT = (60, 160, 60)            # green — IMU source
COLOR_FUSED = (200, 180, 50)         # teal-gold — fusion

COLOR_OK = (60, 160, 60)
COLOR_WARN = (40, 140, 220)
COLOR_ERROR = (60, 60, 220)

COLOR_PANEL_BG = COLOR_BG
COLOR_DIVIDER = COLOR_BORDER

# Camera overlay (on video feed)
COLOR_HUD_BG = (30, 30, 30)          # semi-transparent bar base
COLOR_SKELETON = (200, 200, 200)
COLOR_SKELETON_ACTIVE = (255, 220, 120)
COLOR_ANGLE_LABEL = (240, 240, 240)
