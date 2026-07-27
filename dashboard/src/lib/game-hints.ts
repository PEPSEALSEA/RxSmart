import { isUpperKey, planeLabel, PoseKey, POSE_LABELS } from "@/lib/pose";
import { JointFeedback, SessionFeedback } from "@/lib/pose-physics";

export type DirectionHint = {
  joint: PoseKey;
  label: string;
  arrow: "up" | "down" | "rotate-cw" | "rotate-ccw" | "bend-more" | "bend-less" | "ok";
  tip: string;
};

export type DirectionHintOptions = {
  /** Live IMU has no measurable plane — skip rotate tips. */
  ignorePlane?: boolean;
};

function imuReasonHint(feedback: SessionFeedback): DirectionHint | null {
  const reason = feedback.imuDiagnostics?.reason;
  if (!reason || feedback.status === "idle" || feedback.status === "complete") return null;
  const joint = (feedback.activeJoints[0] ?? "l_arm_upper") as PoseKey;
  const label = POSE_LABELS[joint] ?? joint;
  if (reason === "wrong_board") {
    return {
      joint,
      label,
      arrow: "up",
      tip: "ขยับบอร์ดที่แมปไว้ใน Wizard — บอร์ดอื่นนำอยู่",
    };
  }
  if (reason === "speed") {
    return {
      joint,
      label,
      arrow: "ok",
      tip: "ช้า/เร็วเกินไป — ปรับความเร็วให้นุ่ม",
    };
  }
  if (reason === "accel") {
    return {
      joint,
      label,
      arrow: "ok",
      tip: "กระตุกแรง — เคลื่อนไหวต่อเนื่อง",
    };
  }
  if (reason === "delta_height") {
    return {
      joint,
      label,
      arrow: "up",
      tip: "Δ ยังไม่ถึงเป้า — ยก/งอให้สูงขึ้นตามบอร์ดที่แมป",
    };
  }
  return null;
}

function upperHint(
  key: PoseKey,
  fb: JointFeedback,
  options?: DirectionHintOptions,
): DirectionHint | null {
  if (!isUpperKey(key) || !("elevationError" in fb) || !fb.isActive) return null;
  if (fb.angleOk) {
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: "ok",
      tip: options?.ignorePlane
        ? `Δ ${Math.round(fb.delta ?? fb.elevation)}° — มุมถูกต้อง`
        : "มุมถูกต้อง — ค้างท่า",
    };
  }
  if (fb.elevationError > 12) {
    const needUp = fb.targetElevation > fb.elevation;
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: needUp ? "up" : "down",
      tip: needUp
        ? `ยกขึ้นอีก ~${Math.round(fb.elevationError)}° (Δ ${Math.round(fb.delta ?? fb.elevation)}°)`
        : `ลดลงอีก ~${Math.round(fb.elevationError)}° (Δ ${Math.round(fb.delta ?? fb.elevation)}°)`,
    };
  }
  if (!options?.ignorePlane && fb.planeError > 18) {
    const delta = ((fb.targetPlane - fb.plane + 540) % 360) - 180;
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: delta > 0 ? "rotate-ccw" : "rotate-cw",
      tip: `หมุนไปทาง${planeLabel(fb.targetPlane)} (~${Math.round(Math.abs(delta))}°)`,
    };
  }
  if (options?.ignorePlane && fb.velocityOk === false) {
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: "ok",
      tip: "ความเร็วไม่เหมาะ — ไม่เร็ว/ช้าเกินไป",
    };
  }
  return {
    joint: key,
    label: POSE_LABELS[key],
    arrow: "up",
    tip: "ปรับมุมให้เข้าเป้า",
  };
}

function lowerHint(key: PoseKey, fb: JointFeedback, options?: DirectionHintOptions): DirectionHint | null {
  if (isUpperKey(key) || !("bendError" in fb) || !fb.isActive) return null;
  if (fb.angleOk) {
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: "ok",
      tip: options?.ignorePlane
        ? `Δ ${Math.round(fb.delta ?? fb.bend)}° — งอได้ตามเป้า`
        : "งอได้ตามเป้า",
    };
  }
  const needMore = fb.targetBend > fb.bend;
  return {
    joint: key,
    label: POSE_LABELS[key],
    arrow: needMore ? "bend-more" : "bend-less",
    tip: needMore
      ? `งออีก ~${Math.round(fb.bendError)}° (Δ ${Math.round(fb.delta ?? fb.bend)}°)`
      : `เหยียดอีก ~${Math.round(fb.bendError)}° (Δ ${Math.round(fb.delta ?? fb.bend)}°)`,
  };
}

export function buildDirectionHints(
  feedback: SessionFeedback,
  options?: DirectionHintOptions,
): DirectionHint[] {
  const hints: DirectionHint[] = [];
  if (options?.ignorePlane) {
    const imu = imuReasonHint(feedback);
    if (imu) hints.push(imu);
  }
  for (const key of feedback.activeJoints) {
    const fb = feedback.jointFeedback[key];
    if (!fb) continue;
    const hint = isUpperKey(key) ? upperHint(key, fb, options) : lowerHint(key, fb, options);
    if (hint) hints.push(hint);
  }
  return hints.slice(0, 3);
}
