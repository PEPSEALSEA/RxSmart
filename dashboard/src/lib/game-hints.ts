import { isUpperKey, planeLabel, PoseKey, POSE_LABELS } from "@/lib/pose";
import { JointFeedback, SessionFeedback } from "@/lib/pose-physics";

export type DirectionHint = {
  joint: PoseKey;
  label: string;
  arrow: "up" | "down" | "rotate-cw" | "rotate-ccw" | "bend-more" | "bend-less" | "ok";
  tip: string;
};

function upperHint(key: PoseKey, fb: JointFeedback): DirectionHint | null {
  if (!isUpperKey(key) || !("elevationError" in fb) || !fb.isActive) return null;
  if (fb.angleOk) {
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: "ok",
      tip: "มุมถูกต้อง — ค้างท่า",
    };
  }
  if (fb.elevationError > 12) {
    const needUp = fb.targetElevation > fb.elevation;
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: needUp ? "up" : "down",
      tip: needUp
        ? `ยกขึ้นอีก ~${Math.round(fb.elevationError)}°`
        : `ลดลงอีก ~${Math.round(fb.elevationError)}°`,
    };
  }
  if (fb.planeError > 18) {
    const delta = ((fb.targetPlane - fb.plane + 540) % 360) - 180;
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: delta > 0 ? "rotate-ccw" : "rotate-cw",
      tip: `หมุนไปทาง${planeLabel(fb.targetPlane)} (~${Math.round(Math.abs(delta))}°)`,
    };
  }
  return {
    joint: key,
    label: POSE_LABELS[key],
    arrow: "up",
    tip: "ปรับมุมให้เข้าเป้า",
  };
}

function lowerHint(key: PoseKey, fb: JointFeedback): DirectionHint | null {
  if (isUpperKey(key) || !("bendError" in fb) || !fb.isActive) return null;
  if (fb.angleOk) {
    return {
      joint: key,
      label: POSE_LABELS[key],
      arrow: "ok",
      tip: "งอได้ตามเป้า",
    };
  }
  const needMore = fb.targetBend > fb.bend;
  return {
    joint: key,
    label: POSE_LABELS[key],
    arrow: needMore ? "bend-more" : "bend-less",
    tip: needMore
      ? `งออีก ~${Math.round(fb.bendError)}°`
      : `เหยียดอีก ~${Math.round(fb.bendError)}°`,
  };
}

export function buildDirectionHints(feedback: SessionFeedback): DirectionHint[] {
  const hints: DirectionHint[] = [];
  for (const key of feedback.activeJoints) {
    const fb = feedback.jointFeedback[key];
    if (!fb) continue;
    const hint = isUpperKey(key) ? upperHint(key, fb) : lowerHint(key, fb);
    if (hint) hints.push(hint);
  }
  return hints.slice(0, 3);
}
