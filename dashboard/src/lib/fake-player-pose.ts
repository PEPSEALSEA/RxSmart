import { LOWER_JOINT_LIMITS, UPPER_JOINT_LIMITS } from "@/lib/biomechanics";
import { lerpFrames, resolvedPoseToFrame } from "@/lib/glb-pose-map";
import { isUpperKey, ResolvedPose } from "@/lib/pose";
import { SessionFeedback, SensorFrame } from "@/lib/pose-physics";
import { applyImuDisplayPlanes } from "@/lib/sensor-mapping";

function jointBlendGrade(feedback: SessionFeedback, key: SessionFeedback["activeJoints"][number]): number {
  const jf = feedback.jointFeedback[key];
  if (!jf || !jf.isActive) return 1;
  if (jf.angleOk) return 1;
  if (isUpperKey(key)) {
    const lim = UPPER_JOINT_LIMITS[key];
    const upper = jf as {
      elevationError: number;
      planeError: number;
    };
    const e = 1 - upper.elevationError / (lim.elevation.tolerance * 2);
    const p = 1 - upper.planeError / (lim.plane.tolerance * 2);
    return Math.max(0, Math.min(1, Math.min(e, p)));
  }
  const lim = LOWER_JOINT_LIMITS[key].bend;
  const lower = jf as { bendError: number };
  return Math.max(0, Math.min(1, 1 - lower.bendError / (lim.tolerance * 2)));
}

/** Average grade of active joints (0..1). Empty active → use session score. */
export function coachBlendFromFeedback(feedback: SessionFeedback): number {
  const keys = feedback.activeJoints;
  if (keys.length === 0) {
    return Math.max(0, Math.min(1, feedback.score / 100));
  }
  let sum = 0;
  let n = 0;
  for (const key of keys) {
    const jf = feedback.jointFeedback[key];
    if (!jf?.isActive) continue;
    sum += jointBlendGrade(feedback, key);
    n += 1;
  }
  if (n === 0) return Math.max(0, Math.min(1, feedback.score / 100));
  return sum / n;
}

/**
 * Player mannequin follows coach (ghost) by grade — not raw IMU channel plot.
 * Out of range → closer to default/start; in range → snaps toward coach.
 */
export function fakePlayerTowardCoach(
  ghostFrame: SensorFrame,
  defaultPose: ResolvedPose,
  feedback: SessionFeedback,
  options?: { imuMode?: boolean },
): SensorFrame {
  const defaultFrame = resolvedPoseToFrame(defaultPose);
  const status = feedback.status;

  if (status === "idle" || status === "rest" || status === "complete") {
    return options?.imuMode ? applyImuDisplayPlanes(defaultFrame, ghostFrame) : defaultFrame;
  }

  const blend = coachBlendFromFeedback(feedback);
  const lerped = lerpFrames(defaultFrame, ghostFrame, blend);
  return options?.imuMode ? applyImuDisplayPlanes(lerped, ghostFrame) : lerped;
}
