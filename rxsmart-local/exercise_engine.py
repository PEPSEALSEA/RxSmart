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

Runs entirely on this machine — the browser only renders the JSON this
produces (see web_bridge.py), it does not compute pose correctness itself.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Dict, List, Optional

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


def _joint_score(error: float, tolerance: float) -> float:
    """Continuous grade: 100 at zero error, 0 by ~2x tolerance."""
    if tolerance <= 0:
        return 100.0 if error <= 0.01 else 0.0
    grade = 1.0 - (error / (tolerance * 2.0))
    return max(0.0, min(100.0, grade * 100.0))


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


def _evaluate_upper(
    key: str,
    frame: dict,
    targets: dict,
    velocities: dict,
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

    # IMU has no plane motion — judge speed from elevation alone.
    speed = abs(v["elevation"]) if not score_plane else math.hypot(v["elevation"], v["plane"])
    is_holding = phase.hold_seconds > 0
    velocity_ok = True
    if active and not is_holding and speed > 0.5:
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
        "angleOk": angle_ok,
        "velocityOk": velocity_ok,
        "isActive": active,
        "_score": (score_e + score_p) / 2.0,
    }


def _evaluate_lower(
    key: str,
    frame: dict,
    targets: dict,
    velocities: dict,
    active: bool,
    phase: ExercisePhase,
    score_plane: bool = True,  # noqa: ARG001 — kept for call-site symmetry with upper
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
    if active and not is_holding and speed > 0.5:
        velocity_ok = speed <= phase.move_speed * 1.35 and speed >= lim["idealVelocityMin"] * 0.35
    elif active and is_holding:
        velocity_ok = speed < 12

    score = _joint_score(bend_error, lim["tolerance"])

    return {
        "bend": round(f["bend"], 2),
        "targetBend": t["bend"],
        "vBend": round(v["bend"], 2),
        "bendError": round(bend_error, 2),
        "angleOk": angle_ok,
        "velocityOk": velocity_ok,
        "isActive": active,
        "_score": score,
    }


def _evaluate_joint(
    key: str,
    frame: dict,
    targets: dict,
    velocities: dict,
    active: bool,
    phase: ExercisePhase,
    score_plane: bool = True,
) -> dict:
    if key in UPPER_KEYS:
        return _evaluate_upper(key, frame, targets, velocities, active, phase, score_plane=score_plane)
    return _evaluate_lower(key, frame, targets, velocities, active, phase, score_plane=score_plane)


def _is_at_target(
    frame: dict,
    targets: dict,
    velocities: dict,
    active_joints: List[str],
    phase: ExercisePhase,
    score_plane: bool = True,
) -> bool:
    for key in active_joints:
        fb = _evaluate_joint(key, frame, targets, velocities, True, phase, score_plane=score_plane)
        if not fb["angleOk"]:
            return False
    return True


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

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "messages": self.messages,
            "phaseLabel": self.phase_label,
            "rep": self.rep,
            "totalReps": self.total_reps,
            "status": self.status,
            "activeJoints": self.active_joints,
            "jointFeedback": self.joint_feedback,
        }


def build_session_feedback(
    frame: dict,
    targets: dict,
    velocities: dict,
    phase: ExercisePhase,
    rep: int,
    total_reps: int,
    status: str,
    score_plane: bool = True,
) -> SessionFeedback:
    joint_feedback: Dict[str, dict] = {}
    active_scores: List[float] = []

    for key in POSE_KEYS:
        active = key in phase.active_joints
        fb = _evaluate_joint(key, frame, targets, velocities, active, phase, score_plane=score_plane)
        if active:
            active_scores.append(fb.pop("_score"))
        else:
            fb.pop("_score", None)
        joint_feedback[key] = fb

    raw_score = 100.0 if not active_scores else sum(active_scores) / len(active_scores)

    messages: List[str] = []
    if status == "holding":
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
            messages.append("ยก/ลดตามเป้า — คะแนนจากมุม elevation ของ IMU")
        else:
            messages.append("ความเร็วและมุมเหมาะสม — ทำต่อได้เลย")
    elif status == "rest":
        messages.append("พักระหว่าง rep")
    elif status == "complete":
        messages.append("เสร็จโปรแกรมแล้ว!")
    else:
        messages.append(
            "กดเริ่มเพื่อฝึก — คะแนนจาก IMU (elevation / bend)"
            if not score_plane
            else "กดเริ่มเพื่อฝึก — คำนวณจากกล้องบนเครื่องนี้ (Python)"
        )

    return SessionFeedback(
        score=round(raw_score),
        messages=messages[:3],
        phase_label=phase.label,
        rep=rep,
        total_reps=total_reps,
        status=status,
        active_joints=list(phase.active_joints),
        joint_feedback=joint_feedback,
    )


class ExerciseSessionManager:
    """Owns the current exercise + rep/phase/hold state machine, ticked once
    per web_bridge /api/state request using the latest smoothed camera pose."""

    def __init__(self, exercise: Optional[RehabExercise] = None) -> None:
        self._exercise: RehabExercise = exercise or REHAB_EXERCISES[0]
        self._phase_index = 0
        self._rep = 1
        self._phase_elapsed = 0.0
        self._rest_remaining = 0.0
        self._status = "idle"
        self._running = False
        self._targets: Dict[str, dict] = {k: dict(v) for k, v in self._exercise.start_pose.items()}
        self._last_tick_ts: Optional[float] = None
        self._prev_frame: Optional[dict] = None
        self._smoothed_score: Optional[float] = None

    @property
    def exercise(self) -> RehabExercise:
        return self._exercise

    def select_exercise(self, exercise_id: str) -> bool:
        ex = get_exercise_by_id(exercise_id)
        if ex is None:
            return False
        self._exercise = ex
        self.reset()
        return True

    def start(self) -> None:
        self._running = True
        self._status = "moving"
        self._phase_index = 0
        self._rep = 1
        self._phase_elapsed = 0.0
        self._rest_remaining = 0.0
        self._targets = resolve_pose(self._exercise.start_pose, self._current_phase().targets)
        self._smoothed_score = None

    def stop(self) -> None:
        self._running = False
        self._status = "idle"
        self._targets = {k: dict(v) for k, v in self._exercise.start_pose.items()}

    def reset(self) -> None:
        self.stop()
        self._phase_index = 0
        self._rep = 1
        self._phase_elapsed = 0.0
        self._rest_remaining = 0.0
        self._smoothed_score = None
        self._last_tick_ts = None
        self._prev_frame = None

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

    def _advance_phase(self) -> None:
        self._phase_elapsed = 0.0
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
        self._prev_frame = {k: dict(v) for k, v in frame.items()}

        phase = self._current_phase()

        if not self._running:
            fb = build_session_feedback(
                frame, self._targets, velocities, phase, self._rep, self._exercise.reps, "idle",
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
                frame, self._targets, velocities, phase, self._rep, self._exercise.reps, self._status,
                score_plane=score_plane,
            )
            return self._smooth(fb)

        self._targets = resolve_pose(self._exercise.start_pose, phase.targets)
        self._phase_elapsed += dt
        at_target = _is_at_target(
            frame, self._targets, velocities, phase.active_joints, phase, score_plane=score_plane,
        )

        if phase.hold_seconds > 0:
            self._status = "holding" if at_target else "moving"
            if at_target and self._phase_elapsed >= phase.hold_seconds:
                self._advance_phase()
        elif at_target:
            self._advance_phase()
        else:
            self._status = "moving"

        fb = build_session_feedback(
            frame, self._targets, velocities, phase, self._rep, self._exercise.reps, self._status,
            score_plane=score_plane,
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
