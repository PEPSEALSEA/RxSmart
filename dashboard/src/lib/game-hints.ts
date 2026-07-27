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
      tip: "ขยับบอร์ดที่ตั้งไว้ — ตอนนี้บอร์ดอื่นขยับอยู่",
    };
  }
  if (reason === "speed") {
    return {
      joint,
      label,
      arrow: "ok",
      tip: "ช้าหรือเร็วเกินไป — ขยับให้นุ่มขึ้น",
    };
  }
  if (reason === "accel") {
    return {
      joint,
      label,
      arrow: "ok",
      tip: "กระตุกแรงไป — ขยับต่อเนื่องช้าๆ",
    };
  }
  if (reason === "delta_height") {
    return {
      joint,
      label,
      arrow: "up",
      tip: "ยังไม่ถึงเป้า — ยกหรืองอให้สูงขึ้นอีก",
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
        ? `มุมถูกแล้ว · ${Math.round(fb.delta ?? fb.elevation)}°`
        : "มุมถูกแล้ว — ค้างท่าไว้",
    };
  }
  if (fb.elevationError > 12) {
    const needUp = fb.targetElevation > fb.elevation;
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: needUp ? "up" : "down",
      tip: needUp
        ? `ยกขึ้นอีกประมาณ ${Math.round(fb.elevationError)} องศา`
        : `ลดลงอีกประมาณ ${Math.round(fb.elevationError)} องศา`,
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
        ? `งอถูกแล้ว · ${Math.round(fb.delta ?? fb.bend)}°`
        : "งอถูกแล้ว",
    };
  }
  const needMore = fb.targetBend > fb.bend;
  return {
    joint: key,
    label: POSE_LABELS[key],
    arrow: needMore ? "bend-more" : "bend-less",
    tip: needMore
      ? `งออีกประมาณ ${Math.round(fb.bendError)} องศา`
      : `เหยียดอีกประมาณ ${Math.round(fb.bendError)} องศา`,
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
