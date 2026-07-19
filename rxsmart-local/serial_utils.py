"""Serial port discovery — ESP32 / Pico auto-detect and COM port listing."""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

import config

BOARD_VID_PIDS = {
    (0x10C4, 0xEA60),  # CP210x (common on ESP32 DevKit)
    (0x1A86, 0x7523),  # CH340
    (0x303A, 0x1001),  # ESP32-S2/S3 native USB
    (0x2E8A, 0x0005),  # Raspberry Pi Pico USB CDC
    (0x2E8A, 0x000A),  # Pico / Pico W variants
    (0x2E8A, 0x000C),  # Pico 2 / RP2350 CDC
}

BOARD_KEYWORDS = (
    "cp210",
    "ch340",
    "silicon labs",
    "usb-serial",
    "esp32",
    "pico",
    "raspberry",
    "usb serial device",
    "usb serial",
)

# Avoid matching generic Bluetooth / modem COM ports via bare "uart"
WEAK_KEYWORDS = ("uart",)


def _com_number(port: str) -> int:
    m = re.search(r"(\d+)$", port, re.IGNORECASE)
    return int(m.group(1)) if m else -1


def _parse_vid_pid(hwid: str) -> Optional[Tuple[int, int]]:
    m = re.search(r"VID:PID=([0-9A-F]{4}):([0-9A-F]{4})", hwid, re.IGNORECASE)
    if not m:
        return None
    return int(m.group(1), 16), int(m.group(2), 16)


def _board_match_score(description: str, hwid: str) -> int:
    """Higher = more likely an RxSmart board. 0 = not a match."""
    vid_pid = _parse_vid_pid(hwid)
    if vid_pid and vid_pid[0] == 0x2E8A:
        return 100
    if vid_pid and vid_pid in BOARD_VID_PIDS:
        return 90

    text = f"{description} {hwid}".lower()
    if any(kw in text for kw in BOARD_KEYWORDS):
        return 50
    if any(kw in text for kw in WEAK_KEYWORDS):
        return 10
    return 0


def _is_board_port(description: str, hwid: str) -> bool:
    return _board_match_score(description, hwid) >= 50


def list_serial_ports() -> List[Tuple[str, str]]:
    """Return [(port, label), ...] e.g. ('COM5', 'COM5 — CP2102 USB to UART')."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return []

    found: List[Tuple[str, str]] = []
    for info in list_ports.comports():
        port = info.device
        desc = (info.description or "").strip()
        if desc and desc.lower() != port.lower():
            label = f"{port} — {desc}"
        else:
            label = port
        found.append((port, label))

    found.sort(key=lambda item: _com_number(item[0]))
    return found


def detect_board_port(exclude: Optional[str] = None) -> Optional[str]:
    """Return COM port that looks like ESP32 or Pico, preferring strongest match."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return None

    best_port: Optional[str] = None
    best_score = 0
    for info in list_ports.comports():
        port = info.device
        if exclude and port == exclude:
            continue
        score = _board_match_score(info.description or "", info.hwid or "")
        if score > best_score:
            best_score = score
            best_port = port
    return best_port if best_score >= 50 else None


def detect_esp32_port() -> Optional[str]:
    """Alias kept for callers; detects ESP32 or Pico board ports."""
    return detect_board_port()


def pick_default_port(exclude: Optional[str] = None) -> str:
    """
    Prefer ESP32/Pico board port only — never fall back to Bluetooth/random COM.
    """
    board = detect_board_port(exclude=exclude)
    if board:
        return board

    # Only board was excluded — keep it rather than jumping to COM3/Bluetooth.
    if exclude:
        return exclude

    board = detect_board_port()
    if board:
        return board

    fallback = config.SERIAL_PORT_FALLBACK
    return fallback if fallback != "auto" else "COM3"


def pick_alternate_board_port(current: str) -> Optional[str]:
    """Another scored board COM different from current, or None."""
    return detect_board_port(exclude=current)
