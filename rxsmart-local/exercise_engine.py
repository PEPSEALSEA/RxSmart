"""
Exercise session engine — judges whether the camera-measured pose is correct
and computes the score. Ported from dashboard/src/lib/pose-physics.ts
(RehabSessionEngine + buildSessionFeedback), but with one deliberate fix:

  Old (browser) behaviour: score = passCount/activeCount * 100 — a per-joint
  BINARY pass/fail against a tolerance. With one active joint this can only
  ever read 0 or 100, and jittery landmarks flip it every frame. That is the
  "score วิ่งแค่ 0 กับ 100" bug.

  New (this file) behaviour: each joint gets a CONTINUOUS grade based on how
  close it is to the target (100 at zero error, decaying to 0 by ~2x
  tolerance), and the aggregate score is smoothed across ticks. The camera
  angles themselves are already smoothed upstream (pose_model.PoseFrameSmoother),
  so together this produces a stable, real percentage instead of a flicker.

Live IMU (score_plane=False) adds relative-board leadership and accel gates:
  the wizard-mapped active boards must lead other boards in delta (or speed
  during raise/lower), with speed not too fast/slow and no accel spikes.

Runs entirely on this machine — the browser only renders the JSON this
produces (see web_bridge.py), it does not compute pose correctness itself.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import config
from biomechanics import LOWER_JOINT_LIMITS, UPPER_JOINT_LIMITS
from pose_model import (
    LOWER_KEYS,
    NEUTRAL_POSE,
    POSE_KEYS,
    UPPER_KEYS,
    resolve_pose,
    shortest_plane_delta,
)
from rehab_exercises import ExercisePhase, REHAB_EXERCISES, RehabExercise, get_exercise_by_id


def _clone_exercise(ex: RehabExercise) -> RehabExercise:
    return RehabExercise(
        id=ex.id,
        name=ex.name,
        description=ex.description,
        category=ex.category,
        support=ex.support,
        start_pose={k: dict(v) for k, v in ex.start_pose.items()},
        phases=[
            ExercisePhase(
                id=p.id,
                label=p.label,
                targets={k: dict(v) for k, v in p.targets.items()},
                hold_seconds=p.hold_seconds,
                move_speed=p.move_speed,
                active_joints=list(p.active_joints),
            )
            for p in ex.phases
        ],
        reps=ex.reps,
        rest_between_reps=ex.rest_between_reps,
    )


def _merge_joint_dict(base: Dict[str, float], patch: Dict[str, Any]) -> Dict[str, float]:
    out = dict(base)
    for key, val in patch.items():
        if isinstance(val, (int, float)):
            out[str(key)] = float(val)
    return out


def apply_exercise_overrides(ex: RehabExercise, overrides: Optional[Dict[str, Any]]) -> RehabExercise:
    """Apply captured start_pose + per-phase targets onto a cloned exercise."""
    cloned = _clone_exercise(ex)
    if not overrides or not isinstance(overrides, dict):
        return cloned

    start = overrides.get("start_pose") or overrides.get("startPose")
    if isinstance(start, dict):
        for key, val in start.items():
            if key not in cloned.start_pose or not isinstance(val, dict):
                continue
            cloned.start_pose[key] = _merge_joint_dict(cloned.start_pose[key], val)

    phases = overrides.get("phases") or {}
    if isinstance(phases, dict):
        for phase in cloned.phases:
            captured = phases.get(phase.id)
            if not isinstance(captured, dict):
                continue
            for key, val in captured.items():
                if not isinstance(val, dict):
                    continue
                base = phase.targets.get(key) or dict(cloned.start_pose.get(key, {}))
                phase.targets[key] = _merge_joint_dict(base, val)

    return cloned


def _joint_score(error: float, tolerance: float) -> float:
    """Continuous grade: 100 at zero error, 0 by ~2x tolerance."""
    if tolerance <= 0:
        return 100.0 if error <= 0.01 else 0.0
    grade = 1.0 - (error / (tolerance * 2.0))
    return max(0.0, min(100.0, grade * 100.0))


def _joint_delta(frame: dict, key: str) -> float:
    f = frame.get(key) or {}
    if key in UPPER_KEYS:
        return abs(float(f.get("elevation", 0.0)))
    return abs(float(f.get("bend", 0.0)))


def _joint_speed(velocities: dict, key: str, score_plane: bool) -> float:
    v = velocities.get(key) or {}
    if key in UPPER_KEYS:
        if not score_plane:
            return abs(float(v.get("elevation", 0.0)))
        return math.hypot(float(v.get("elevation", 0.0)), float(v.get("plane", 0.0)))
    return abs(float(v.get("bend", 0.0)))


def _target_scalar(targets: dict, key: str) -> float:
    t = targets.get(key) or {}
    if key in UPPER_KEYS:
        return abs(float(t.get("elevation", 0.0)))
    return abs(float(t.get("bend", 0.0)))


def _velocities(prev_frame: Optional[dict], frame: dict, dt: float) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for key in POSE_KEYS:
        f = frame[key]
        p = (prev_frame or {}).get(key, f)
        if dt <= 0:
            out[key] = {k: 0.0 for k in f}
            continue
        if key in UPPER_KEYS:
            v_elev = (f["elevation"] - p.get("elevation", f["elevation"])) / dt
            v_plane = shortest_plane_delta(p.get("plane", f["plane"]), f["plane"]) / dt
            out[key] = {"elevation": v_elev, "plane": v_plane}
        else:
            v_bend = (f["bend"] - p.get("bend", f["bend"])) / dt
            out[key] = {"bend": v_bend}
    return out


def _accelerations(
    prev_velocities: Optional[Dict[str, dict]],
    velocities: Dict[str, dict],
    dt: float,
    score_plane: bool,
) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for key in POSE_KEYS:
        speed = _joint_speed(velocities, key, score_plane)
        prev_speed = _joint_speed(prev_velocities or {}, key, score_plane) if prev_velocities else speed
        if dt <= 0:
            out[key] = 0.0
        else:
            out[key] = abs(speed - prev_speed) / dt
    return out


def _imu_phase_is_high(targets: dict, active_joints: List[str]) -> bool:
    if not active_joints:
        return False
    peak = max(_target_scalar(targets, k) for k in active_joints)
    return peak >= float(config.IMU_HIGH_TARGET_DEG)


def _imu_leadership(
    frame: dict,
    velocities: dict,
    targets: dict,
    active_joints: List[str],
    score_plane: bool,
) -> Tuple[bool, Optional[str], str]:
    """Active wizard-mapped boards must lead the others in delta or speed."""
    if not active_joints or score_plane:
        return True, None, ""

    active = list(active_joints)
    inactive = [k for k in POSE_KEYS if k not in active]
    high = _imu_phase_is_high(targets, active)
    margin = float(config.IMU_LEADER_MARGIN_DEG)
    min_move = float(config.IMU_MIN_MOVE_DEG)

    if high:
        active_deltas = {k: _joint_delta(frame, k) for k in active}
        inactive_peak = max((_joint_delta(frame, k) for k in inactive), default=0.0)
        leader = max(active_deltas, key=active_deltas.get)
        active_peak = active_deltas[leader]
        if active_peak < min_move:
            return False, leader, "wrong_board"
        if active_peak + 1e-6 < inactive_peak + margin:
            wrong = max(inactive, key=lambda k: _joint_delta(frame, k)) if inactive else None
            return False, wrong or leader, "wrong_board"
        return True, leader, ""

    # Raise/lower toward rest — leading board is the one moving fastest.
    active_speeds = {k: _joint_speed(velocities, k, score_plane) for k in active}
    inactive_peak = max((_joint_speed(velocities, k, score_plane) for k in inactive), default=0.0)
    leader = max(active_speeds, key=active_speeds.get)
    active_peak = active_speeds[leader]
    if inactive_peak > 6.0 and active_peak + 1e-6 < inactive_peak + margin * 0.5:
        wrong = max(inactive, key=lambda k: _joint_speed(velocities, k, score_plane)) if inactive else None
        return False, wrong or leader, "wrong_board"
    return True, leader, ""


def _evaluate_upper(
    key: str,
    frame: dict,
    targets: dict,
    velocities: dict,
    accelerations: Dict[str, float],
    active: bool,
    phase: ExercisePhase,
    score_plane: bool = True,
) -> dict:
    lim = UPPER_JOINT_LIMITS[key]
    f = frame[key]
    t = targets[key]
    v = velocities.get(key, {"elevation": 0.0, "plane": 0.0})

    elevation_error = abs(f["elevation"] - t["elevation"])
    plane_error = abs(shortest_plane_delta(f["plane"], t["plane"]))
    elev_ok = elevation_error <= lim["elevation"]["tolerance"]
    plane_ok = (not score_plane) or plane_error <= lim["plane"]["tolerance"]
    angle_ok = (not active) or (elev_ok and plane_ok)

    speed = abs(v["elevation"]) if not score_plane else math.hypot(v["elevation"], v["plane"])
    is_holding = phase.hold_seconds > 0
    velocity_ok = True
    accel = float(accelerations.get(key, 0.0))
    accel_ok = True

    if active and not score_plane:
        if is_holding:
            velocity_ok = speed < float(config.IMU_HOLD_MAX_SPEED_DPS)
        elif speed > 0.5:
            lo = lim["elevation"]["idealVelocityMin"] * float(config.IMU_MOVE_MIN_SPEED_SCALE)
            hi = phase.move_speed * float(config.IMU_MOVE_MAX_SPEED_SCALE)
            velocity_ok = lo <= speed <= hi
        accel_ok = accel <= float(config.IMU_MAX_ACCEL_DPS2)
    elif active and not is_holding and speed > 0.5:
        velocity_ok = speed <= phase.move_speed * 1.4 and speed >= lim["elevation"]["idealVelocityMin"] * 0.3
    elif active and is_holding:
        velocity_ok = speed < 14

    score_e = _joint_score(elevation_error, lim["elevation"]["tolerance"])
    score_p = _joint_score(plane_error, lim["plane"]["tolerance"]) if score_plane else score_e

    return {
        "elevation": round(f["elevation"], 2),
        "plane": round(f["plane"], 2),
        "targetElevation": t["elevation"],
        "targetPlane": t["plane"],
        "vElevation": round(v["elevation"], 2),
        "vPlane": round(v["plane"], 2),
        "elevationError": round(elevation_error, 2),
        "planeError": round(plane_error, 2),
        "delta": round(_joint_delta(frame, key), 2),
        "accel": round(accel, 2),
        "angleOk": angle_ok,
        "velocityOk": velocity_ok,
        "accelOk": accel_ok if active else True,
        "isActive": active,
        "_score": (score_e + score_p) / 2.0,
    }


def _evaluate_lower(
    key: str,
    frame: dict,
    targets: dict,
    velocities: dict,
    accelerations: Dict[str, float],
    active: bool,
    phase: ExercisePhase,
    score_plane: bool = True,
) -> dict:
    lim = LOWER_JOINT_LIMITS[key]["bend"]
    f = frame[key]
    t = targets[key]
    v = velocities.get(key, {"bend": 0.0})

    bend_error = abs(f["bend"] - t["bend"])
    angle_ok = (not active) or (bend_error <= lim["tolerance"])

    speed = abs(v["bend"])
    is_holding = phase.hold_seconds > 0
    velocity_ok = True
    accel = float(accelerations.get(key, 0.0))
    accel_ok = True

    if active and not score_plane:
        if is_holding:
            velocity_ok = speed < float(config.IMU_HOLD_MAX_SPEED_DPS)
        elif speed > 0.5:
            lo = lim["idealVelocityMin"] * float(config.IMU_MOVE_MIN_SPEED_SCALE)
            hi = phase.move_speed * float(config.IMU_MOVE_MAX_SPEED_SCALE)
            velocity_ok = lo <= speed <= hi
        accel_ok = accel <= float(config.IMU_MAX_ACCEL_DPS2)
    elif active and not is_holding and speed > 0.5:
        velocity_ok = speed <= phase.move_speed * 1.35 and speed >= lim["idealVelocityMin"] * 0.35
    elif active and is_holding:
        velocity_ok = speed < 12

    score = _joint_score(bend_error, lim["tolerance"])

    return {
        "bend": round(f["bend"], 2),
        "targetBend": t["bend"],
        "vBend": round(v["bend"], 2),
        "bendError": round(bend_error, 2),
        "delta": round(_joint_delta(frame, key), 2),
        "accel": round(accel, 2),
        "angleOk": angle_ok,
        "velocityOk": velocity_ok,
        "accelOk": accel_ok if active else True,
        "isActive": active,
        "_score": score,
    }


def _evaluate_joint(
    key: str,
    frame: dict,
    targets: dict,
    velocities: dict,
    accelerations: Dict[str, float],
    active: bool,
    phase: ExercisePhase,
    score_plane: bool = True,
) -> dict:
    if key in UPPER_KEYS:
        return _evaluate_upper(
            key, frame, targets, velocities, accelerations, active, phase, score_plane=score_plane,
        )
    return _evaluate_lower(
        key, frame, targets, velocities, accelerations, active, phase, score_plane=score_plane,
    )


def _is_at_target(
    frame: dict,
    targets: dict,
    velocities: dict,
    accelerations: Dict[str, float],
    active_joints: List[str],
    phase: ExercisePhase,
    score_plane: bool = True,
    maintain_hold: bool = False,
) -> Tuple[bool, Optional[str], str]:
    for key in active_joints:
        fb = _evaluate_joint(
            key, frame, targets, velocities, accelerations, True, phase, score_plane=score_plane,
        )
        if not fb["angleOk"]:
            return False, key, "delta_height"
        if maintain_hold:
            continue
        if not score_plane and not fb["accelOk"]:
            return False, key, "accel"
        if not score_plane and not fb["velocityOk"]:
            return False, key, "speed"

    if maintain_hold:
        return True, (active_joints[0] if active_joints else None), ""

    if not score_plane:
        ok, leader, reason = _imu_leadership(
            frame, velocities, targets, active_joints, score_plane,
        )
        if not ok:
            return False, leader, reason or "wrong_board"
        return True, leader, ""

    return True, (active_joints[0] if active_joints else None), ""


@dataclass
class SessionFeedback:
    score: int
    messages: List[str]
    phase_label: str
    rep: int
    total_reps: int
    status: str
    active_joints: List[str]
    joint_feedback: Dict[str, dict]
    delta_by_joint: Dict[str, float] = field(default_factory=dict)
    leader_joint: Optional[str] = None
    imu_diagnostics: Optional[dict] = None
    hold_progress: float = 0.0

    def to_dict(self) -> dict:
        out = {
            "score": self.score,
            "messages": self.messages,
            "phaseLabel": self.phase_label,
            "rep": self.rep,
            "totalReps": self.total_reps,
            "status": self.status,
            "activeJoints": self.active_joints,
            "jointFeedback": self.joint_feedback,
            "deltaByJoint": self.delta_by_joint,
            "leaderJoint": self.leader_joint,
            "holdProgress": round(self.hold_progress, 4),
        }
        if self.imu_diagnostics is not None:
            out["imuDiagnostics"] = self.imu_diagnostics
        return out


def build_session_feedback(
    frame: dict,
    targets: dict,
    velocities: dict,
    accelerations: Dict[str, float],
    phase: ExercisePhase,
    rep: int,
    total_reps: int,
    status: str,
    score_plane: bool = True,
    leader_joint: Optional[str] = None,
    fail_reason: str = "",
    hold_progress: float = 0.0,
) -> SessionFeedback:
    joint_feedback: Dict[str, dict] = {}
    active_scores: List[float] = []
    delta_by_joint: Dict[str, float] = {}

    for key in POSE_KEYS:
        active = key in phase.active_joints
        fb = _evaluate_joint(
            key, frame, targets, velocities, accelerations, active, phase, score_plane=score_plane,
        )
        delta_by_joint[key] = float(fb.get("delta", 0.0))
        if active:
            active_scores.append(fb.pop("_score"))
        else:
            fb.pop("_score", None)
        joint_feedback[key] = fb

    raw_score = 100.0 if not active_scores else sum(active_scores) / len(active_scores)

    leadership_ok = True
    accel_ok = True
    if not score_plane and phase.active_joints:
        leadership_ok, leader_guess, lead_reason = _imu_leadership(
            frame, velocities, targets, phase.active_joints, score_plane,
        )
        if leader_joint is None:
            leader_joint = leader_guess
        if fail_reason == "wrong_board" or not leadership_ok:
            leadership_ok = False
            fail_reason = fail_reason or lead_reason or "wrong_board"
        accel_ok = all(
            joint_feedback[k].get("accelOk", True) for k in phase.active_joints
        )

    messages: List[str] = []
    if not score_plane and fail_reason == "wrong_board" and status == "moving":
        messages.append("กระดานผิดข้าง — ขยับข้อที่แมปไว้ใน Setup Wizard")
    elif not score_plane and fail_reason == "speed" and status == "moving":
        messages.append("ความเร็วไม่เหมาะ — ช้า/เร็วเกินไป")
    elif not score_plane and fail_reason == "accel" and status == "moving":
        messages.append("กระตุกแรงเกินไป — เคลื่อนไหวให้ต่อเนื่อง")
    elif not score_plane and fail_reason == "delta_height" and status == "moving":
        messages.append("มุม Δ ยังไม่ถึงเป้า — ยก/งอตามบอร์ดที่แมปไว้")
    elif status == "holding":
        messages.append(
            "ค้างท่า — รักษามุมยกให้คงที่"
            if not score_plane
            else "ค้างท่า — รักษามุม elevation + plane ให้คงที่"
        )
    elif status == "moving":
        has_upper_active = any(k in UPPER_KEYS for k in phase.active_joints)
        if has_upper_active and score_plane:
            messages.append("หมุนข้อต่อรอบทิศ — ควบคุมทั้งยกขึ้นและทิศทาง (plane)")
        elif has_upper_active:
            messages.append("ยก/ลดตามเป้า — คะแนนจาก Δ ของบอร์ดที่แมปไว้")
        else:
            messages.append("ความเร็วและมุมเหมาะสม — ทำต่อได้เลย")
    elif status == "rest":
        messages.append("พักระหว่าง rep")
    elif status == "complete":
        messages.append("เสร็จโปรแกรมแล้ว!")
    else:
        messages.append(
            "กดเริ่มเพื่อฝึก — คะแนนจาก Δ ของ IMU ตาม Setup Wizard"
            if not score_plane
            else "กดเริ่มเพื่อฝึก — คำนวณจากกล้องบนเครื่องนี้ (Python)"
        )

    imu_diagnostics = None
    if not score_plane:
        imu_diagnostics = {
            "leadershipOk": leadership_ok,
            "accelOk": accel_ok,
            "reason": fail_reason or None,
            "leaderJoint": leader_joint,
        }

    return SessionFeedback(
        score=round(raw_score),
        messages=messages[:3],
        phase_label=phase.label,
        rep=rep,
        total_reps=total_reps,
        status=status,
        active_joints=list(phase.active_joints),
        joint_feedback=joint_feedback,
        delta_by_joint=delta_by_joint,
        leader_joint=leader_joint,
        imu_diagnostics=imu_diagnostics,
        hold_progress=max(0.0, min(1.0, float(hold_progress))),
    )


class ExerciseSessionManager:
    """Owns the current exercise + rep/phase/hold state machine, ticked once
    per web_bridge /api/state request using the latest smoothed camera pose."""

    def __init__(self, exercise: Optional[RehabExercise] = None) -> None:
        self._exercise: RehabExercise = exercise or REHAB_EXERCISES[0]
        self._phase_index = 0
        self._rep = 1
        self._hold_elapsed = 0.0
        self._hold_break_elapsed = 0.0
        self._rest_remaining = 0.0
        self._status = "idle"
        self._running = False
        self._targets: Dict[str, dict] = {k: dict(v) for k, v in self._exercise.start_pose.items()}
        self._last_tick_ts: Optional[float] = None
        self._prev_frame: Optional[dict] = None
        self._prev_velocities: Optional[Dict[str, dict]] = None
        self._smoothed_score: Optional[float] = None
        self._last_fail_reason: str = ""
        self._last_leader: Optional[str] = None

    @property
    def exercise(self) -> RehabExercise:
        return self._exercise

    def select_exercise(self, exercise_id: str, overrides: Optional[Dict[str, Any]] = None) -> bool:
        ex = get_exercise_by_id(exercise_id)
        if ex is None:
            return False
        self._exercise = apply_exercise_overrides(ex, overrides)
        self.reset()
        return True

    def apply_overrides(self, overrides: Optional[Dict[str, Any]]) -> bool:
        """Re-apply pose overrides onto the current catalog exercise id."""
        return self.select_exercise(self._exercise.id, overrides)

    def start(self) -> None:
        self._running = True
        self._status = "moving"
        self._phase_index = 0
        self._rep = 1
        self._hold_elapsed = 0.0
        self._hold_break_elapsed = 0.0
        self._rest_remaining = 0.0
        self._targets = resolve_pose(self._exercise.start_pose, self._current_phase().targets)
        self._smoothed_score = None
        self._last_fail_reason = ""
        self._last_leader = None
        self._prev_velocities = None

    def stop(self) -> None:
        self._running = False
        self._status = "idle"
        self._targets = {k: dict(v) for k, v in self._exercise.start_pose.items()}

    def reset(self) -> None:
        self.stop()
        self._phase_index = 0
        self._rep = 1
        self._hold_elapsed = 0.0
        self._hold_break_elapsed = 0.0
        self._rest_remaining = 0.0
        self._smoothed_score = None
        self._last_tick_ts = None
        self._prev_frame = None
        self._prev_velocities = None
        self._last_fail_reason = ""
        self._last_leader = None

    def handle_action(self, action: str) -> bool:
        if action == "start":
            self.start()
        elif action == "stop":
            self.stop()
        elif action == "reset":
            self.reset()
        else:
            return False
        return True

    def _current_phase(self) -> ExercisePhase:
        return self._exercise.phases[self._phase_index]

    def _hold_progress(self, phase: ExercisePhase) -> float:
        if phase.hold_seconds <= 0:
            return 0.0
        return max(0.0, min(1.0, self._hold_elapsed / phase.hold_seconds))

    def _advance_phase(self) -> None:
        self._hold_elapsed = 0.0
        self._hold_break_elapsed = 0.0
        self._last_fail_reason = ""
        last = len(self._exercise.phases) - 1
        if self._phase_index < last:
            self._phase_index += 1
            self._status = "moving"
            self._targets = resolve_pose(self._exercise.start_pose, self._current_phase().targets)
            return

        if self._rep < self._exercise.reps:
            self._rep += 1
            self._phase_index = 0
            self._status = "rest"
            self._rest_remaining = self._exercise.rest_between_reps
            self._targets = {k: dict(v) for k, v in self._exercise.start_pose.items()}
            return

        self._running = False
        self._status = "complete"

    def tick(self, frame: Optional[dict], score_plane: bool = True) -> SessionFeedback:
        now = time.perf_counter()
        dt = 0.0 if self._last_tick_ts is None else max(0.0, now - self._last_tick_ts)
        dt = min(dt, 1.0)  # guard against huge gaps (bridge disconnects, etc.)
        self._last_tick_ts = now

        frame = frame or NEUTRAL_POSE
        velocities = _velocities(self._prev_frame, frame, dt)
        accelerations = _accelerations(self._prev_velocities, velocities, dt, score_plane)
        self._prev_frame = {k: dict(v) for k, v in frame.items()}
        self._prev_velocities = {k: dict(v) for k, v in velocities.items()}

        phase = self._current_phase()

        if not self._running:
            fb = build_session_feedback(
                frame, self._targets, velocities, accelerations,
                phase, self._rep, self._exercise.reps, "idle",
                score_plane=score_plane,
            )
            return self._smooth(fb)

        if self._rest_remaining > 0:
            self._rest_remaining = max(0.0, self._rest_remaining - dt)
            self._status = "rest"
            self._targets = {k: dict(v) for k, v in self._exercise.start_pose.items()}
            if self._rest_remaining == 0:
                self._status = "moving"
                self._targets = resolve_pose(self._exercise.start_pose, phase.targets)
            fb = build_session_feedback(
                frame, self._targets, velocities, accelerations,
                phase, self._rep, self._exercise.reps, self._status,
                score_plane=score_plane,
            )
            return self._smooth(fb)

        self._targets = resolve_pose(self._exercise.start_pose, phase.targets)
        maintaining = phase.hold_seconds > 0 and (
            self._status == "holding" or self._hold_elapsed > 0.0
        )
        at_target, leader, reason = _is_at_target(
            frame, self._targets, velocities, accelerations,
            phase.active_joints, phase, score_plane=score_plane,
            maintain_hold=maintaining,
        )
        self._last_leader = leader
        self._last_fail_reason = "" if at_target else reason

        if phase.hold_seconds > 0:
            grace = float(config.IMU_HOLD_BREAK_GRACE_S)
            if at_target:
                self._hold_break_elapsed = 0.0
                self._hold_elapsed += dt
                self._status = "holding"
                if self._hold_elapsed >= phase.hold_seconds:
                    self._advance_phase()
            elif self._hold_elapsed > 0.0:
                self._hold_break_elapsed += dt
                if self._hold_break_elapsed < grace:
                    self._status = "holding"
                else:
                    self._hold_elapsed = 0.0
                    self._hold_break_elapsed = 0.0
                    self._status = "moving"
            else:
                self._hold_elapsed = 0.0
                self._hold_break_elapsed = 0.0
                self._status = "moving"
        elif at_target:
            self._advance_phase()
        else:
            self._status = "moving"

        out_phase = self._current_phase()
        hold_progress = (
            self._hold_progress(out_phase)
            if self._status == "holding"
            else 0.0
        )
        fb = build_session_feedback(
            frame, self._targets, velocities, accelerations,
            out_phase, self._rep, self._exercise.reps, self._status,
            score_plane=score_plane,
            leader_joint=self._last_leader,
            fail_reason=self._last_fail_reason,
            hold_progress=hold_progress,
        )
        return self._smooth(fb)

    def _smooth(self, fb: SessionFeedback) -> SessionFeedback:
        alpha = config.EXERCISE_SCORE_SMOOTHING_ALPHA
        if self._smoothed_score is None:
            self._smoothed_score = float(fb.score)
        else:
            self._smoothed_score += alpha * (fb.score - self._smoothed_score)
        fb.score = round(self._smoothed_score)
        return fb
