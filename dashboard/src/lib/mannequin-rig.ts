import { SEGMENT_LENGTHS } from "@/lib/biomechanics";
import { shortestPlaneDelta, upperLimbDirection } from "@/lib/pose";

/** กล่องลำตัว (ขยายเล็กน้อยจาก mesh จริง) สำหรับกันทะลุตอน render */
const TORSO = {
  cx: 0,
  cy: 1.22,
  cz: 0,
  hx: 0.2,
  hy: 0.29,
  hz: 0.12,
} as const;

const L_SHOULDER = {
  x: -SEGMENT_LENGTHS.shoulderWidth,
  y: 1.48,
  z: 0.04,
} as const;

const R_SHOULDER = {
  x: SEGMENT_LENGTHS.shoulderWidth,
  y: 1.48,
  z: 0.04,
} as const;

/** ความยาว upper arm + forearm โดยประมาณ (ใช้ตรวจ collision คร่าวๆ) */
const ARM_REACH = SEGMENT_LENGTHS.upperArm + SEGMENT_LENGTHS.forearm * 0.82;

function samplePenetratesTorso(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  length: number,
): boolean {
  for (const t of [0.32, 0.58, 0.86]) {
    const px = ox + dx * length * t;
    const py = oy + dy * length * t;
    const pz = oz + dz * length * t;
    if (
      Math.abs(px - TORSO.cx) < TORSO.hx &&
      Math.abs(py - TORSO.cy) < TORSO.hy &&
      Math.abs(pz - TORSO.cz) < TORSO.hz
    ) {
      return true;
    }
  }
  return false;
}

export function armPenetratesTorso(isRight: boolean, elevation: number, plane: number): boolean {
  const origin = isRight ? R_SHOULDER : L_SHOULDER;
  const [dx, dy, dz] = upperLimbDirection(isRight, elevation, plane);
  return samplePenetratesTorso(origin.x, origin.y, origin.z, dx, dy, dz, ARM_REACH);
}

/**
 * ปรับมุมแขนสำหรับ 3D viewer เท่านั้น — หลีกเลี่ยงทะลุลำตัว
 * คงค่า sensor/physics เดิม แต่ visual จะ arc ไปด้านนอก
 */
export function resolveVisualArmPose(
  isRight: boolean,
  elevation: number,
  plane: number,
): { elevation: number; plane: number } {
  if (!armPenetratesTorso(isRight, elevation, plane)) {
    return { elevation, plane };
  }

  let best = { elevation, plane };
  let bestCost = Infinity;

  for (let de = 0; de <= 100; de += 5) {
    for (let dp = -120; dp <= 120; dp += 10) {
      const e = Math.min(180, elevation + de);
      const p = ((plane + dp) % 360 + 360) % 360;
      if (armPenetratesTorso(isRight, e, p)) continue;

      const cost =
        Math.abs(e - elevation) * 1.1 +
        Math.abs(shortestPlaneDelta(plane, p)) * 0.85 +
        (de > 0 ? de * 0.08 : 0);

      if (cost < bestCost) {
        bestCost = cost;
        best = { elevation: e, plane: p };
      }
    }
  }

  if (bestCost === Infinity) {
    return { elevation: Math.min(175, elevation + 55), plane: 92 };
  }

  return best;
}
