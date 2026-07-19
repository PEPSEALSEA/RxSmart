import { Bone, Euler, Object3D, Quaternion } from "three";
import { computeSquatTransform, ROOT_BASE_Y } from "@/lib/mannequin-rig";
import {
  LOWER_KEYS,
  NEUTRAL_POSE,
  ResolvedPose,
  SensorFrame,
  UpperPoseKey,
  shortestPlaneDelta,
} from "@/lib/pose";

const DEG = Math.PI / 180;

/** Mixamo bone names on athlete.glb (X Bot). */
export const MIXAMO_BONES = {
  hips: "mixamorigHips",
  spine: "mixamorigSpine",
  leftArm: "mixamorigLeftArm",
  leftForeArm: "mixamorigLeftForeArm",
  rightArm: "mixamorigRightArm",
  rightForeArm: "mixamorigRightForeArm",
  leftUpLeg: "mixamorigLeftUpLeg",
  leftLeg: "mixamorigLeftLeg",
  rightUpLeg: "mixamorigRightUpLeg",
  rightLeg: "mixamorigRightLeg",
} as const;

/** Must include Next.js `basePath` (`/RxSmart`) so GitHub Pages resolves the asset. */
export const ATHLETE_MODEL_URL = "/RxSmart/models/athlete.glb";

export type BoneIndex = Map<string, Bone>;
export type BindPose = Map<string, Quaternion>;

const _euler = new Euler();
const _delta = new Quaternion();

export function indexMixamoBones(root: Object3D): BoneIndex {
  const map: BoneIndex = new Map();
  root.traverse((obj) => {
    if ((obj as Bone).isBone) {
      map.set(obj.name, obj as Bone);
    }
  });
  return map;
}

export function captureBindPose(bones: BoneIndex): BindPose {
  const map: BindPose = new Map();
  for (const [name, bone] of bones) {
    map.set(name, bone.quaternion.clone());
  }
  return map;
}

export function resolvedPoseToFrame(pose: ResolvedPose): SensorFrame {
  return {
    l_arm_upper: { ...pose.l_arm_upper, vElevation: 0, vPlane: 0 },
    r_arm_upper: { ...pose.r_arm_upper, vElevation: 0, vPlane: 0 },
    l_leg_upper: { ...pose.l_leg_upper, vElevation: 0, vPlane: 0 },
    r_leg_upper: { ...pose.r_leg_upper, vElevation: 0, vPlane: 0 },
    l_arm_lower: { ...pose.l_arm_lower, vBend: 0 },
    r_arm_lower: { ...pose.r_arm_lower, vBend: 0 },
    l_leg_lower: { ...pose.l_leg_lower, vBend: 0 },
    r_leg_lower: { ...pose.r_leg_lower, vBend: 0 },
    body: { rootY: ROOT_BASE_Y, rootZ: 0, mode: "standing" },
  };
}

export function lerpFrames(a: SensorFrame, b: SensorFrame, t: number): SensorFrame {
  const u = Math.min(1, Math.max(0, t));
  const lerpUpper = (ka: UpperPoseKey) => ({
    elevation: a[ka].elevation + (b[ka].elevation - a[ka].elevation) * u,
    plane: a[ka].plane + shortestPlaneDelta(a[ka].plane, b[ka].plane) * u,
    vElevation: 0,
    vPlane: 0,
  });
  const lerpLower = (key: (typeof LOWER_KEYS)[number]) => ({
    bend: a[key].bend + (b[key].bend - a[key].bend) * u,
    vBend: 0,
  });
  return {
    l_arm_upper: lerpUpper("l_arm_upper"),
    r_arm_upper: lerpUpper("r_arm_upper"),
    l_leg_upper: lerpUpper("l_leg_upper"),
    r_leg_upper: lerpUpper("r_leg_upper"),
    l_arm_lower: lerpLower("l_arm_lower"),
    r_arm_lower: lerpLower("r_arm_lower"),
    l_leg_lower: lerpLower("l_leg_lower"),
    r_leg_lower: lerpLower("r_leg_lower"),
    body: {
      rootY: (a.body?.rootY ?? ROOT_BASE_Y) + ((b.body?.rootY ?? ROOT_BASE_Y) - (a.body?.rootY ?? ROOT_BASE_Y)) * u,
      rootZ: (a.body?.rootZ ?? 0) + ((b.body?.rootZ ?? 0) - (a.body?.rootZ ?? 0)) * u,
      mode: b.body?.mode ?? a.body?.mode ?? "standing",
    },
  };
}

function applyBindDelta(bone: Bone | undefined, bind: BindPose, name: string, euler: Euler) {
  if (!bone) return;
  const base = bind.get(name);
  if (!base) return;
  _delta.setFromEuler(euler);
  bone.quaternion.copy(base).multiply(_delta);
}

