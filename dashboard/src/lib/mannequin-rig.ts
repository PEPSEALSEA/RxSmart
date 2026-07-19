import { Group, Matrix4, Vector3 } from "three";
import { SEGMENT_LENGTHS } from "@/lib/biomechanics";
import { upperLimbDirection } from "@/lib/pose";

const DEG = Math.PI / 180;

const FOOT_OFFSET_Y = -0.02;
const FOOT_OFFSET_Z = 0.04;
const HIP_LINE_Y = 0.98;
const SQUAT_HIP_ELEV_MAX = 55;
const SQUAT_KNEE_BEND_MAX = 75;
const SQUAT_TORSO_LEAN_MAX = 24;

const _footLocal = new Vector3();
const _footResult = new Vector3();
const _leftFoot = new Vector3();
const _rightFoot = new Vector3();

const WORLD_FORWARD = new Vector3(0, 0, 1);
const LEG_HINT_LEFT = new Vector3(-0.15, 0, -1);
const LEG_HINT_RIGHT = new Vector3(0.15, 0, -1);

const _yAxis = new Vector3();
const _xAxis = new Vector3();
const _zAxis = new Vector3();
const _basis = new Matrix4();

/**
 * จัด segment ให้ชี้ตาม elevation/plane
 * - กระดูกชี้ตาม local -Y
 * - ข้อศอก/เข่างอรอบ local X (แกน medio-lateral) เมื่อตั้ง basis ถูกต้อง
 */
export function orientUpperLimb(
  group: Group,
  isRight: boolean,
  elevation: number,
  plane: number,
  isArm: boolean,
): void {
  const [dx, dy, dz] = upperLimbDirection(isRight, elevation, plane);

  // local +Y ของ joint ชี้ต opposite ทิศของ segment
  _yAxis.set(-dx, -dy, -dz).normalize();

  const hint = isArm ? WORLD_FORWARD : isRight ? LEG_HINT_RIGHT : LEG_HINT_LEFT;

  _xAxis.crossVectors(hint, _yAxis);
  if (_xAxis.lengthSq() < 1e-5) {
    _xAxis.set(isRight ? -1 : 1, 0, 0);
  }
  _xAxis.normalize();

  _zAxis.crossVectors(_xAxis, _yAxis).normalize();
  _xAxis.crossVectors(_yAxis, _zAxis).normalize();

  _basis.makeBasis(_xAxis, _yAxis, _zAxis);
  group.quaternion.setFromRotationMatrix(_basis);
}

/** งอข้อศอก/เข่า — หมุนรอบ local X (flexion) */
export function applyElbowBend(group: Group, bendDeg: number): void {
  group.rotation.set(-bendDeg * DEG, 0, 0);
}

/** Foot position relative to hip joint (before pelvis/root transforms). */
export function footOffsetFromHip(
  isRight: boolean,
  elevation: number,
  plane: number,
  kneeBendDeg: number,
  thighLen: number,
  shankLen: number,
  out = _footResult,
): Vector3 {
  const [dx, dy, dz] = upperLimbDirection(isRight, elevation, plane);

  _yAxis.set(-dx, -dy, -dz).normalize();
  const hint = isRight ? LEG_HINT_RIGHT : LEG_HINT_LEFT;
  _xAxis.crossVectors(hint, _yAxis);
  if (_xAxis.lengthSq() < 1e-5) {
    _xAxis.set(isRight ? -1 : 1, 0, 0);
  }
  _xAxis.normalize();
  _zAxis.crossVectors(_xAxis, _yAxis).normalize();
  _xAxis.crossVectors(_yAxis, _zAxis).normalize();
  _basis.makeBasis(_xAxis, _yAxis, _zAxis);

  const bendRad = -kneeBendDeg * DEG;
  const cosB = Math.cos(bendRad);
  const sinB = Math.sin(bendRad);

  const shankY = -shankLen + FOOT_OFFSET_Y;
  const shankZ = FOOT_OFFSET_Z;
  const rotY = shankY * cosB - shankZ * sinB;
  const rotZ = shankY * sinB + shankZ * cosB;

  _footLocal.set(0, -thighLen + rotY, rotZ);
  out.copy(_footLocal).applyMatrix4(_basis);
  return out;
}

