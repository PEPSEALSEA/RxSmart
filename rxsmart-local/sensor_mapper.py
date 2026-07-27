"""
Auto-detect which TCA channel (0–7) maps to which body segment,
plus fixed CH8 → center (MPU #9 on second mux).

Each wearer may plug limb sensors into different channels — this module learns the
mapping from motion samples and persists it per device (sensor_map.json).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import config

# ---------------------------------------------------------------------------
# Channel / segment keys — match dashboard PoseKey / MappingKey naming
# ---------------------------------------------------------------------------
SENSOR_COUNT = 9
LIMB_CHANNEL_COUNT = 8
CENTER_CHANNEL = 8
CENTER_KEY = "center"

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

# Firmware default: CH0–7 limbs on mux 0x70, CH8=center on mux 0x71
DEFAULT_CHANNEL_MAP: dict[int, str] = {
    0: "l_arm_upper",
    1: "r_arm_upper",
    2: "l_arm_lower",
    3: "r_arm_lower",
    4: "l_leg_upper",
    5: "r_leg_upper",
    6: "l_leg_lower",
    7: "r_leg_lower",
    8: CENTER_KEY,
}

CALIBRATION_STEPS: list[str] = [
    "neutral",
    "move_forearms",
    "move_shoulders",
    "move_shins",
    "move_thighs",
    "arms_down",
    "arms_up_down",
]

# Steps used only for channel→segment mapping (before personal defaults).
MAPPING_STEPS: list[str] = [
    "neutral",
    "move_forearms",
    "move_shoulders",
    "move_shins",
    "move_thighs",
]

POSE_DEFAULT_ANGLE_KEYS: list[str] = [
    "shoulder_left",
    "shoulder_right",
    "elbow_left",
    "elbow_right",
    "knee_left",
    "knee_right",
    "hip_left",
    "hip_right",
    "center",
]

POSE_PROFILE_NAMES: tuple[str, ...] = ("standing", "sitting")

RAW_TO_DEG = 180.0 / 4095.0


def ensure_center_in_map(channel_map: dict[int, str]) -> dict[int, str]:
    """Keep CH8 fixed as center; strip any misplaced center keys."""
    out = {int(k): str(v) for k, v in channel_map.items()}
    for ch, key in list(out.items()):
        if key == CENTER_KEY and ch != CENTER_CHANNEL:
            del out[ch]
    out[CENTER_CHANNEL] = CENTER_KEY
    return out


def pad_degrees(degrees: list[float]) -> list[float]:
    row = [float(d) for d in degrees[:SENSOR_COUNT]]
    while len(row) < SENSOR_COUNT:
        row.append(0.0)
    return row


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
    for i in range(LIMB_CHANNEL_COUNT):
        for j in range(i + 1, LIMB_CHANNEL_COUNT):
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

    return ensure_center_in_map(result)


def _mean_neutral(neutral_rows: list[list[float]]) -> list[float]:
    width = min(LIMB_CHANNEL_COUNT, min(len(row) for row in neutral_rows))
    return [
        sum(row[c] for row in neutral_rows) / len(neutral_rows)
        for c in range(width)
    ]


def _channel_peak_deltas(rows: list[list[float]], neutral: list[float]) -> list[float]:
    if not rows:
        return [0.0] * LIMB_CHANNEL_COUNT
    width = min(LIMB_CHANNEL_COUNT, len(neutral), min(len(row) for row in rows))
    return [max(row[c] for row in rows) - neutral[c] for c in range(width)]


def _top_movers(
    deltas: list[float],
    count: int,
    exclude: set[int] | None = None,
) -> list[int]:
    blocked = exclude or set()
    ranked = sorted(
        (c for c in range(min(LIMB_CHANNEL_COUNT, len(deltas))) if c not in blocked),
        key=lambda c: deltas[c],
        reverse=True,
    )
    return ranked[:count]


def _motion_correlation(
    samples: list[list[float]],
    ch_a: int,
    ch_b: int,
    neutral: list[float],
) -> float:
    if len(samples) < 2:
        return 0.0
    total = 0.0
    for row in samples:
        total += (row[ch_a] - neutral[ch_a]) * (row[ch_b] - neutral[ch_b])
    return total / len(samples)


def _pair_proximal_to_distal(
    proximal: list[int],
    distal: list[int],
    motion_rows: list[list[float]],
    neutral: list[float],
) -> list[tuple[int, int]]:
    """Match each proximal channel to its best-correlated distal channel."""
    if len(proximal) < 2 or len(distal) < 2:
        return []

    scores: list[tuple[float, int, int]] = []
    for p in proximal:
        for d in distal:
            scores.append((_motion_correlation(motion_rows, p, d, neutral), p, d))
    scores.sort(reverse=True)

    used_p: set[int] = set()
    used_d: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for score, p, d in scores:
        if p in used_p or d in used_d:
            continue
        pairs.append((p, d))
        used_p.add(p)
        used_d.add(d)
        if len(pairs) == 2:
            break

    if len(pairs) < 2:
        remaining_p = [p for p in proximal if p not in used_p]
        remaining_d = [d for d in distal if d not in used_d]
        while remaining_p and remaining_d and len(pairs) < 2:
            pairs.append((remaining_p.pop(0), remaining_d.pop(0)))
    return pairs


def _assign_left_right_pairs(
    pairs: list[tuple[int, int]],
    neutral: list[float],
) -> tuple[tuple[int, int], tuple[int, int]]:
    """Return (left_pair, right_pair) using neutral-angle heuristic."""
    if len(pairs) < 2:
        fallback = pairs[0] if pairs else (0, 1)
        return fallback, fallback

    def pair_neutral(pair: tuple[int, int]) -> float:
        return (neutral[pair[0]] + neutral[pair[1]]) / 2.0

    ordered = sorted(pairs, key=pair_neutral)
    return ordered[0], ordered[1]


def auto_detect_guided(step_samples: dict[str, list[list[float]]]) -> dict[int, str]:
    """
    Distal-first guided calibration (both sides together):
      neutral → move_forearms → move_shoulders → move_shins → move_thighs
    L/R is inferred from proximal↔distal correlation + neutral angles.
    """
    neutral_rows = step_samples.get("neutral", [])
    if not neutral_rows:
        return dict(DEFAULT_CHANNEL_MAP)

    neutral = _mean_neutral(neutral_rows)
    forearm_rows = step_samples.get("move_forearms", [])
    shoulder_rows = step_samples.get("move_shoulders", [])
    shin_rows = step_samples.get("move_shins", [])
    thigh_rows = step_samples.get("move_thighs", [])

    arm_distal = _top_movers(_channel_peak_deltas(forearm_rows, neutral), 2)
    arm_proximal = _top_movers(
        _channel_peak_deltas(shoulder_rows, neutral),
        2,
        exclude=set(arm_distal),
    )
    used_arms = set(arm_distal) | set(arm_proximal)
    leg_distal = _top_movers(
        _channel_peak_deltas(shin_rows, neutral),
        2,
        exclude=used_arms,
    )
    leg_proximal = _top_movers(
        _channel_peak_deltas(thigh_rows, neutral),
        2,
        exclude=used_arms | set(leg_distal),
    )

    result: dict[int, str] = {}

    arm_pairs = _pair_proximal_to_distal(
        arm_proximal, arm_distal, shoulder_rows or forearm_rows, neutral
    )
    if len(arm_pairs) == 2:
        left_arm, right_arm = _assign_left_right_pairs(arm_pairs, neutral)
        result[left_arm[0]] = "l_arm_upper"
        result[left_arm[1]] = "l_arm_lower"
        result[right_arm[0]] = "r_arm_upper"
        result[right_arm[1]] = "r_arm_lower"

    leg_pairs = _pair_proximal_to_distal(
        leg_proximal, leg_distal, thigh_rows or shin_rows, neutral
    )
    if len(leg_pairs) == 2:
        left_leg, right_leg = _assign_left_right_pairs(leg_pairs, neutral)
        result[left_leg[0]] = "l_leg_upper"
        result[left_leg[1]] = "l_leg_lower"
        result[right_leg[0]] = "r_leg_upper"
        result[right_leg[1]] = "r_leg_lower"

    if len(result) < LIMB_CHANNEL_COUNT:
        combined = neutral_rows[:]
        for rows in step_samples.values():
            combined.extend(rows)
        fallback = auto_detect_from_motion(combined)
        for ch in range(LIMB_CHANNEL_COUNT):
            if ch not in result:
                result[ch] = fallback.get(ch, DEFAULT_CHANNEL_MAP[ch])

        owned: dict[str, int] = {}
        duplicates: list[int] = []
        for ch, key in sorted(result.items()):
            if key == CENTER_KEY:
                continue
            if key in owned:
                duplicates.append(ch)
            else:
                owned[key] = ch
        missing_keys = [k for k in POSE_KEYS if k not in owned]
        for ch, key in zip(duplicates, missing_keys):
            result[ch] = key

    return ensure_center_in_map(result)


def mapping_confidence(
    samples: list[list[float]],
    channel_map: dict[int, str],
    firmware_angles: Optional[dict[str, float]] = None,
) -> float:
    """0–1 score: how well the mapping explains observed joint motion."""
    limb_map = {c: k for c, k in channel_map.items() if k in POSE_KEYS}
    if len(samples) < 5 or len(limb_map) < LIMB_CHANNEL_COUNT:
        return 0.0

    errors: list[float] = []
    for prox_key, dist_key in LIMB_PAIRS:
        prox_ch = next((c for c, k in limb_map.items() if k == prox_key), None)
        dist_ch = next((c for c, k in limb_map.items() if k == dist_key), None)
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
    pose_defaults: Optional[dict[str, dict[str, float]]] = None,
) -> dict[str, float]:
    """Compute elbow/knee + shoulder/hip elevation (+ center) from channel angles."""
    width = min(SENSOR_COUNT, len(degrees))
    by_pose = {channel_map[ch]: degrees[ch] for ch in range(width) if ch in channel_map}
    has_center = CENTER_KEY in by_pose or len(degrees) > CENTER_CHANNEL
    center_raw = float(
        by_pose.get(
            CENTER_KEY,
            float(degrees[CENTER_CHANNEL]) if len(degrees) > CENTER_CHANNEL else 0.0,
        )
    )

    def bend(prox: str, dist: str) -> float:
        return max(0.0, min(180.0, abs(by_pose.get(dist, 0.0) - by_pose.get(prox, 0.0))))

    def elev(pose_key: str) -> float:
        raw = float(by_pose.get(pose_key, 0.0))
        if has_center:
            return max(0.0, min(180.0, abs(raw - center_raw)))
        return max(0.0, min(180.0, raw))

    angles = {
        "elbow_left": bend("l_arm_upper", "l_arm_lower"),
        "elbow_right": bend("r_arm_upper", "r_arm_lower"),
        "knee_left": bend("l_leg_upper", "l_leg_lower"),
        "knee_right": bend("r_leg_upper", "r_leg_lower"),
        "shoulder_left": elev("l_arm_upper"),
        "shoulder_right": elev("r_arm_upper"),
        "hip_left": elev("l_leg_upper"),
        "hip_right": elev("r_leg_upper"),
        "center": center_raw,
    }
    return apply_pose_defaults(angles, pose_defaults)


ARM_REST_ELEV = 8.0
ARM_REST_PLANE = 18.0


def angles_to_pose_frame(angles: dict[str, float]) -> dict[str, dict[str, float]]:
    """
    Map IMU joint angles into the 8-key pose_frame used by exercise_engine.

    Single-pitch IMU has no plane — plane is filled with rest defaults and
    scoring should ignore it (score_plane=False). Elevation uses relative
    shoulder/hip (0 at hang) plus a small rest bias so targets like ARM_REST
    (~8°) line up with arms-down after wizard calibration.
    """

    def clamp(v: float, lo: float = 0.0, hi: float = 180.0) -> float:
        return max(lo, min(hi, float(v)))

    return {
        "l_arm_upper": {
            "elevation": clamp(float(angles.get("shoulder_left", 0.0)) + ARM_REST_ELEV),
            "plane": ARM_REST_PLANE,
        },
        "r_arm_upper": {
            "elevation": clamp(float(angles.get("shoulder_right", 0.0)) + ARM_REST_ELEV),
            "plane": ARM_REST_PLANE,
        },
        "l_leg_upper": {
            "elevation": clamp(abs(float(angles.get("hip_left", 0.0)))),
            "plane": 90.0 if abs(float(angles.get("hip_left", 0.0))) > 8.0 else 0.0,
        },
        "r_leg_upper": {
            "elevation": clamp(abs(float(angles.get("hip_right", 0.0)))),
            "plane": 90.0 if abs(float(angles.get("hip_right", 0.0))) > 8.0 else 0.0,
        },
        "l_arm_lower": {"bend": clamp(float(angles.get("elbow_left", 0.0)))},
        "r_arm_lower": {"bend": clamp(float(angles.get("elbow_right", 0.0)))},
        "l_leg_lower": {"bend": clamp(float(angles.get("knee_left", 0.0)), 0.0, 140.0)},
        "r_leg_lower": {"bend": clamp(float(angles.get("knee_right", 0.0)), 0.0, 140.0)},
    }


def apply_pose_defaults(
    angles: dict[str, float],
    pose_defaults: Optional[dict[str, dict[str, float]]],
) -> dict[str, float]:
    """Subtract personal baseline so the active default pose reads near 0°."""
    if not pose_defaults:
        return angles
    out = dict(angles)
    for key in POSE_DEFAULT_ANGLE_KEYS:
        d = pose_defaults.get(key)
        if not d:
            continue
        neutral = float(d.get("neutral", 0.0))
        # Deviation from hang/neutral — abs so either pitch direction (raise) counts.
        # One-sided (angle - neutral) fails when MPU pitch decreases on raise.
        out[key] = max(0.0, min(180.0, abs(float(angles.get(key, 0.0)) - neutral)))
    return out


def defaults_from_samples(
    samples: list[list[float]],
    channel_map: dict[int, str],
) -> dict[str, dict[str, float]]:
    """Average current pose into a neutral profile (min=max=neutral)."""
    if not samples:
        return {}
    totals = {k: 0.0 for k in POSE_DEFAULT_ANGLE_KEYS}
    n = 0
    for row in samples:
        ang = sensors_to_angles(row, channel_map, pose_defaults=None)
        for k in totals:
            totals[k] += float(ang.get(k, 0.0))
        n += 1
    if n == 0:
        return {}
    result: dict[str, dict[str, float]] = {}
    for k, total in totals.items():
        v = round(total / n, 2)
        result[k] = {"neutral": v, "min": v, "max": v}
    return result


def sample_channel_variance(samples: list[list[float]]) -> float:
    """Max per-channel variance (deg²) across recent IMU rows — stillness metric."""
    if len(samples) < 2:
        return 0.0
    width = min(SENSOR_COUNT, min(len(row) for row in samples))
    peak = 0.0
    for ch in range(width):
        vals = [float(row[ch]) for row in samples]
        mean = sum(vals) / len(vals)
        var = sum((v - mean) ** 2 for v in vals) / len(vals)
        if var > peak:
            peak = var
    return peak


def relative_deltas_from_frame(pose_frame: Optional[dict[str, dict[str, float]]]) -> dict[str, float]:
    """Per-joint Δ magnitudes from an IMU pose_frame (elevation / bend)."""
    if not pose_frame:
        return {}
    out: dict[str, float] = {}
    for key in POSE_KEYS:
        joint = pose_frame.get(key) or {}
        if "elevation" in joint:
            out[key] = round(abs(float(joint.get("elevation", 0.0))), 2)
        elif "bend" in joint:
            out[key] = round(abs(float(joint.get("bend", 0.0))), 2)
    return out


def compute_pose_defaults(
    step_samples: dict[str, list[list[float]]],
    channel_map: dict[int, str],
) -> dict[str, dict[str, float]]:
    """
    Personal arm defaults after channel mapping:
      arms_down  → neutral baseline
      arms_up_down → min/max ROM while raising/lowering
    """
    down_rows = step_samples.get("arms_down", []) or step_samples.get("neutral", [])
    move_rows = step_samples.get("arms_up_down", [])

    result: dict[str, dict[str, float]] = {}
    if not down_rows and not move_rows:
        return result

    def _mean_angles(rows: list[list[float]]) -> dict[str, float]:
        if not rows:
            return {}
        totals = {k: 0.0 for k in POSE_DEFAULT_ANGLE_KEYS}
        # also need knees for completeness but defaults focus on arms
        totals.update(
            {
                "knee_left": 0.0,
                "knee_right": 0.0,
            }
        )
        n = 0
        for row in rows:
            ang = sensors_to_angles(row, channel_map, pose_defaults=None)
            for k in totals:
                totals[k] += float(ang.get(k, 0.0))
            n += 1
        if n == 0:
            return {}
        return {k: v / n for k, v in totals.items()}

    neutral = _mean_angles(down_rows)

    mins: dict[str, float] = {}
    maxs: dict[str, float] = {}
    for row in move_rows or down_rows:
        ang = sensors_to_angles(row, channel_map, pose_defaults=None)
        for key in POSE_DEFAULT_ANGLE_KEYS:
            v = float(ang.get(key, 0.0))
            mins[key] = v if key not in mins else min(mins[key], v)
            maxs[key] = v if key not in maxs else max(maxs[key], v)

    for key in POSE_DEFAULT_ANGLE_KEYS:
        n_val = float(neutral.get(key, mins.get(key, 0.0)))
        mn = float(mins.get(key, n_val))
        mx = float(maxs.get(key, n_val))
        # Ensure max is at least neutral (raised should go above hang)
        if mx < n_val:
            mx = n_val
        if mn > n_val:
            mn = n_val
        result[key] = {
            "neutral": round(n_val, 2),
            "min": round(mn, 2),
            "max": round(mx, 2),
        }
    return result


@dataclass
class SensorMappingManager:
    """Thread-safe-ish mapping store with motion buffer for auto-recheck."""

    map_path: Path = field(default_factory=lambda: Path(config.SENSOR_MAP_FILE))
    channel_map: dict[int, str] = field(default_factory=lambda: dict(DEFAULT_CHANNEL_MAP))
    pose_defaults: dict[str, dict[str, float]] = field(default_factory=dict)
    pose_profiles: dict[str, dict[str, dict[str, float]]] = field(default_factory=dict)
    active_pose: str = ""
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
            self.channel_map = ensure_center_in_map({int(k): v for k, v in raw_map.items()})
            raw_defaults = data.get("pose_defaults", {})
            if isinstance(raw_defaults, dict):
                self.pose_defaults = {
                    str(k): {sk: float(sv) for sk, sv in v.items()}
                    for k, v in raw_defaults.items()
                    if isinstance(v, dict)
                }
            raw_profiles = data.get("pose_profiles", {})
            self.pose_profiles = {}
            if isinstance(raw_profiles, dict):
                for name, profile in raw_profiles.items():
                    if not isinstance(profile, dict):
                        continue
                    self.pose_profiles[str(name)] = {
                        str(k): {sk: float(sv) for sk, sv in v.items()}
                        for k, v in profile.items()
                        if isinstance(v, dict)
                    }
            self.active_pose = str(data.get("active_pose", "") or "")
            if self.active_pose and self.active_pose in self.pose_profiles:
                self.pose_defaults = dict(self.pose_profiles[self.active_pose])
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
            "pose_defaults": self.pose_defaults,
            "pose_profiles": self.pose_profiles,
            "active_pose": self.active_pose,
            "calibrated_at": self.calibrated_at,
            "confidence": self.confidence,
        }
        self.map_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def reset_to_default(self) -> None:
        self.channel_map = dict(DEFAULT_CHANNEL_MAP)
        self.pose_defaults = {}
        self.pose_profiles = {}
        self.active_pose = ""
        self.confidence = 0.0
        self.calibrated_at = 0.0
        self.save()

    def set_map(self, channel_map: dict[int, str], confidence: float = 1.0) -> None:
        self.channel_map = ensure_center_in_map({int(k): v for k, v in channel_map.items()})
        self.confidence = confidence
        self.calibrated_at = time.time()
        self.save()

    def set_pose_defaults(self, pose_defaults: dict[str, dict[str, float]]) -> None:
        self.pose_defaults = pose_defaults
        if pose_defaults:
            # Guided arm calib becomes the standing profile by default.
            name = self.active_pose or "standing"
            self.pose_profiles[name] = dict(pose_defaults)
            self.active_pose = name
        self.calibrated_at = time.time()
        self.save()

    def capture_pose_profile(self, pose_name: str) -> dict[str, Any]:
        """Snapshot recent IMU samples as named default (standing / sitting)."""
        name = str(pose_name).strip().lower()
        if name not in POSE_PROFILE_NAMES:
            return {"ok": False, "error": f"pose must be one of {POSE_PROFILE_NAMES}"}
        min_n = int(getattr(config, "POSE_CAPTURE_MIN_SAMPLES", 8))
        max_var = float(getattr(config, "POSE_CAPTURE_MAX_VARIANCE_DEG", 4.0))
        samples = self._motion_buffer[-max(20, min_n) :]
        if len(samples) < min_n:
            return {
                "ok": False,
                "error": "need_more_samples",
                "message": f"รอสัญญาณ IMU อย่างน้อย {min_n} เฟรม แล้วยืน/นั่งนิ่งก่อนกดอีกครั้ง",
                "samples": len(samples),
            }
        variance = sample_channel_variance(samples[-min_n:])
        if variance > (max_var * max_var):
            return {
                "ok": False,
                "error": "not_still",
                "message": "ยังขยับอยู่ — ยืน/นั่งนิ่งให้บอร์ดทุกช่องนิ่ง แล้วกดบันทึกอีกครั้ง",
                "variance": round(variance, 3),
                "max_variance": round(max_var * max_var, 3),
            }
        limb_keys = {v for v in self.channel_map.values() if v in POSE_KEYS}
        if len(limb_keys) < LIMB_CHANNEL_COUNT:
            return {
                "ok": False,
                "error": "need_channel_map",
                "message": "ทำ Setup Wizard แมปบอร์ดให้ครบ 8 ช่องแขนขา + center ก่อนบันทึกท่า",
            }
        profile = defaults_from_samples(samples[-min_n:], self.channel_map)
        if not profile or len(profile) < len(POSE_DEFAULT_ANGLE_KEYS):
            return {
                "ok": False,
                "error": "capture_failed",
                "message": "บันทึกท่าไม่สำเร็จ — ตรวจสัญญาณ IMU แล้วลองใหม่",
            }
        self.pose_profiles[name] = profile
        self.pose_defaults = dict(profile)
        self.active_pose = name
        self.calibrated_at = time.time()
        self.save()
        return {
            "ok": True,
            "active_pose": self.active_pose,
            "pose_defaults": self.pose_defaults,
            "pose_profiles": self.pose_profiles,
            "message": f"บันทึกท่า {name} แล้ว — Δ จะวัดจาก neutral นี้",
            "variance": round(variance, 3),
        }

    def activate_pose_profile(self, pose_name: str) -> dict[str, Any]:
        name = str(pose_name).strip().lower()
        profile = self.pose_profiles.get(name)
        if not profile:
            return {"ok": False, "error": "pose_not_set", "message": f"ยังไม่ได้บันทึกท่า {name}"}
        self.pose_defaults = dict(profile)
        self.active_pose = name
        self.calibrated_at = time.time()
        self.save()
        return {
            "ok": True,
            "active_pose": self.active_pose,
            "pose_defaults": self.pose_defaults,
            "pose_profiles": self.pose_profiles,
        }

    def ingest_channels(self, degrees: list[float]) -> None:
        if len(degrees) < LIMB_CHANNEL_COUNT:
            return
        row = pad_degrees(degrees)
        self._motion_buffer.append(row)
        if len(self._motion_buffer) > self._buffer_max:
            self._motion_buffer = self._motion_buffer[-self._buffer_max :]

        step = self.calibration_step
        if step in CALIBRATION_STEPS:
            self._guided_buffer.setdefault(step, []).append(list(row))
            if len(self._guided_buffer[step]) > 60:
                self._guided_buffer[step] = self._guided_buffer[step][-60:]

    def start_guided_calibration(self) -> None:
        self.calibration_step = "neutral"
        self._guided_buffer = {step: [] for step in CALIBRATION_STEPS}

    def _commit_channel_map_from_guided(self) -> None:
        mapping_buf = {k: self._guided_buffer.get(k, []) for k in MAPPING_STEPS}
        new_map = auto_detect_guided(mapping_buf)
        conf = mapping_confidence(self._flatten_guided(MAPPING_STEPS), new_map)
        self.set_map(new_map, conf)

    def advance_calibration_step(self) -> str:
        if self.calibration_step == "idle":
            self.start_guided_calibration()
            return self.calibration_step

        idx = CALIBRATION_STEPS.index(self.calibration_step)
        if idx + 1 < len(CALIBRATION_STEPS):
            nxt = CALIBRATION_STEPS[idx + 1]
            # After body-segment mapping steps, lock channel map before pose defaults.
            if self.calibration_step == "move_thighs" and nxt == "arms_down":
                self._commit_channel_map_from_guided()
            self.calibration_step = nxt
            return self.calibration_step

        # Final step (arms_up_down) → personal defaults, then done
        limb_keys = {v for v in self.channel_map.values() if v in POSE_KEYS}
        if len(limb_keys) < LIMB_CHANNEL_COUNT:
            self._commit_channel_map_from_guided()
        defaults = compute_pose_defaults(self._guided_buffer, self.channel_map)
        self.set_pose_defaults(defaults)
        conf = mapping_confidence(
            self._flatten_guided(MAPPING_STEPS),
            self.channel_map,
        )
        self.confidence = conf
        self.calibrated_at = time.time()
        self.save()
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
        degrees: Optional[list[float]] = None
        if self._motion_buffer and len(self._motion_buffer[-1]) >= LIMB_CHANNEL_COUNT:
            degrees = [round(float(d), 2) for d in pad_degrees(self._motion_buffer[-1])]
        return {
            "channel_map": {str(k): v for k, v in sorted(self.channel_map.items())},
            "default_map": {str(k): v for k, v in sorted(DEFAULT_CHANNEL_MAP.items())},
            "pose_defaults": self.pose_defaults,
            "pose_profiles": self.pose_profiles,
            "active_pose": self.active_pose,
            "confidence": round(self.confidence, 3),
            "calibrated_at": self.calibrated_at,
            "calibration_step": self.calibration_step,
            "calibration_steps": CALIBRATION_STEPS,
            "buffer_samples": len(self._motion_buffer),
            "channel_degrees": degrees,
            "sensor_count": SENSOR_COUNT,
        }

    def _flatten_guided(self, steps: Optional[list[str]] = None) -> list[list[float]]:
        rows: list[list[float]] = []
        for step in steps or CALIBRATION_STEPS:
            rows.extend(self._guided_buffer.get(step, []))
        return rows
