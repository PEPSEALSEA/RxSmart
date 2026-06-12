export type UpperPoseKey = "l_arm_upper" | "r_arm_upper" | "l_leg_upper" | "r_leg_upper";
export type LowerPoseKey = "l_arm_lower" | "r_arm_lower" | "l_leg_lower" | "r_leg_lower";
export type PoseKey = UpperPoseKey | LowerPoseKey;

/** ข้อต่อบน (ไหล่/สะโพก) — หมุนได้เกือบรอบทิศ เช่น ท่าว่ายน้ำ */
export interface UpperJointAngles {
  /** ยกจากแขนห้อย: 0°=ลง, 90°=ขนานพื้น, 180°=ชี้ขึ้น */
  elevation: number;
  /** หมุนรอบลำตัว: 0°=ข้างตัว, 90°=หน้า, 180°=ข้ามตัว, 270°=หลัง */
  plane: number;
}

/** ข้อต่อล่าง (ข้อศอก/เข่า) — งอ-เหยียด */
export interface LowerJointAngles {
  bend: number;
}

export interface UpperJointReading extends UpperJointAngles {
  vElevation: number;
  vPlane: number;
}

export interface LowerJointReading extends LowerJointAngles {
  vBend: number;
}

export type SensorFrame = Record<UpperPoseKey, UpperJointReading> & Record<LowerPoseKey, LowerJointReading>;

export type UpperJointTarget = Partial<UpperJointAngles>;
export type LowerJointTarget = Partial<LowerJointAngles>;
export type PoseTargets = Partial<Record<UpperPoseKey, UpperJointTarget>> &
  Partial<Record<LowerPoseKey, LowerJointTarget>>;

export type ResolvedPose = Record<UpperPoseKey, UpperJointAngles> & Record<LowerPoseKey, LowerJointAngles>;

export const UPPER_KEYS: UpperPoseKey[] = ["l_arm_upper", "r_arm_upper", "l_leg_upper", "r_leg_upper"];
export const LOWER_KEYS: LowerPoseKey[] = ["l_arm_lower", "r_arm_lower", "l_leg_lower", "r_leg_lower"];
export const POSE_KEYS: PoseKey[] = [...UPPER_KEYS, ...LOWER_KEYS];

export const POSE_LABELS: Record<PoseKey, string> = {
  l_arm_upper: "แขนซ้าย บน (ไหล่)",
  l_arm_lower: "แขนซ้าย ล่าง (ข้อศอก)",
  r_arm_upper: "แขนขวา บน (ไหล่)",
  r_arm_lower: "แขนขวา ล่าง (ข้อศอก)",
  l_leg_upper: "ขาซ้าย บน (สะโพก)",
  l_leg_lower: "ขาซ้าย ล่าง (เข่า)",
  r_leg_upper: "ขาขวา บน (สะโพก)",
  r_leg_lower: "ขาขวา ล่าง (เข่า)",
};

/** MPU6050 ช่องบน TCA9548A — proximal segment ต่อข้อต่อบน */
export const UPPER_SENSOR_CHANNEL: Record<UpperPoseKey, number> = {
  l_arm_upper: 0,
  r_arm_upper: 2,
  l_leg_upper: 4,
  r_leg_upper: 6,
};

/** distal segment ต่อข้อต่อล่าง */
export const LOWER_SENSOR_CHANNEL: Record<LowerPoseKey, number> = {
  l_arm_lower: 1,
  r_arm_lower: 3,
  l_leg_lower: 5,
  r_leg_lower: 7,
};

export function isUpperKey(key: PoseKey): key is UpperPoseKey {
  return (UPPER_KEYS as string[]).includes(key);
}

export function isLowerKey(key: PoseKey): key is LowerPoseKey {
  return (LOWER_KEYS as string[]).includes(key);
}

export const NEUTRAL_POSE: ResolvedPose = {
  l_arm_upper: { elevation: 8, plane: 0 },
  l_arm_lower: { bend: 5 },
  r_arm_upper: { elevation: 8, plane: 0 },
  r_arm_lower: { bend: 5 },
  l_leg_upper: { elevation: 0, plane: 0 },
  l_leg_lower: { bend: 0 },
  r_leg_upper: { elevation: 0, plane: 0 },
  r_leg_lower: { bend: 0 },
};

export function shortestPlaneDelta(from: number, to: number): number {
  let diff = ((to - from) % 360 + 360) % 360;
  if (diff > 180) diff -= 360;
  return diff;
}

export function normalizePlane(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

export function planeLabel(plane: number): string {
  const p = normalizePlane(plane);
  if (p < 30 || p >= 330) return "ข้างตัว";
  if (p < 60) return "เฉียงหน้า";
  if (p < 120) return "ข้างหน้า";
  if (p < 150) return "เฉียงข้าม";
  if (p < 210) return "ข้ามตัว";
  if (p < 240) return "เฉียงหลัง";
  if (p < 300) return "ข้างหลัง";
  return "เฉียงข้าง";
}

export function resolvePose(base: ResolvedPose, partial: PoseTargets): ResolvedPose {
  const result: ResolvedPose = {
    l_arm_upper: { ...base.l_arm_upper },
    r_arm_upper: { ...base.r_arm_upper },
    l_leg_upper: { ...base.l_leg_upper },
    r_leg_upper: { ...base.r_leg_upper },
    l_arm_lower: { ...base.l_arm_lower },
    r_arm_lower: { ...base.r_arm_lower },
    l_leg_lower: { ...base.l_leg_lower },
    r_leg_lower: { ...base.r_leg_lower },
  };

  for (const key of UPPER_KEYS) {
    const t = partial[key];
    if (!t) continue;
    if (t.elevation !== undefined) result[key].elevation = t.elevation;
    if (t.plane !== undefined) result[key].plane = normalizePlane(t.plane);
  }

  for (const key of LOWER_KEYS) {
    const t = partial[key];
    if (t?.bend !== undefined) result[key].bend = t.bend;
  }

  return result;
}
