export type PoseKey =
  | "l_arm_upper"
  | "l_arm_lower"
  | "r_arm_upper"
  | "r_arm_lower"
  | "l_leg_upper"
  | "l_leg_lower"
  | "r_leg_upper"
  | "r_leg_lower";

export type PoseAngles = Record<PoseKey, number>;

export const POSE_KEYS: PoseKey[] = [
  "l_arm_upper",
  "l_arm_lower",
  "r_arm_upper",
  "r_arm_lower",
  "l_leg_upper",
  "l_leg_lower",
  "r_leg_upper",
  "r_leg_lower",
];

export const POSE_LABELS: Record<PoseKey, string> = {
  l_arm_upper: "แขนซ้าย บน (ไหล่–ข้อศอก)",
  l_arm_lower: "แขนซ้าย ล่าง (ข้อศอก–ข้อมือ)",
  r_arm_upper: "แขนขวา บน (ไหล่–ข้อศอก)",
  r_arm_lower: "แขนขวา ล่าง (ข้อศอก–ข้อมือ)",
  l_leg_upper: "ขาซ้าย บน (สะโพก–เข่า)",
  l_leg_lower: "ขาซ้าย ล่าง (เข่า–ข้อเท้า)",
  r_leg_upper: "ขาขวา บน (สะโพก–เข่า)",
  r_leg_lower: "ขาขวา ล่าง (เข่า–ข้อเท้า)",
};

export const SENSOR_CHANNELS: Record<PoseKey, number> = {
  l_arm_upper: 0,
  l_arm_lower: 1,
  r_arm_upper: 2,
  r_arm_lower: 3,
  l_leg_upper: 4,
  l_leg_lower: 5,
  r_leg_upper: 6,
  r_leg_lower: 7,
};

export const NEUTRAL_POSE: PoseAngles = {
  l_arm_upper: 0,
  l_arm_lower: 0,
  r_arm_upper: 0,
  r_arm_lower: 0,
  l_leg_upper: 0,
  l_leg_lower: 0,
  r_leg_upper: 0,
  r_leg_lower: 0,
};

export interface PosePreset {
  id: string;
  name: string;
  description: string;
  pose: PoseAngles;
}

export const POSE_PRESETS: PosePreset[] = [
  {
    id: "stand",
    name: "ยืนตรง",
    description: "ท่าพื้นฐาน แขนขาตรง",
    pose: { ...NEUTRAL_POSE },
  },
  {
    id: "raise_left",
    name: "ยกแขนซ้าย",
    description: "ยกแขนซ้ายไปข้างหน้า 90°",
    pose: { ...NEUTRAL_POSE, l_arm_upper: 90 },
  },
  {
    id: "raise_right",
    name: "ยกแขนขวา",
    description: "ยกแขนขวาไปข้างหน้า 90°",
    pose: { ...NEUTRAL_POSE, r_arm_upper: 90 },
  },
  {
    id: "curl_left",
    name: "งอข้อศอกซ้าย",
    description: "งอข้อศอกซ้ายเข้าหาตัว",
    pose: { ...NEUTRAL_POSE, l_arm_upper: 25, l_arm_lower: 120 },
  },
  {
    id: "squat",
    name: "นั่งยอง",
    description: "งอเข่าลงเหมือนนั่งยอง",
    pose: { ...NEUTRAL_POSE, l_leg_upper: 70, l_leg_lower: 80, r_leg_upper: 70, r_leg_lower: 80 },
  },
  {
    id: "leg_raise",
    name: "ยกขาซ้าย",
    description: "ยกขาซ้ายไปข้างหน้า",
    pose: { ...NEUTRAL_POSE, l_leg_upper: 75 },
  },
];

export function guessExercise(pose: PoseAngles): string {
  if (pose.l_leg_upper > 50 || pose.r_leg_upper > 50) {
    if (pose.l_leg_lower > 50 && pose.r_leg_lower > 50) return "นั่งยอง / Squat";
    if (pose.l_leg_upper > 50) return "ยกขาซ้าย";
    if (pose.r_leg_upper > 50) return "ยกขาขวา";
  }
  if (pose.l_arm_lower > 80) return "งอข้อศอกซ้าย";
  if (pose.r_arm_lower > 80) return "งอข้อศอกขวา";
  if (pose.l_arm_upper > 60 && pose.r_arm_upper > 60) return "ยกแขนทั้งสองข้าง";
  if (pose.l_arm_upper > 60) return "ยกแขนซ้าย";
  if (pose.r_arm_upper > 60) return "ยกแขนขวา";
  return "ยืนตรง / พัก";
}

export function lerpPose(from: PoseAngles, to: PoseAngles, t: number): PoseAngles {
  const result = { ...from };
  for (const key of POSE_KEYS) {
    result[key] = from[key] + (to[key] - from[key]) * t;
  }
  return result;
}