export interface LegPoseSample {
  elevation: number;
  plane: number;
  bend: number;
}

export interface SquatTransform {
  depth: number;
  rootY: number;
  rootZ: number;
  pelvisLeanRad: number;
  headCounterLeanRad: number;
  armElevationOffset: number;
  armPlaneOffset: number;
}

function footInRootSpace(
  isRight: boolean,
  leg: LegPoseSample,
  pelvisLeanRad: number,
  out: Vector3,
): Vector3 {
  const hipX = (isRight ? 1 : -1) * SEGMENT_LENGTHS.hipWidth;
  const local = footOffsetFromHip(
    isRight,
    leg.elevation,
    leg.plane,
    leg.bend,
    SEGMENT_LENGTHS.thigh,
    SEGMENT_LENGTHS.shank,
    _footLocal,
  );

  const px = hipX + local.x;
  const py = local.y;
  const pz = local.z;
  const cosL = Math.cos(pelvisLeanRad);
  const sinL = Math.sin(pelvisLeanRad);

  out.set(px, HIP_LINE_Y + py * cosL - pz * sinL, py * sinL + pz * cosL);
  return out;
}

function squatDepth(left: LegPoseSample, right: LegPoseSample): number {
  const leftDepth = Math.max(left.elevation / SQUAT_HIP_ELEV_MAX, left.bend / SQUAT_KNEE_BEND_MAX);
  const rightDepth = Math.max(right.elevation / SQUAT_HIP_ELEV_MAX, right.bend / SQUAT_KNEE_BEND_MAX);
  return Math.min(1, (leftDepth + rightDepth) * 0.5);
}

const referenceFeet = (() => {
  const neutral: LegPoseSample = { elevation: 0, plane: 0, bend: 0 };
  footInRootSpace(false, neutral, 0, _leftFoot);
  footInRootSpace(true, neutral, 0, _rightFoot);
  return {
    left: _leftFoot.clone(),
    right: _rightFoot.clone(),
  };
})();

/** Root Y so standing soles sit on the grid (world y ≈ 0). */
export const ROOT_BASE_Y = -((referenceFeet.left.y + referenceFeet.right.y) * 0.5);

/** Derive pelvis drop, forward weight shift, and torso counter-lean from leg flexion. */
export function computeSquatTransform(
  left: LegPoseSample,
  right: LegPoseSample,
  options?: { mode?: string },
): SquatTransform {
  const depth = squatDepth(left, right);
  // Chair sit: keep torso more upright than a deep squat lean.
  const leanScale = options?.mode === "sitting" ? 0.22 : 1;
  const pelvisLeanRad = depth * SQUAT_TORSO_LEAN_MAX * DEG * leanScale;

  footInRootSpace(false, left, pelvisLeanRad, _leftFoot);
  footInRootSpace(true, right, pelvisLeanRad, _rightFoot);

  const rootY =
    ROOT_BASE_Y +
    (referenceFeet.left.y + referenceFeet.right.y) * 0.5 -
    (_leftFoot.y + _rightFoot.y) * 0.5;
  const rootZ =
    (referenceFeet.left.z + referenceFeet.right.z) * 0.5 -
    (_leftFoot.z + _rightFoot.z) * 0.5;

  return {
    depth,
    rootY,
    rootZ,
    pelvisLeanRad,
    headCounterLeanRad: -pelvisLeanRad * 0.42,
    armElevationOffset: depth * (options?.mode === "sitting" ? 12 : 40),
    armPlaneOffset: depth * (options?.mode === "sitting" ? 18 : 62),
  };
}
