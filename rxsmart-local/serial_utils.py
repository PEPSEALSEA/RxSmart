"""Serial port discovery — ESP32 auto-detect and COM port listing."""
from __future__ import annotations

import re
from typing import List, Optional, Tuple

import config

ESP32_VID_PIDS = {
    (0x10C4, 0xEA60),  # CP210x (common on ESP32 DevKit)
    (0x1A86, 0x7523),  # CH340
    (0x303A, 0x1001),  # ESP32-S2/S3 native USB
}

ESP32_KEYWORDS = (
    "cp210",
    "ch340",
    "silicon labs",
    "usb-serial",
    "esp32",
    "uart",
    "usb serial",
)


def _com_number(port: str) -> int:
    m = re.search(r"(\d+)$", port, re.IGNORECASE)
    return int(m.group(1)) if m else -1


def _parse_vid_pid(hwid: str) -> Optional[Tuple[int, int]]:
    m = re.search(r"VID:PID=([0-9A-F]{4}):([0-9A-F]{4})", hwid, re.IGNORECASE)
    if not m:
        return None
    return int(m.group(1), 16), int(m.group(2), 16)


def _is_esp32_port(description: str, hwid: str) -> bool:
    vid_pid = _parse_vid_pid(hwid)
    if vid_pid and vid_pid in ESP32_VID_PIDS:
        return True
    text = f"{description} {hwid}".lower()
    return any(kw in text for kw in ESP32_KEYWORDS)


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


def detect_esp32_port() -> Optional[str]:
    """Return COM port that looks like an ESP32 DevKit, or None."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return None

    for info in list_ports.comports():
        if _is_esp32_port(info.description or "", info.hwid or ""):
            return info.device
    return None


def pick_default_port() -> str:
    """
    Prefer ESP32 DevKit port; else highest COM number; else config fallback.
    """
    esp32 = detect_esp32_port()
    if esp32:
        return esp32

    ports = list_serial_ports()
    if ports:
        return max(ports, key=lambda item: _com_number(item[0]))[0]

    fallback = config.SERIAL_PORT_FALLBACK
    return fallback if fallback != "auto" else "COM3"
