import {
  ARM_REST,
  NEUTRAL_POSE,
  PoseKey,
  PoseTargets,
  ResolvedPose,
  resolvePose,
} from "@/lib/pose";

export type ExerciseCategory = "arm" | "leg" | "bilateral" | "assessment";

export interface ExercisePhase {
  id: string;
  label: string;
  targets: PoseTargets;
  holdSeconds: number;
  moveSpeed: number;
  activeJoints: PoseKey[];
}

export interface RehabExercise {
  id: string;
  name: string;
  description: string;
  category: ExerciseCategory;
  startPose: ResolvedPose;
  phases: ExercisePhase[];
  reps: number;
  restBetweenReps: number;
}

const REST = NEUTRAL_POSE;

export const REHAB_EXERCISES: RehabExercise[] = [
  {
    id: "shoulder_flex_l",
    name: "ยกแขนซ้ายไปข้างหน้า",
    description: "Shoulder flexion — elevation + plane ไปข้างหน้า",
    category: "arm",
    startPose: { ...REST },
    phases: [
      {
        id: "raise",
        label: "ยกไปข้างหน้า",
        targets: { l_arm_upper: { elevation: 90, plane: 90 } },
        holdSeconds: 0,
        moveSpeed: 32,
        activeJoints: ["l_arm_upper"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_arm_upper: { elevation: 90, plane: 90 } },
        holdSeconds: 3,
        moveSpeed: 8,
        activeJoints: ["l_arm_upper"],
      },
      {
        id: "lower",
        label: "ลดลง",
        targets: { l_arm_upper: { ...ARM_REST } },
        holdSeconds: 0,
        moveSpeed: 25,
        activeJoints: ["l_arm_upper"],
      },
    ],
    reps: 8,
    restBetweenReps: 2,
  },
  {
    id: "shoulder_abduct_l",
    name: "ยกแขนซ้ายไปข้างๆ (T-pose)",
    description: "Abduction — ยกแขนไปข้าง ใช้ plane ข้างตัว",
    category: "arm",
    startPose: { ...REST },
    phases: [
      {
        id: "raise",
        label: "ยกไปข้าง",
        targets: { l_arm_upper: { elevation: 90, plane: 0 } },
        holdSeconds: 0,
        moveSpeed: 28,
        activeJoints: ["l_arm_upper"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_arm_upper: { elevation: 90, plane: 0 } },
        holdSeconds: 2.5,
        moveSpeed: 6,
        activeJoints: ["l_arm_upper"],
      },
      {
        id: "lower",
        label: "ลดลง",
        targets: { l_arm_upper: { ...ARM_REST } },
        holdSeconds: 0,
        moveSpeed: 22,
        activeJoints: ["l_arm_upper"],
      },
    ],
    reps: 8,
    restBetweenReps: 2,
  },
  {
    id: "arm_swim_l",
    name: "หมุนแขนซ้าย (ท่าว่ายน้ำ)",
    description: "Circumduction — หมุนแขนเป็นวงกลม คล้าย freestyle",
    category: "arm",
    startPose: { ...REST },
    phases: [
      {
        id: "reach",
        label: "เหยียดไปข้างหน้า",
        targets: { l_arm_upper: { elevation: 30, plane: 90 }, l_arm_lower: { bend: 25 } },
        holdSeconds: 0.4,
        moveSpeed: 40,
        activeJoints: ["l_arm_upper", "l_arm_lower"],
      },
      {
        id: "pull",
        label: "ดึงขึ้น-ผ่านหัว",
        targets: { l_arm_upper: { elevation: 120, plane: 80 }, l_arm_lower: { bend: 85 } },
        holdSeconds: 0.3,
        moveSpeed: 45,
        activeJoints: ["l_arm_upper", "l_arm_lower"],
      },
      {
        id: "recover",
        label: "ฟื้นข้ามตัว",
        targets: { l_arm_upper: { elevation: 90, plane: 200 }, l_arm_lower: { bend: 15 } },
        holdSeconds: 0.3,
        moveSpeed: 42,
        activeJoints: ["l_arm_upper", "l_arm_lower"],
      },
      {
        id: "sweep",
        label: "เหวี่ยงกลับข้างหลัง",
        targets: { l_arm_upper: { elevation: 45, plane: 280 }, l_arm_lower: { bend: 10 } },
        holdSeconds: 0.3,
        moveSpeed: 38,
        activeJoints: ["l_arm_upper", "l_arm_lower"],
      },
      {
        id: "return",
        label: "กลับท่าเริ่ม",
        targets: { l_arm_upper: { ...ARM_REST }, l_arm_lower: { bend: 8 } },
        holdSeconds: 0,
        moveSpeed: 30,
        activeJoints: ["l_arm_upper", "l_arm_lower"],
      },
    ],
    reps: 5,
    restBetweenReps: 3,
  },
  {
    id: "arm_swim_r",
    name: "หมุนแขนขวา (ท่าว่ายน้ำ)",
    description: "Circumduction แขนขวา — วงจรเต็มรอบ",
    category: "arm",
    startPose: { ...REST },
    phases: [
      {
        id: "reach",
        label: "เหยียดไปข้างหน้า",
        targets: { r_arm_upper: { elevation: 30, plane: 90 }, r_arm_lower: { bend: 25 } },
        holdSeconds: 0.4,
        moveSpeed: 40,
        activeJoints: ["r_arm_upper", "r_arm_lower"],
      },
      {
        id: "pull",
        label: "ดึงขึ้น-ผ่านหัว",
        targets: { r_arm_upper: { elevation: 120, plane: 80 }, r_arm_lower: { bend: 85 } },
        holdSeconds: 0.3,
        moveSpeed: 45,
        activeJoints: ["r_arm_upper", "r_arm_lower"],
      },
      {
        id: "recover",
        label: "ฟื้นข้ามตัว",
        targets: { r_arm_upper: { elevation: 90, plane: 200 }, r_arm_lower: { bend: 15 } },
        holdSeconds: 0.3,
        moveSpeed: 42,
        activeJoints: ["r_arm_upper", "r_arm_lower"],
      },
      {
        id: "sweep",
        label: "เหวี่ยงกลับข้างหลัง",
        targets: { r_arm_upper: { elevation: 45, plane: 280 }, r_arm_lower: { bend: 10 } },
        holdSeconds: 0.3,
        moveSpeed: 38,
        activeJoints: ["r_arm_upper", "r_arm_lower"],
      },
      {
        id: "return",
        label: "กลับท่าเริ่ม",
        targets: { r_arm_upper: { ...ARM_REST }, r_arm_lower: { bend: 8 } },
        holdSeconds: 0,
        moveSpeed: 30,
        activeJoints: ["r_arm_upper", "r_arm_lower"],
      },
    ],
    reps: 5,
    restBetweenReps: 3,
  },
  {
    id: "elbow_flex_l",
    name: "งอข้อศอกซ้าย",
    description: "Elbow flexion — ข้อศอกงอเข้าหาตัว",
    category: "arm",
    startPose: resolvePose(REST, { l_arm_upper: { elevation: 25, plane: 90 } }),
    phases: [
      {
        id: "curl",
        label: "งอข้อศอก",
        targets: { l_arm_upper: { elevation: 25, plane: 90 }, l_arm_lower: { bend: 120 } },
        holdSeconds: 0,
        moveSpeed: 35,
        activeJoints: ["l_arm_upper", "l_arm_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_arm_lower: { bend: 120 } },
        holdSeconds: 2,
        moveSpeed: 6,
        activeJoints: ["l_arm_lower"],
      },
      {
        id: "extend",
        label: "เหยียด",
        targets: { l_arm_lower: { bend: 8 } },
        holdSeconds: 0,
        moveSpeed: 28,
        activeJoints: ["l_arm_lower"],
      },
    ],
    reps: 10,
    restBetweenReps: 1.5,
  },
  {
    id: "hip_flex_l",
    name: "ยกขาซ้ายไปข้างหน้า",
    description: "Hip flexion — สะโพกยกขาไปหน้า",
    category: "leg",
    startPose: { ...REST },
    phases: [
      {
        id: "raise",
        label: "ยกขาไปหน้า",
        targets: { l_leg_upper: { elevation: 65, plane: 90 }, l_leg_lower: { bend: 8 } },
        holdSeconds: 0,
        moveSpeed: 26,
        activeJoints: ["l_leg_upper", "l_leg_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_leg_upper: { elevation: 65, plane: 90 } },
        holdSeconds: 2.5,
        moveSpeed: 5,
        activeJoints: ["l_leg_upper"],
      },
      {
        id: "lower",
        label: "ลดลง",
        targets: { l_leg_upper: { elevation: 0, plane: 0 }, l_leg_lower: { bend: 0 } },
        holdSeconds: 0,
        moveSpeed: 20,
        activeJoints: ["l_leg_upper"],
      },
    ],
    reps: 8,
    restBetweenReps: 2,
  },
  {
    id: "hip_abduct_l",
    name: "ยกขาซ้ายไปข้าง",
    description: "Hip abduction — ยกขาไปข้าง (plane ข้างตัว)",
    category: "leg",
    startPose: { ...REST },
    phases: [
      {
        id: "raise",
        label: "ยกขาไปข้าง",
        targets: { l_leg_upper: { elevation: 50, plane: 0 } },
        holdSeconds: 0,
        moveSpeed: 22,
        activeJoints: ["l_leg_upper"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_leg_upper: { elevation: 50, plane: 0 } },
        holdSeconds: 2,
        moveSpeed: 5,
        activeJoints: ["l_leg_upper"],
      },
      {
        id: "lower",
        label: "ลดลง",
        targets: { l_leg_upper: { elevation: 0, plane: 0 } },
        holdSeconds: 0,
        moveSpeed: 18,
        activeJoints: ["l_leg_upper"],
      },
    ],
    reps: 8,
    restBetweenReps: 2,
  },
  {
    id: "mini_squat",
    name: "นั่งยอง",
    description: "งอเข่าทั้งสองข้าง — sensor ขา 4 จุด",
    category: "bilateral",
    startPose: { ...REST },
    phases: [
      {
        id: "down",
        label: "งอเข่าลง",
        targets: {
          l_leg_upper: { elevation: 55, plane: 90 },
          l_leg_lower: { bend: 75 },
          r_leg_upper: { elevation: 55, plane: 90 },
          r_leg_lower: { bend: 75 },
        },
        holdSeconds: 0,
        moveSpeed: 24,
        activeJoints: ["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: {
          l_leg_upper: { elevation: 55, plane: 90 },
          l_leg_lower: { bend: 75 },
          r_leg_upper: { elevation: 55, plane: 90 },
          r_leg_lower: { bend: 75 },
        },
        holdSeconds: 2,
        moveSpeed: 5,
        activeJoints: ["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
      },
      {
        id: "up",
        label: "ยืนขึ้น",
        targets: {
          l_leg_upper: { elevation: 0, plane: 0 },
          l_leg_lower: { bend: 0 },
          r_leg_upper: { elevation: 0, plane: 0 },
          r_leg_lower: { bend: 0 },
        },
        holdSeconds: 0,
        moveSpeed: 20,
        activeJoints: ["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
      },
    ],
    reps: 6,
    restBetweenReps: 3,
  },
  {
    id: "bilateral_arm",
    name: "ยกแขนสองข้าง",
    description: "ยกแขนซ้าย-ขวาไปข้างหน้าพร้อมกัน",
    category: "bilateral",
    startPose: { ...REST },
    phases: [
      {
        id: "raise",
        label: "ยกแขนขึ้น",
        targets: {
          l_arm_upper: { elevation: 85, plane: 90 },
          r_arm_upper: { elevation: 85, plane: 90 },
        },
        holdSeconds: 0,
        moveSpeed: 28,
        activeJoints: ["l_arm_upper", "r_arm_upper", "l_arm_lower", "r_arm_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_arm_upper: { elevation: 85, plane: 90 }, r_arm_upper: { elevation: 85, plane: 90 } },
        holdSeconds: 2.5,
        moveSpeed: 6,
        activeJoints: ["l_arm_upper", "r_arm_upper"],
      },
      {
        id: "lower",
        label: "ลดลง",
        targets: { l_arm_upper: { ...ARM_REST }, r_arm_upper: { ...ARM_REST } },
        holdSeconds: 0,
        moveSpeed: 22,
        activeJoints: ["l_arm_upper", "r_arm_upper"],
      },
    ],
    reps: 6,
    restBetweenReps: 2.5,
  },
];

export function getExerciseById(id: string): RehabExercise | undefined {
  return REHAB_EXERCISES.find((e) => e.id === id);
}
