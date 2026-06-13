import { LowerPoseKey, UpperPoseKey } from "@/lib/pose";

export interface ScalarLimit {
  min: number;
  max: number;
  rest: number;
  maxVelocity: number;
  idealVelocityMin: number;
  idealVelocityMax: number;
  tolerance: number;
}

export interface UpperJointLimits {
  elevation: ScalarLimit;
  plane: ScalarLimit;
}

export interface LowerJointLimits {
  bend: ScalarLimit;
}

export const UPPER_JOINT_LIMITS: Record<UpperPoseKey, UpperJointLimits> = {
  l_arm_upper: {
    elevation: { min: 0, max: 180, rest: 12, maxVelocity: 55, idealVelocityMin: 15, idealVelocityMax: 45, tolerance: 10 },
    plane: { min: 0, max: 360, rest: 88, maxVelocity: 75, idealVelocityMin: 20, idealVelocityMax: 55, tolerance: 12 },
  },
  r_arm_upper: {
    elevation: { min: 0, max: 180, rest: 12, maxVelocity: 55, idealVelocityMin: 15, idealVelocityMax: 45, tolerance: 10 },
    plane: { min: 0, max: 360, rest: 88, maxVelocity: 75, idealVelocityMin: 20, idealVelocityMax: 55, tolerance: 12 },
  },
  l_leg_upper: {
    elevation: { min: 0, max: 130, rest: 0, maxVelocity: 42, idealVelocityMin: 12, idealVelocityMax: 35, tolerance: 8 },
    plane: { min: 0, max: 360, rest: 0, maxVelocity: 50, idealVelocityMin: 10, idealVelocityMax: 40, tolerance: 12 },
  },
  r_leg_upper: {
    elevation: { min: 0, max: 130, rest: 0, maxVelocity: 42, idealVelocityMin: 12, idealVelocityMax: 35, tolerance: 8 },
    plane: { min: 0, max: 360, rest: 0, maxVelocity: 50, idealVelocityMin: 10, idealVelocityMax: 40, tolerance: 12 },
  },
};

export const LOWER_JOINT_LIMITS: Record<LowerPoseKey, LowerJointLimits> = {
  l_arm_lower: {
    bend: { min: 0, max: 145, rest: 8, maxVelocity: 70, idealVelocityMin: 20, idealVelocityMax: 50, tolerance: 6 },
  },
  r_arm_lower: {
    bend: { min: 0, max: 145, rest: 8, maxVelocity: 70, idealVelocityMin: 20, idealVelocityMax: 50, tolerance: 6 },
  },
  l_leg_lower: {
    bend: { min: 0, max: 135, rest: 0, maxVelocity: 50, idealVelocityMin: 15, idealVelocityMax: 38, tolerance: 6 },
  },
  r_leg_lower: {
    bend: { min: 0, max: 135, rest: 0, maxVelocity: 50, idealVelocityMin: 15, idealVelocityMax: 38, tolerance: 6 },
  },
};

export const SEGMENT_LENGTHS = {
  upperArm: 0.28,
  forearm: 0.26,
  thigh: 0.4,
  shank: 0.38,
  shoulderWidth: 0.24,
  hipWidth: 0.14,
  torsoHeight: 0.52,
} as const;

export function clampScalar(lim: ScalarLimit, value: number): number {
  return Math.min(lim.max, Math.max(lim.min, value));
}

export function clampVelocity(lim: ScalarLimit, velocity: number): number {
  return Math.min(lim.maxVelocity, Math.max(-lim.maxVelocity, velocity));
}
