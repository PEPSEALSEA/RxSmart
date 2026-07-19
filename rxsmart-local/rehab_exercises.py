"""
Exercise catalog — the single source of truth for exercise targets.

Ported 1:1 from dashboard/src/lib/rehab-exercises.ts. Python is now the judge
of pose correctness (see exercise_engine.py); the dashboard only displays
whatever this machine computes, it no longer decides on its own whether a
pose is "correct".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from pose_model import ARM_REST, NEUTRAL_POSE, resolve_pose


@dataclass
class ExercisePhase:
    id: str
    label: str
    targets: Dict[str, dict]
    hold_seconds: float
    move_speed: float
    active_joints: List[str]


@dataclass
class RehabExercise:
    id: str
    name: str
    description: str
    category: str
    start_pose: Dict[str, Dict[str, float]]
    phases: List[ExercisePhase]
    reps: int
    rest_between_reps: float


def _rest() -> Dict[str, Dict[str, float]]:
    return {k: dict(v) for k, v in NEUTRAL_POSE.items()}


REHAB_EXERCISES: List[RehabExercise] = [
    RehabExercise(
        id="shoulder_flex_l",
        name="ยกแขนซ้ายไปข้างหน้า",
        description="Shoulder flexion — elevation + plane ไปข้างหน้า",
        category="arm",
        start_pose=_rest(),
        phases=[
            ExercisePhase(
                id="raise", label="ยกไปข้างหน้า",
                targets={"l_arm_upper": {"elevation": 90, "plane": 90}},
                hold_seconds=0, move_speed=32, active_joints=["l_arm_upper"],
            ),
            ExercisePhase(
                id="hold", label="ค้างท่า",
                targets={"l_arm_upper": {"elevation": 90, "plane": 90}},
                hold_seconds=3, move_speed=8, active_joints=["l_arm_upper"],
            ),
            ExercisePhase(
                id="lower", label="ลดลง",
                targets={"l_arm_upper": dict(ARM_REST)},
                hold_seconds=0, move_speed=25, active_joints=["l_arm_upper"],
            ),
        ],
        reps=8, rest_between_reps=2,
    ),
    RehabExercise(
        id="shoulder_abduct_l",
        name="ยกแขนซ้ายไปข้างๆ (T-pose)",
        description="Abduction — ยกแขนไปข้าง ใช้ plane ข้างตัว",
        category="arm",
        start_pose=_rest(),
        phases=[
            ExercisePhase(
                id="raise", label="ยกไปข้าง",
                targets={"l_arm_upper": {"elevation": 90, "plane": 0}},
                hold_seconds=0, move_speed=28, active_joints=["l_arm_upper"],
            ),
            ExercisePhase(
                id="hold", label="ค้างท่า",
                targets={"l_arm_upper": {"elevation": 90, "plane": 0}},
                hold_seconds=2.5, move_speed=6, active_joints=["l_arm_upper"],
            ),
            ExercisePhase(
                id="lower", label="ลดลง",
                targets={"l_arm_upper": dict(ARM_REST)},
                hold_seconds=0, move_speed=22, active_joints=["l_arm_upper"],
            ),
        ],
        reps=8, rest_between_reps=2,
    ),
    RehabExercise(
        id="arm_swim_l",
        name="หมุนแขนซ้าย (ท่าว่ายน้ำ)",
        description="Freestyle — วงจรแขนรอบนอกลำตัว (entry → pull → recovery)",
        category="arm",
        start_pose=_rest(),
        phases=[
            ExercisePhase(
                id="reach", label="เหยียดไปข้างหน้า",
                targets={"l_arm_upper": {"elevation": 22, "plane": 92}, "l_arm_lower": {"bend": 12}},
                hold_seconds=0.35, move_speed=38, active_joints=["l_arm_upper", "l_arm_lower"],
            ),
            ExercisePhase(
                id="pull", label="ดึงน้ำด้านข้าง",
                targets={"l_arm_upper": {"elevation": 58, "plane": 28}, "l_arm_lower": {"bend": 95}},
                hold_seconds=0.35, move_speed=42, active_joints=["l_arm_upper", "l_arm_lower"],
            ),
            ExercisePhase(
                id="exit", label="ดึงมือออกที่สะโพก",
                targets={"l_arm_upper": {"elevation": 18, "plane": 82}, "l_arm_lower": {"bend": 35}},
                hold_seconds=0.25, move_speed=36, active_joints=["l_arm_upper", "l_arm_lower"],
            ),
            ExercisePhase(
                id="recover", label="ฟื้นเหนือน้ำ",
                targets={"l_arm_upper": {"elevation": 148, "plane": 62}, "l_arm_lower": {"bend": 72}},
                hold_seconds=0.35, move_speed=40, active_joints=["l_arm_upper", "l_arm_lower"],
            ),
            ExercisePhase(
                id="return", label="กลับท่าเริ่ม",
                targets={"l_arm_upper": dict(ARM_REST), "l_arm_lower": {"bend": 6}},
                hold_seconds=0, move_speed=28, active_joints=["l_arm_upper", "l_arm_lower"],
            ),
        ],
        reps=5, rest_between_reps=3,
    ),
    RehabExercise(
        id="arm_swim_r",
        name="หมุนแขนขวา (ท่าว่ายน้ำ)",
        description="Freestyle แขนขวา — วงจรรอบนอกลำตัว",
        category="arm",
        start_pose=_rest(),
        phases=[
            ExercisePhase(
                id="reach", label="เหยียดไปข้างหน้า",
                targets={"r_arm_upper": {"elevation": 22, "plane": 92}, "r_arm_lower": {"bend": 12}},
                hold_seconds=0.35, move_speed=38, active_joints=["r_arm_upper", "r_arm_lower"],
            ),
            ExercisePhase(
                id="pull", label="ดึงน้ำด้านข้าง",
                targets={"r_arm_upper": {"elevation": 58, "plane": 28}, "r_arm_lower": {"bend": 95}},
                hold_seconds=0.35, move_speed=42, active_joints=["r_arm_upper", "r_arm_lower"],
            ),
            ExercisePhase(
                id="exit", label="ดึงมือออกที่สะโพก",
                targets={"r_arm_upper": {"elevation": 18, "plane": 82}, "r_arm_lower": {"bend": 35}},
                hold_seconds=0.25, move_speed=36, active_joints=["r_arm_upper", "r_arm_lower"],
            ),
            ExercisePhase(
                id="recover", label="ฟื้นเหนือน้ำ",
                targets={"r_arm_upper": {"elevation": 148, "plane": 62}, "r_arm_lower": {"bend": 72}},
                hold_seconds=0.35, move_speed=40, active_joints=["r_arm_upper", "r_arm_lower"],
            ),
            ExercisePhase(
                id="return", label="กลับท่าเริ่ม",
                targets={"r_arm_upper": dict(ARM_REST), "r_arm_lower": {"bend": 6}},
                hold_seconds=0, move_speed=28, active_joints=["r_arm_upper", "r_arm_lower"],
            ),
        ],
        reps=5, rest_between_reps=3,
    ),
    RehabExercise(
        id="elbow_flex_l",
        name="งอข้อศอกซ้าย",
        description="Elbow flexion — ข้อศอกงอเข้าหาตัว",
        category="arm",
        start_pose=resolve_pose(_rest(), {"l_arm_upper": {"elevation": 25, "plane": 90}}),
        phases=[
            ExercisePhase(
                id="curl", label="งอข้อศอก",
                targets={"l_arm_upper": {"elevation": 25, "plane": 90}, "l_arm_lower": {"bend": 120}},
                hold_seconds=0, move_speed=35, active_joints=["l_arm_upper", "l_arm_lower"],
            ),
            ExercisePhase(
                id="hold", label="ค้างท่า",
                targets={"l_arm_lower": {"bend": 120}},
                hold_seconds=2, move_speed=6, active_joints=["l_arm_lower"],
            ),
            ExercisePhase(
                id="extend", label="เหยียด",
                targets={"l_arm_lower": {"bend": 6}},
                hold_seconds=0, move_speed=28, active_joints=["l_arm_lower"],
            ),
        ],
        reps=10, rest_between_reps=1.5,
    ),
    RehabExercise(
        id="hip_flex_l",
        name="ยกขาซ้ายไปข้างหน้า",
        description="Hip flexion — สะโพกยกขาไปหน้า",
        category="leg",
        start_pose=_rest(),
        phases=[
            ExercisePhase(
                id="raise", label="ยกขาไปหน้า",
                targets={"l_leg_upper": {"elevation": 65, "plane": 90}, "l_leg_lower": {"bend": 8}},
                hold_seconds=0, move_speed=26, active_joints=["l_leg_upper", "l_leg_lower"],
            ),
            ExercisePhase(
                id="hold", label="ค้างท่า",
                targets={"l_leg_upper": {"elevation": 65, "plane": 90}},
                hold_seconds=2.5, move_speed=5, active_joints=["l_leg_upper"],
            ),
            ExercisePhase(
                id="lower", label="ลดลง",
                targets={"l_leg_upper": {"elevation": 0, "plane": 0}, "l_leg_lower": {"bend": 0}},
                hold_seconds=0, move_speed=20, active_joints=["l_leg_upper"],
            ),
        ],
        reps=8, rest_between_reps=2,
    ),
    RehabExercise(
        id="hip_abduct_l",
        name="ยกขาซ้ายไปข้าง",
        description="Hip abduction — ยกขาไปข้าง (plane ข้างตัว)",
        category="leg",
        start_pose=_rest(),
        phases=[
            ExercisePhase(
                id="raise", label="ยกขาไปข้าง",
                targets={"l_leg_upper": {"elevation": 50, "plane": 0}},
                hold_seconds=0, move_speed=22, active_joints=["l_leg_upper"],
            ),
            ExercisePhase(
                id="hold", label="ค้างท่า",
                targets={"l_leg_upper": {"elevation": 50, "plane": 0}},
                hold_seconds=2, move_speed=5, active_joints=["l_leg_upper"],
            ),
            ExercisePhase(
                id="lower", label="ลดลง",
                targets={"l_leg_upper": {"elevation": 0, "plane": 0}},
                hold_seconds=0, move_speed=18, active_joints=["l_leg_upper"],
            ),
        ],
        reps=8, rest_between_reps=2,
    ),
    RehabExercise(
        id="mini_squat",
        name="นั่งยอง",
        description="งอเข่าทั้งสองข้าง — sensor ขา 4 จุด",
        category="bilateral",
        start_pose=_rest(),
        phases=[
            ExercisePhase(
                id="down", label="งอเข่าลง",
                targets={
                    "l_leg_upper": {"elevation": 55, "plane": 90}, "l_leg_lower": {"bend": 75},
                    "r_leg_upper": {"elevation": 55, "plane": 90}, "r_leg_lower": {"bend": 75},
                },
                hold_seconds=0, move_speed=24,
                active_joints=["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
            ),
            ExercisePhase(
                id="hold", label="ค้างท่า",
                targets={
                    "l_leg_upper": {"elevation": 55, "plane": 90}, "l_leg_lower": {"bend": 75},
                    "r_leg_upper": {"elevation": 55, "plane": 90}, "r_leg_lower": {"bend": 75},
                },
                hold_seconds=2, move_speed=5,
                active_joints=["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
            ),
            ExercisePhase(
                id="up", label="ยืนขึ้น",
                targets={
                    "l_leg_upper": {"elevation": 0, "plane": 0}, "l_leg_lower": {"bend": 0},
                    "r_leg_upper": {"elevation": 0, "plane": 0}, "r_leg_lower": {"bend": 0},
                },
                hold_seconds=0, move_speed=20,
                active_joints=["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
            ),
        ],
        reps=6, rest_between_reps=3,
    ),
    RehabExercise(
        id="bilateral_arm",
        name="ยกแขนสองข้าง",
        description="ยกแขนซ้าย-ขวาไปข้างหน้าพร้อมกัน",
        category="bilateral",
        start_pose=_rest(),
        phases=[
            ExercisePhase(
                id="raise", label="ยกแขนขึ้น",
                targets={"l_arm_upper": {"elevation": 85, "plane": 90}, "r_arm_upper": {"elevation": 85, "plane": 90}},
                hold_seconds=0, move_speed=28,
                active_joints=["l_arm_upper", "r_arm_upper", "l_arm_lower", "r_arm_lower"],
            ),
            ExercisePhase(
                id="hold", label="ค้างท่า",
                targets={"l_arm_upper": {"elevation": 85, "plane": 90}, "r_arm_upper": {"elevation": 85, "plane": 90}},
                hold_seconds=2.5, move_speed=6, active_joints=["l_arm_upper", "r_arm_upper"],
            ),
            ExercisePhase(
                id="lower", label="ลดลง",
                targets={"l_arm_upper": dict(ARM_REST), "r_arm_upper": dict(ARM_REST)},
                hold_seconds=0, move_speed=22, active_joints=["l_arm_upper", "r_arm_upper"],
            ),
        ],
        reps=6, rest_between_reps=2.5,
    ),
]


def get_exercise_by_id(exercise_id: str) -> Optional[RehabExercise]:
    return next((e for e in REHAB_EXERCISES if e.id == exercise_id), None)


def exercise_catalog() -> List[dict]:
    """Lightweight catalog payload for the dashboard picker UI."""
    return [
        {
            "id": e.id,
            "name": e.name,
            "description": e.description,
            "category": e.category,
            "reps": e.reps,
        }
        for e in REHAB_EXERCISES
    ]