/**
 * Apply SensorFrame onto a Mixamo T-pose skeleton.
 * Arms: T-pose = elevation 90°, plane 0°. Legs: bind = elevation 0°.
 */
export function applyFrameToMixamoBones(
  bones: BoneIndex,
  bind: BindPose,
  frame: SensorFrame,
  options?: { rootOffsetY?: number },
): void {
  const squat = computeSquatTransform(
    {
      elevation: frame.l_leg_upper.elevation,
      plane: frame.l_leg_upper.plane,
      bend: frame.l_leg_lower.bend,
    },
    {
      elevation: frame.r_leg_upper.elevation,
      plane: frame.r_leg_upper.plane,
      bend: frame.r_leg_lower.bend,
    },
    { mode: frame.body?.mode },
  );

  const hips = bones.get(MIXAMO_BONES.hips);
  if (hips) {
    const baseY = options?.rootOffsetY ?? 0;
    hips.position.y = baseY + (squat.rootY - ROOT_BASE_Y) * 0.85;
    hips.position.z = squat.rootZ * 0.85;
  }

  const spine = bones.get(MIXAMO_BONES.spine);
  if (spine) {
    const base = bind.get(MIXAMO_BONES.spine);
    if (base) {
      _euler.set(squat.pelvisLeanRad * 0.65 + squat.headCounterLeanRad * 0.25, 0, 0);
      _delta.setFromEuler(_euler);
      spine.quaternion.copy(base).multiply(_delta);
    }
  }

  const lArmElev = frame.l_arm_upper.elevation + squat.armElevationOffset;
  const lArmPlane = frame.l_arm_upper.plane + squat.armPlaneOffset;
  const rArmElev = frame.r_arm_upper.elevation + squat.armElevationOffset;
  const rArmPlane = frame.r_arm_upper.plane + squat.armPlaneOffset;

  // Left arm: from T-pose, negative Z lowers the arm; Y swings forward/back via plane
  _euler.set(0, -lArmPlane * DEG, (90 - lArmElev) * DEG, "XYZ");
  applyBindDelta(bones.get(MIXAMO_BONES.leftArm), bind, MIXAMO_BONES.leftArm, _euler);

  _euler.set(0, rArmPlane * DEG, (rArmElev - 90) * DEG, "XYZ");
  applyBindDelta(bones.get(MIXAMO_BONES.rightArm), bind, MIXAMO_BONES.rightArm, _euler);

  _euler.set(-frame.l_arm_lower.bend * DEG, 0, 0, "XYZ");
  applyBindDelta(bones.get(MIXAMO_BONES.leftForeArm), bind, MIXAMO_BONES.leftForeArm, _euler);

  _euler.set(-frame.r_arm_lower.bend * DEG, 0, 0, "XYZ");
  applyBindDelta(bones.get(MIXAMO_BONES.rightForeArm), bind, MIXAMO_BONES.rightForeArm, _euler);

  // Legs: lift via X (flexion) and slight Y for plane (abduction / forward)
  const lPlaneRad = frame.l_leg_upper.plane * DEG;
  const rPlaneRad = frame.r_leg_upper.plane * DEG;
  _euler.set(
    -frame.l_leg_upper.elevation * DEG * Math.max(0.35, Math.abs(Math.sin(lPlaneRad)) + 0.2),
    -frame.l_leg_upper.elevation * DEG * Math.cos(lPlaneRad) * 0.35,
    0,
    "XYZ",
  );
  applyBindDelta(bones.get(MIXAMO_BONES.leftUpLeg), bind, MIXAMO_BONES.leftUpLeg, _euler);

  _euler.set(
    -frame.r_leg_upper.elevation * DEG * Math.max(0.35, Math.abs(Math.sin(rPlaneRad)) + 0.2),
    frame.r_leg_upper.elevation * DEG * Math.cos(rPlaneRad) * 0.35,
    0,
    "XYZ",
  );
  applyBindDelta(bones.get(MIXAMO_BONES.rightUpLeg), bind, MIXAMO_BONES.rightUpLeg, _euler);

  _euler.set(frame.l_leg_lower.bend * DEG, 0, 0, "XYZ");
  applyBindDelta(bones.get(MIXAMO_BONES.leftLeg), bind, MIXAMO_BONES.leftLeg, _euler);

  _euler.set(frame.r_leg_lower.bend * DEG, 0, 0, "XYZ");
  applyBindDelta(bones.get(MIXAMO_BONES.rightLeg), bind, MIXAMO_BONES.rightLeg, _euler);
}

export function neutralDemoFrame(): SensorFrame {
  return resolvedPoseToFrame(NEUTRAL_POSE);
}
