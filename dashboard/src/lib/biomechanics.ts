import { PoseKey } from "@/lib/pose";

export interface JointLimits {
  min: number;
  max: number;
  rest: number;
  /** องศาต่อวินาที — ความเร็วสูงสุดที่ปลอดภัยใน rehab */
  maxVelocity: number;
  /** ช่วงความเร็วที่แนะนำ (deg/s) */
  idealVelocityMin: number;
  idealVelocityMax: number;
  /** ค่าเผื่อเมื่อเทียบเป้าหมายท่า (องศา) */
  tolerance: number;
}

/**
 * มุม 0° = แขนขาตรงตามท่ายืน (anatomical neutral)
 * มุมบวก = flexion (งอเข้าหาตัว / ยกไปข้างหน้า)
 */
export const JOINT_LIMITS: Record<PoseKey, JointLimits> = {
  l_arm_upper: { min: 0, max: 160, rest: 8, maxVelocity: 55, idealVelocityMin: 18, idealVelocityMax: 42, tolerance: 8 },
  l_arm_lower: { min: 0, max: 145, rest: 5, maxVelocity: 70, idealVelocityMin: 22, idealVelocityMax: 50, tolerance: 6 },
  r_arm_upper: { min: 0, max: 160, rest: 8, maxVelocity: 55, idealVelocityMin: 18, idealVelocityMax: 42, tolerance: 8 },
  r_arm_lower: { min: 0, max: 145, rest: 5, maxVelocity: 70, idealVelocityMin: 22, idealVelocityMax: 50, tolerance: 6 },
  l_leg_upper: { min: 0, max: 120, rest: 0, maxVelocity: 40, idealVelocityMin: 12, idealVelocityMax: 32, tolerance: 7 },
  l_leg_lower: { min: 0, max: 135, rest: 0, maxVelocity: 50, idealVelocityMin: 15, idealVelocityMax: 38, tolerance: 6 },
  r_leg_upper: { min: 0, max: 120, rest: 0, maxVelocity: 40, idealVelocityMin: 12, idealVelocityMax: 32, tolerance: 7 },
  r_leg_lower: { min: 0, max: 135, rest: 0, maxVelocity: 50, idealVelocityMin: 15, idealVelocityMax: 38, tolerance: 6 },
};

/** ความยาวช่วงกระดูก (เมตร) สำหรับ kinematic chain */
export const SEGMENT_LENGTHS = {
  upperArm: 0.28,
  forearm: 0.26,
  thigh: 0.4,
  shank: 0.38,
  shoulderWidth: 0.24,
  hipWidth: 0.14,
  torsoHeight: 0.52,
} as const;

export function clampAngle(key: PoseKey, angle: number): number {
  const { min, max } = JOINT_LIMITS[key];
  return Math.min(max, Math.max(min, angle));
}

export function clampVelocity(key: PoseKey, velocity: number): number {
  const { maxVelocity } = JOINT_LIMITS[key];
  return Math.min(maxVelocity, Math.max(-maxVelocity, velocity));
}
