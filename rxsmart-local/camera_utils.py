"""Detect available webcam indices (OpenCV) with human-readable names."""
from __future__ import annotations

import sys
from typing import List, Optional, Tuple

import cv2


def _backend() -> int:
    if sys.platform == "win32":
        return cv2.CAP_DSHOW
    return cv2.CAP_ANY


def _dshow_camera_names() -> List[str]:
    """DirectShow device names on Windows (index-aligned with CAP_DSHOW)."""
    if sys.platform != "win32":
        return []
    try:
        from pygrabber.dshow_graph import FilterGraph

        return list(FilterGraph().get_input_devices())
    except Exception:
        return []


def _camera_label(index: int, dshow_names: List[str]) -> str:
    if index < len(dshow_names) and dshow_names[index].strip():
        return f"{dshow_names[index]} ({index})"
    if index == 0:
        return f"Camera 0 (default)"
    return f"Camera {index}"


def detect_cameras(max_probe: int = 8) -> List[Tuple[int, str]]:
    """Return [(index, label), ...] for cameras that open and return a frame."""
    found: List[Tuple[int, str]] = []
    backend = _backend()
    dshow_names = _dshow_camera_names()

    for index in range(max_probe):
        cap = cv2.VideoCapture(index, backend)
        if not cap.isOpened():
            cap.release()
            continue
        ok, _ = cap.read()
        cap.release()
        if ok:
            found.append((index, _camera_label(index, dshow_names)))

    return found


def pick_default_index(
    cameras: List[Tuple[int, str]],
    preferred: int = -1,
) -> int:
    """Use preferred index if available; -1 means no camera."""
    if preferred < 0:
        return -1
    indices = [idx for idx, _ in cameras]
    if preferred in indices:
        return preferred
    if len(indices) == 1:
        return indices[0]
    if indices:
        return indices[0]
    return -1
