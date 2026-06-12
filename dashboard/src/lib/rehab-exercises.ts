import { NEUTRAL_POSE, PoseAngles, PoseKey } from "@/lib/pose";

export type ExerciseCategory = "arm" | "leg" | "bilateral" | "assessment";

export interface ExercisePhase {
  id: string;
  label: string;
  /** องศาเป้าหมายแต่ละ joint — joint ที่ไม่ระบุคงท่า rest */
  targets: Partial<PoseAngles>;
  /** วินาทีค้างท่า (0 = ไม่ค้าง) */
  holdSeconds: number;
  /** ความเร็วสูงสุดที่แนะนำเมื่อเคลื่อนไปท่านี้ (deg/s) */
  moveSpeed: number;
  /** joint ที่ต้องตรวจในช่วงนี้ */
  activeJoints: PoseKey[];
}

export interface RehabExercise {
  id: string;
  name: string;
  description: string;
  category: ExerciseCategory;
  /** ท่าเริ่มก่อนเข้า rep */
  startPose: PoseAngles;
  phases: ExercisePhase[];
  reps: number;
  restBetweenReps: number;
}

const REST = { ...NEUTRAL_POSE };

export const REHAB_EXERCISES: RehabExercise[] = [
  {
    id: "shoulder_flex_l",
    name: "ยกแขนซ้าย (Shoulder Flexion)",
    description: "ยกแขนซ้ายไปข้างหน้า 90° ช้าๆ ค้าง แล้วลดลง — เสริมไหล่",
    category: "arm",
    startPose: { ...REST, l_arm_upper: 8 },
    phases: [
      {
        id: "raise",
        label: "ยกแขนขึ้น",
        targets: { l_arm_upper: 90 },
        holdSeconds: 0,
        moveSpeed: 32,
        activeJoints: ["l_arm_upper"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_arm_upper: 90 },
        holdSeconds: 3,
        moveSpeed: 8,
        activeJoints: ["l_arm_upper"],
      },
      {
        id: "lower",
        label: "ลดแขนลง",
        targets: { l_arm_upper: 8 },
        holdSeconds: 0,
        moveSpeed: 25,
        activeJoints: ["l_arm_upper"],
      },
    ],
    reps: 8,
    restBetweenReps: 2,
  },
  {
    id: "shoulder_flex_r",
    name: "ยกแขนขวา (Shoulder Flexion)",
    description: "ยกแขนขวาไปข้างหน้า 90° — ฝึกไหล่ขวา",
    category: "arm",
    startPose: { ...REST, r_arm_upper: 8 },
    phases: [
      {
        id: "raise",
        label: "ยกแขนขึ้น",
        targets: { r_arm_upper: 90 },
        holdSeconds: 0,
        moveSpeed: 32,
        activeJoints: ["r_arm_upper"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { r_arm_upper: 90 },
        holdSeconds: 3,
        moveSpeed: 8,
        activeJoints: ["r_arm_upper"],
      },
      {
        id: "lower",
        label: "ลดแขนลง",
        targets: { r_arm_upper: 8 },
        holdSeconds: 0,
        moveSpeed: 25,
        activeJoints: ["r_arm_upper"],
      },
    ],
    reps: 8,
    restBetweenReps: 2,
  },
  {
    id: "elbow_flex_l",
    name: "งอข้อศอกซ้าย (Elbow Flexion)",
    description: "แขนซ้ายยกขึ้นเล็กน้อย งอข้อศอกเข้าหาไหล่",
    category: "arm",
    startPose: { ...REST, l_arm_upper: 25, l_arm_lower: 5 },
    phases: [
      {
        id: "curl",
        label: "งอข้อศอก",
        targets: { l_arm_upper: 25, l_arm_lower: 120 },
        holdSeconds: 0,
        moveSpeed: 38,
        activeJoints: ["l_arm_upper", "l_arm_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_arm_upper: 25, l_arm_lower: 120 },
        holdSeconds: 2,
        moveSpeed: 8,
        activeJoints: ["l_arm_lower"],
      },
      {
        id: "extend",
        label: "เหยียดข้อศอก",
        targets: { l_arm_upper: 25, l_arm_lower: 5 },
        holdSeconds: 0,
        moveSpeed: 30,
        activeJoints: ["l_arm_lower"],
      },
    ],
    reps: 10,
    restBetweenReps: 1.5,
  },
  {
    id: "elbow_flex_r",
    name: "งอข้อศอกขวา (Elbow Flexion)",
    description: "งอข้อศอกขวาเข้าหาไหล่ — เสริมกล้ามแขนขวา",
    category: "arm",
    startPose: { ...REST, r_arm_upper: 25, r_arm_lower: 5 },
    phases: [
      {
        id: "curl",
        label: "งอข้อศอก",
        targets: { r_arm_upper: 25, r_arm_lower: 120 },
        holdSeconds: 0,
        moveSpeed: 38,
        activeJoints: ["r_arm_upper", "r_arm_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { r_arm_upper: 25, r_arm_lower: 120 },
        holdSeconds: 2,
        moveSpeed: 8,
        activeJoints: ["r_arm_lower"],
      },
      {
        id: "extend",
        label: "เหยียดข้อศอก",
        targets: { r_arm_upper: 25, r_arm_lower: 5 },
        holdSeconds: 0,
        moveSpeed: 30,
        activeJoints: ["r_arm_lower"],
      },
    ],
    reps: 10,
    restBetweenReps: 1.5,
  },
  {
    id: "hip_flex_l",
    name: "ยกขาซ้าย (Hip Flexion)",
    description: "ยืนตรง ยกขาซ้ายไปข้างหน้า — ฝึกสะโพกและกล้ามแข็งขา",
    category: "leg",
    startPose: { ...REST },
    phases: [
      {
        id: "raise",
        label: "ยกขาขึ้น",
        targets: { l_leg_upper: 65, l_leg_lower: 5 },
        holdSeconds: 0,
        moveSpeed: 28,
        activeJoints: ["l_leg_upper", "l_leg_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_leg_upper: 65, l_leg_lower: 5 },
        holdSeconds: 2.5,
        moveSpeed: 6,
        activeJoints: ["l_leg_upper"],
      },
      {
        id: "lower",
        label: "ลดขาลง",
        targets: { l_leg_upper: 0, l_leg_lower: 0 },
        holdSeconds: 0,
        moveSpeed: 22,
        activeJoints: ["l_leg_upper"],
      },
    ],
    reps: 8,
    restBetweenReps: 2,
  },
  {
    id: "hip_flex_r",
    name: "ยกขาขวา (Hip Flexion)",
    description: "ยกขาขวาไปข้างหน้า — สมดุลสองข้าง",
    category: "leg",
    startPose: { ...REST },
    phases: [
      {
        id: "raise",
        label: "ยกขาขึ้น",
        targets: { r_leg_upper: 65, r_leg_lower: 5 },
        holdSeconds: 0,
        moveSpeed: 28,
        activeJoints: ["r_leg_upper", "r_leg_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { r_leg_upper: 65, r_leg_lower: 5 },
        holdSeconds: 2.5,
        moveSpeed: 6,
        activeJoints: ["r_leg_upper"],
      },
      {
        id: "lower",
        label: "ลดขาลง",
        targets: { r_leg_upper: 0, r_leg_lower: 0 },
        holdSeconds: 0,
        moveSpeed: 22,
        activeJoints: ["r_leg_upper"],
      },
    ],
    reps: 8,
    restBetweenReps: 2,
  },
  {
    id: "mini_squat",
    name: "นั่งยอง (Knee Flexion)",
    description: "งอเข่าทั้งสองข้างลงช้าๆ แล้วยืนขึ้น — ใช้ sensor ขา 4 จุดพร้อมกัน",
    category: "bilateral",
    startPose: { ...REST },
    phases: [
      {
        id: "down",
        label: "งอเข่าลง",
        targets: { l_leg_upper: 55, l_leg_lower: 75, r_leg_upper: 55, r_leg_lower: 75 },
        holdSeconds: 0,
        moveSpeed: 25,
        activeJoints: ["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่านั่งยอง",
        targets: { l_leg_upper: 55, l_leg_lower: 75, r_leg_upper: 55, r_leg_lower: 75 },
        holdSeconds: 2,
        moveSpeed: 5,
        activeJoints: ["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
      },
      {
        id: "up",
        label: "ยืนขึ้น",
        targets: { l_leg_upper: 0, l_leg_lower: 0, r_leg_upper: 0, r_leg_lower: 0 },
        holdSeconds: 0,
        moveSpeed: 22,
        activeJoints: ["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
      },
    ],
    reps: 6,
    restBetweenReps: 3,
  },
  {
    id: "bilateral_arm",
    name: "ยกแขนทั้งสองข้าง",
    description: "ยกแขนซ้าย–ขวาพร้อมกัน ใช้ sensor แขน 4 จุด",
    category: "bilateral",
    startPose: { ...REST, l_arm_upper: 8, r_arm_upper: 8 },
    phases: [
      {
        id: "raise",
        label: "ยกแขนทั้งสองข้าง",
        targets: { l_arm_upper: 85, r_arm_upper: 85, l_arm_lower: 5, r_arm_lower: 5 },
        holdSeconds: 0,
        moveSpeed: 30,
        activeJoints: ["l_arm_upper", "r_arm_upper", "l_arm_lower", "r_arm_lower"],
      },
      {
        id: "hold",
        label: "ค้างท่า",
        targets: { l_arm_upper: 85, r_arm_upper: 85 },
        holdSeconds: 2.5,
        moveSpeed: 6,
        activeJoints: ["l_arm_upper", "r_arm_upper"],
      },
      {
        id: "lower",
        label: "ลดแขนลง",
        targets: { l_arm_upper: 8, r_arm_upper: 8 },
        holdSeconds: 0,
        moveSpeed: 24,
        activeJoints: ["l_arm_upper", "r_arm_upper"],
      },
    ],
    reps: 6,
    restBetweenReps: 2.5,
  },
  {
    id: "marching",
    name: "ก้าวขาสลับ (Marching)",
    description: "ยกขาซ้าย–ขวาสลับกัน ใช้ sensor ขาทั้ง 4 จุด",
    category: "bilateral",
    startPose: { ...REST },
    phases: [
      {
        id: "left_up",
        label: "ยกขาซ้าย",
        targets: { l_leg_upper: 55, l_leg_lower: 8, r_leg_upper: 0, r_leg_lower: 0 },
        holdSeconds: 1,
        moveSpeed: 26,
        activeJoints: ["l_leg_upper", "l_leg_lower", "r_leg_upper"],
      },
      {
        id: "left_down",
        label: "ลดขาซ้าย",
        targets: { l_leg_upper: 0, l_leg_lower: 0 },
        holdSeconds: 0,
        moveSpeed: 22,
        activeJoints: ["l_leg_upper"],
      },
      {
        id: "right_up",
        label: "ยกขาขวา",
        targets: { r_leg_upper: 55, r_leg_lower: 8, l_leg_upper: 0, l_leg_lower: 0 },
        holdSeconds: 1,
        moveSpeed: 26,
        activeJoints: ["r_leg_upper", "r_leg_lower", "l_leg_upper"],
      },
      {
        id: "right_down",
        label: "ลดขาขวา",
        targets: { r_leg_upper: 0, r_leg_lower: 0 },
        holdSeconds: 0,
        moveSpeed: 22,
        activeJoints: ["r_leg_upper"],
      },
    ],
    reps: 5,
    restBetweenReps: 2,
  },
  {
    id: "full_rom",
    name: "ประเมิน ROM ทั้ง 8 จุด",
    description: "เคลื่อนไหวช้าๆ ครบทุกข้อ — ใช้ตรวจช่วงการเคลื่อนไหว",
    category: "assessment",
    startPose: { ...REST },
    phases: [
      {
        id: "arms",
        label: "แขนทั้งสองข้าง",
        targets: { l_arm_upper: 90, l_arm_lower: 90, r_arm_upper: 90, r_arm_lower: 90 },
        holdSeconds: 2,
        moveSpeed: 20,
        activeJoints: ["l_arm_upper", "l_arm_lower", "r_arm_upper", "r_arm_lower"],
      },
      {
        id: "legs",
        label: "ขาทั้งสองข้าง",
        targets: { l_leg_upper: 60, l_leg_lower: 70, r_leg_upper: 60, r_leg_lower: 70 },
        holdSeconds: 2,
        moveSpeed: 18,
        activeJoints: ["l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
      },
      {
        id: "rest",
        label: "กลับท่าพัก",
        targets: { ...REST, l_arm_upper: 8, r_arm_upper: 8 },
        holdSeconds: 1,
        moveSpeed: 20,
        activeJoints: ["l_arm_upper", "l_arm_lower", "r_arm_upper", "r_arm_lower", "l_leg_upper", "l_leg_lower", "r_leg_upper", "r_leg_lower"],
      },
    ],
    reps: 2,
    restBetweenReps: 4,
  },
];

export function getExerciseById(id: string): RehabExercise | undefined {
  return REHAB_EXERCISES.find((e) => e.id === id);
}
