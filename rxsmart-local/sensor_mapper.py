"""
Auto-detect which TCA channel (0–7) maps to which body segment.

Each wearer may plug sensors into different channels — this module learns the
mapping from motion samples and persists it per device.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import config

# ---------------------------------------------------------------------------
# Segment keys — match dashboard PoseKey naming
# ---------------------------------------------------------------------------
POSE_KEYS: list[str] = [
    "l_arm_upper",
    "l_arm_lower",
    "r_arm_upper",
    "r_arm_lower",
    "l_leg_upper",
    "l_leg_lower",
    "r_leg_upper",
    "r_leg_lower",
]

LIMB_PAIRS: list[tuple[str, str]] = [
    ("l_arm_upper", "l_arm_lower"),
    ("r_arm_upper", "r_arm_lower"),
    ("l_leg_upper", "l_leg_lower"),
    ("r_leg_upper", "r_leg_lower"),
]

# Firmware default: CH0=left_upper_arm … CH7=right_shin
DEFAULT_CHANNEL_MAP: dict[int, str] = {
    0: "l_arm_upper",
    1: "r_arm_upper",
    2: "l_arm_lower",
    3: "r_arm_lower",
    4: "l_leg_upper",
    5: "r_leg_upper",
    6: "l_leg_lower",
    7: "r_leg_lower",
}

CALIBRATION_STEPS: list[str] = [
    "neutral",
    "raise_left_arm",
    "raise_right_arm",
    "raise_left_leg",
    "raise_right_leg",
]

STEP_TO_PROXIMAL: dict[str, str] = {
    "raise_left_arm": "l_arm_upper",
    "raise_right_arm": "r_arm_upper",
    "raise_left_leg": "l_leg_upper",
    "raise_right_leg": "r_leg_upper",
}

STEP_TO_DISTAL: dict[str, str] = {
    "raise_left_arm": "l_arm_lower",
    "raise_right_arm": "r_arm_lower",
    "raise_left_leg": "l_leg_lower",
    "raise_right_leg": "r_leg_lower",
}

RAW_TO_DEG = 180.0 / 4095.0


def calibrated_to_degrees(calibrated: float) -> float:
    return max(0.0, min(180.0, abs(calibrated) * RAW_TO_DEG))


def _pair_bend_variance(samples: list[list[float]], i: int, j: int) -> float:
    if len(samples) < 3:
        return 0.0
    diffs = [abs(row[i] - row[j]) for row in samples]
    mean = sum(diffs) / len(diffs)
    return sum((d - mean) ** 2 for d in diffs) / len(diffs)


def _greedy_pair_channels(samples: list[list[float]]) -> list[tuple[int, int, float]]:
    scores: list[tuple[tuple[int, int], float]] = []
    for i in range(8):
        for j in range(i + 1, 8):
            scores.append(((i, j), _pair_bend_variance(samples, i, j)))
    scores.sort(key=lambda item: item[1], reverse=True)

    used: set[int] = set()
    selected: list[tuple[int, int, float]] = []
    for (i, j), var in scores:
        if i in used or j in used:
            continue
        selected.append((i, j, var))
        used.add(i)
        used.add(j)
        if len(selected) == 4:
            break
    return selected


def _assign_proximal_distal(
    samples: list[list[float]],
    ch_a: int,
    ch_b: int,
) -> tuple[int, int]:
    """Return (proximal_channel, distal_channel)."""
    if not samples:
        return ch_a, ch_b

    neutral = samples[0]
    spread_a = max(row[ch_a] for row in samples) - min(row[ch_a] for row in samples)
    spread_b = max(row[ch_b] for row in samples) - min(row[ch_b] for row in samples)

    # Whole-limb motion affects the proximal segment more.
    if spread_a >= spread_b:
        return ch_a, ch_b
    return ch_b, ch_a


def _cluster_pairs_to_limbs(
    pairs: list[tuple[int, int, float]],
    neutral: list[float],
) -> dict[str, tuple[int, int]]:
    """Assign 4 unordered pairs to arm/leg left/right using neutral pose hints."""
    pair_neutral = [
        (i, j, (neutral[i] + neutral[j]) / 2.0)
        for i, j, _ in pairs
    ]
    pair_neutral.sort(key=lambda item: item[2])

    # Lower neutral angles → legs; higher → arms (standing rest pose).
    leg_pairs = [(i, j) for i, j, _ in pair_neutral[:2]]
    arm_pairs = [(i, j) for i, j, _ in pair_neutral[2:]]

    left_arm = min(arm_pairs, key=lambda p: (neutral[p[0]] + neutral[p[1]]) / 2)
    right_arm = max(arm_pairs, key=lambda p: (neutral[p[0]] + neutral[p[1]]) / 2)
    left_leg = min(leg_pairs, key=lambda p: (neutral[p[0]] + neutral[p[1]]) / 2)
    right_leg = max(leg_pairs, key=lambda p: (neutral[p[0]] + neutral[p[1]]) / 2)

    return {
        "l_arm": left_arm,
        "r_arm": right_arm,
        "l_leg": left_leg,
        "r_leg": right_leg,
    }


def auto_detect_from_motion(samples: list[list[float]]) -> dict[int, str]:
    """
    Passive auto-detect from ≥10 frames of 8-channel degree readings.
    Returns channel → pose_key mapping.
    """
    if len(samples) < 10:
        return dict(DEFAULT_CHANNEL_MAP)

    pairs = _greedy_pair_channels(samples)
    if len(pairs) < 4:
        return dict(DEFAULT_CHANNEL_MAP)

    neutral = samples[0]
    limbs = _cluster_pairs_to_limbs(pairs, neutral)

    result: dict[int, str] = {}
    for limb_key, prox_key, dist_key in [
        ("l_arm", "l_arm_upper", "l_arm_lower"),
        ("r_arm", "r_arm_upper", "r_arm_lower"),
        ("l_leg", "l_leg_upper", "l_leg_lower"),
        ("r_leg", "r_leg_upper", "r_leg_lower"),
    ]:
        ch_a, ch_b = limbs[limb_key]
        prox_ch, dist_ch = _assign_proximal_distal(samples, ch_a, ch_b)
        result[prox_ch] = prox_key
        result[dist_ch] = dist_key

    return result


def auto_detect_guided(step_samples: dict[str, list[list[float]]]) -> dict[int, str]:
    """
    Guided calibration: user performs neutral + 4 raise-one-limb steps.
    step_samples keys: neutral, raise_left_arm, raise_right_arm, …
    """
    neutral_rows = step_samples.get("neutral", [])
    if not neutral_rows:
        return dict(DEFAULT_CHANNEL_MAP)

    neutral = [
        sum(row[c] for row in neutral_rows) / len(neutral_rows)
        for c in range(8)
    ]

    result: dict[int, str] = {}

    for step, prox_key in STEP_TO_PROXIMAL.items():
        dist_key = STEP_TO_DISTAL[step]
        rows = step_samples.get(step, [])
        if not rows:
            continue

        deltas = [
            max(row[c] for row in rows) - neutral[c]
            for c in range(8)
        ]
        ranked = sorted(range(8), key=lambda c: deltas[c], reverse=True)
        top = [c for c in ranked if c not in result][:2]
        if len(top) < 2:
            continue

        prox_ch, dist_ch = _assign_proximal_distal(rows, top[0], top[1])
        result[prox_ch] = prox_key
        result[dist_ch] = dist_key

    if len(result) < 8:
        # Fill missing channels from passive detect on all samples combined
        combined = neutral_rows[:]
        for rows in step_samples.values():
            combined.extend(rows)
        fallback = auto_detect_from_motion(combined)
        for ch in range(8):
            if ch not in result:
                result[ch] = fallback.get(ch, DEFAULT_CHANNEL_MAP[ch])
    return result


def mapping_confidence(
    samples: list[list[float]],
    channel_map: dict[int, str],
    firmware_angles: Optional[dict[str, float]] = None,
) -> float:
    """0–1 score: how well the mapping explains observed joint motion."""
    if len(samples) < 5 or len(channel_map) < 8:
        return 0.0

    errors: list[float] = []
    for prox_key, dist_key in LIMB_PAIRS:
        prox_ch = next((c for c, k in channel_map.items() if k == prox_key), None)
        dist_ch = next((c for c, k in channel_map.items() if k == dist_key), None)
        if prox_ch is None or dist_ch is None:
            continue

        bends = [abs(row[dist_ch] - row[prox_ch]) for row in samples]
        bend_var = sum(bends) / len(bends)
        errors.append(1.0 if bend_var > 2.0 else bend_var / 2.0)

    if firmware_angles:
        computed = sensors_to_angles(samples[-1], channel_map)
        for key in ("elbow_left", "elbow_right", "knee_left", "knee_right"):
            fw = firmware_angles.get(key)
            comp = computed.get(key)
            if fw is not None and comp is not None:
                err = abs(fw - comp)
                errors.append(max(0.0, 1.0 - err / 45.0))

    if not errors:
        return 0.0
    return max(0.0, min(1.0, sum(errors) / len(errors)))


def sensors_to_angles(
    degrees: list[float],
    channel_map: dict[int, str],
) -> dict[str, float]:
    """Compute elbow/knee + shoulder elevation from 8 segment angles."""
    by_pose = {channel_map[ch]: degrees[ch] for ch in range(8) if ch in channel_map}

    def bend(prox: str, dist: str) -> float:
        return max(0.0, min(180.0, abs(by_pose.get(dist, 0.0) - by_pose.get(prox, 0.0))))

    return {
        "elbow_left": bend("l_arm_upper", "l_arm_lower"),
        "elbow_right": bend("r_arm_upper", "r_arm_lower"),
        "knee_left": bend("l_leg_upper", "l_leg_lower"),
        "knee_right": bend("r_leg_upper", "r_leg_lower"),
        "shoulder_left": by_pose.get("l_arm_upper", 0.0),
        "shoulder_right": by_pose.get("r_arm_upper", 0.0),
    }


@dataclass
class SensorMappingManager:
    """Thread-safe-ish mapping store with motion buffer for auto-recheck."""

    map_path: Path = field(default_factory=lambda: Path(config.SENSOR_MAP_FILE))
    channel_map: dict[int, str] = field(default_factory=lambda: dict(DEFAULT_CHANNEL_MAP))
    device_id: str = ""
    calibrated_at: float = 0.0
    confidence: float = 0.0
    calibration_step: str = "idle"
    _motion_buffer: list[list[float]] = field(default_factory=list, repr=False)
    _guided_buffer: dict[str, list[list[float]]] = field(default_factory=dict, repr=False)
    _buffer_max: int = 120

    def load(self) -> None:
        if not self.map_path.exists():
            return
        try:
            data = json.loads(self.map_path.read_text(encoding="utf-8"))
            raw_map = data.get("channel_map", {})
            self.channel_map = {int(k): v for k, v in raw_map.items()}
            self.device_id = data.get("device_id", "")
            self.calibrated_at = float(data.get("calibrated_at", 0))
            self.confidence = float(data.get("confidence", 0))
        except Exception as exc:
            print(f"[SensorMapper] load failed: {exc}")

    def save(self) -> None:
        self.map_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "device_id": self.device_id,
            "channel_map": {str(k): v for k, v in sorted(self.channel_map.items())},
            "calibrated_at": self.calibrated_at,
            "confidence": self.confidence,
        }
        self.map_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def reset_to_default(self) -> None:
        self.channel_map = dict(DEFAULT_CHANNEL_MAP)
        self.confidence = 0.0
        self.calibrated_at = 0.0
        self.save()

    def set_map(self, channel_map: dict[int, str], confidence: float = 1.0) -> None:
        self.channel_map = {int(k): v for k, v in channel_map.items()}
        self.confidence = confidence
        self.calibrated_at = time.time()
        self.save()

    def ingest_channels(self, degrees: list[float]) -> None:
        if len(degrees) != 8:
            return
        self._motion_buffer.append(list(degrees))
        if len(self._motion_buffer) > self._buffer_max:
            self._motion_buffer = self._motion_buffer[-self._buffer_max :]

        step = self.calibration_step
        if step in CALIBRATION_STEPS:
            self._guided_buffer.setdefault(step, []).append(list(degrees))
            if len(self._guided_buffer[step]) > 60:
                self._guided_buffer[step] = self._guided_buffer[step][-60:]

    def start_guided_calibration(self) -> None:
        self.calibration_step = "neutral"
        self._guided_buffer = {step: [] for step in CALIBRATION_STEPS}

    def advance_calibration_step(self) -> str:
        if self.calibration_step == "idle":
            self.start_guided_calibration()
            return self.calibration_step

        idx = CALIBRATION_STEPS.index(self.calibration_step)
        if idx + 1 < len(CALIBRATION_STEPS):
            self.calibration_step = CALIBRATION_STEPS[idx + 1]
            return self.calibration_step

        # Final step complete → compute mapping
        new_map = auto_detect_guided(self._guided_buffer)
        conf = mapping_confidence(
            self._flatten_guided(),
            new_map,
        )
        self.set_map(new_map, conf)
        self.calibration_step = "idle"
        self._guided_buffer = {}
        return "complete"

    def run_auto_recheck(
        self,
        firmware_angles: Optional[dict[str, float]] = None,
    ) -> dict[str, Any]:
        """Passive re-check from recent motion; updates map if confidence improves."""
        if len(self._motion_buffer) < 15:
            return {
                "updated": False,
                "reason": "need_more_motion",
                "confidence": self.confidence,
                "channel_map": self.channel_map,
            }

        candidate = auto_detect_from_motion(self._motion_buffer)
        cand_conf = mapping_confidence(
            self._motion_buffer,
            candidate,
            firmware_angles,
        )

        if cand_conf > self.confidence + 0.08:
            self.set_map(candidate, cand_conf)
            return {
                "updated": True,
                "confidence": cand_conf,
                "channel_map": self.channel_map,
            }

        return {
            "updated": False,
            "confidence": self.confidence,
            "candidate_confidence": cand_conf,
            "channel_map": self.channel_map,
        }

    def to_api_dict(self) -> dict[str, Any]:
        return {
            "channel_map": {str(k): v for k, v in sorted(self.channel_map.items())},
            "default_map": {str(k): v for k, v in sorted(DEFAULT_CHANNEL_MAP.items())},
            "confidence": round(self.confidence, 3),
            "calibrated_at": self.calibrated_at,
            "calibration_step": self.calibration_step,
            "calibration_steps": CALIBRATION_STEPS,
            "buffer_samples": len(self._motion_buffer),
        }

    def _flatten_guided(self) -> list[list[float]]:
        rows: list[list[float]] = []
        for step in CALIBRATION_STEPS:
            rows.extend(self._guided_buffer.get(step, []))
        return rows
