import {
  ARM_REST,
  DEFAULT_CHANNEL_TO_POSE,
  isUpperKey,
  LIMB_PAIRS,
  LowerPoseKey,
  PoseKey,
  UPPER_KEYS,
} from "@/lib/pose";
import { createNeutralFrame, SensorFrame } from "@/lib/pose-physics";
import { computeSquatTransform } from "@/lib/mannequin-rig";

export type ChannelMap = Record<number, PoseKey>;

export type SensorChannelReading = {
  channel?: number;
  key?: string;
  calibrated?: number;
  degrees?: number;
};

export type PoseDefaultProfile = Record<string, { neutral?: number; min?: number; max?: number }>;

export type SensorMappingState = {
  channel_map: Record<string, string>;
  default_map: Record<string, string>;
  pose_defaults?: PoseDefaultProfile;
  pose_profiles?: Record<string, PoseDefaultProfile>;
  active_pose?: string;
  confidence: number;
  calibrated_at: number;
  calibration_step: string;
  calibration_steps: string[];
  buffer_samples: number;
  /** Live CH0–7 degrees from motion buffer (when available). */
  channel_degrees?: number[] | null;
};

const STORAGE_KEY = "rxsmart_sensor_channel_map";

export const POSE_PROFILE_LABELS: Record<string, string> = {
  standing: "ท่ายืนปกติ",
  sitting: "ท่านั่งปกติ",
};

export const CALIBRATION_STEP_LABELS: Record<string, string> = {
  neutral: "ยืนนิ่ง — แขนขาห้อยธรรมชาติ",
  move_forearms: "งอข้อศอกทั้งสองข้าง (ปลายแขนขยับ ไหล่นิ่ง) — ดู top 2 CH ที่ Δ≥10°",
  move_shoulders: "ยกไหล่ / ยกแขนทั้งสองข้าง",
  move_shins: "งอเข่าทั้งสองข้าง (ปลายขาขยับ)",
  move_thighs: "ยกขา / ขยับต้นขาทั้งสองข้าง",
  arms_down: "ห้อยแขนทั้งสองข้าง — จับค่า default (baseline)",
  arms_up_down: "ยกแขนขึ้น–ลงช้าๆ ทั้งสองข้าง — จับช่วง default",
};

/** What the wizard is collecting / when it writes disk for each guided step. */
export const CALIBRATION_STEP_SAVE_HINTS: Record<string, string> = {
  neutral: "ยืนนิ่ง — ค่านี้จะเป็น baseline ให้ขั้นถัดไปทั้งหมด (ยังไม่เขียนไฟล์)",
  move_forearms: "เทียบ baseline ขั้น 1 · ล็อก top 2 CH ที่ขยับ (Δ≥10°) ตอนกดถัดไป",
  move_shoulders: "ตัด CH ที่ล็อกจากขั้น 2 ออก · เลือก top 2 จากที่เหลือ",
  move_shins: "ตัด CH ที่ล็อกแล้วออก · เลือก top 2 จากที่เหลือ",
  move_thighs: "ตัด CH จากขั้น 4 ออก · ล็อกที่เหลือ แล้วเขียน channel_map",
  arms_down: "กำลังเก็บมุม baseline แขนห้อย — ยังไม่เขียน pose_defaults",
  arms_up_down: "หลังกดถัดไปจะเขียน pose_defaults (standing) ลง sensor_map.json",
};

export function calibratedToDegrees(calibrated: number): number {
  return Math.max(0, Math.min(180, Math.abs(calibrated) * (180 / 4095)));
}

export function parseChannelMap(raw: Record<string, string> | undefined): ChannelMap {
  if (!raw) return { ...DEFAULT_CHANNEL_TO_POSE };
  const result: ChannelMap = {};
  for (const [k, v] of Object.entries(raw)) {
    const ch = Number(k);
    if (Number.isNaN(ch) || ch < 0 || ch > 7) continue;
    result[ch] = v as PoseKey;
  }
  return Object.keys(result).length === 8 ? result : { ...DEFAULT_CHANNEL_TO_POSE };
}

export function loadStoredChannelMap(): ChannelMap {
  if (typeof window === "undefined") return { ...DEFAULT_CHANNEL_TO_POSE };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CHANNEL_TO_POSE };
    return parseChannelMap(JSON.parse(raw) as Record<string, string>);
  } catch {
    return { ...DEFAULT_CHANNEL_TO_POSE };
  }
}

export function saveStoredChannelMap(map: ChannelMap) {
  if (typeof window === "undefined") return;
  const payload: Record<string, string> = {};
  for (let ch = 0; ch < 8; ch++) {
    payload[String(ch)] = map[ch];
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function channelMapToRecord(map: ChannelMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (let ch = 0; ch < 8; ch++) {
    out[String(ch)] = map[ch];
  }
  return out;
}

export function sensorsToDegreesByChannel(sensors: SensorChannelReading[]): number[] | null {
  if (sensors.length < 8) return null;
  const byCh: number[] = Array.from({ length: 8 }, () => 0);
  for (let idx = 0; idx < sensors.length; idx++) {
    const s = sensors[idx];
    const ch = typeof s.channel === "number" ? s.channel : idx;
    if (ch < 0 || ch > 7) continue;
    byCh[ch] =
      typeof s.degrees === "number"
        ? s.degrees
        : typeof s.calibrated === "number"
          ? calibratedToDegrees(s.calibrated)
          : 0;
  }
  return byCh;
}

export function mapChannelsToFrame(degrees: number[], channelMap: ChannelMap): SensorFrame {
  const frame = createNeutralFrame();
  const byPose: Partial<Record<PoseKey, number>> = {};

  for (let ch = 0; ch < 8; ch++) {
    const poseKey = channelMap[ch];
    if (poseKey) byPose[poseKey] = degrees[ch];
  }

  for (const key of UPPER_KEYS) {
    if (byPose[key] !== undefined) {
      frame[key].elevation = byPose[key]!;
    }
  }

  const lowerByUpper: Record<string, LowerPoseKey> = {
    l_arm_upper: "l_arm_lower",
    r_arm_upper: "r_arm_lower",
    l_leg_upper: "l_leg_lower",
    r_leg_upper: "r_leg_lower",
  };

  for (const proxKey of UPPER_KEYS) {
    const distKey = lowerByUpper[proxKey];
    if (byPose[proxKey] !== undefined && byPose[distKey] !== undefined) {
      frame[distKey].bend = Math.max(
        0,
        Math.min(180, Math.abs(byPose[distKey]! - byPose[proxKey]!)),
      );
    }
  }

  return frame;
}

export function mapSensorsToFrame(
  sensors: SensorChannelReading[] | undefined,
  channelMap: ChannelMap,
): SensorFrame {
  const degrees = sensors ? sensorsToDegreesByChannel(sensors) : null;
  if (!degrees) return createNeutralFrame();
  return mapChannelsToFrame(degrees, channelMap);
}

const ARM_REST_ELEV = 8;
const LEG_ELEV_PLANE_THRESHOLD = 8;

function clampDeg(v: number, max = 180): number {
  return Math.min(max, Math.max(0, v));
}

function upperNeutral(
  poseDefaults: PoseDefaultProfile | undefined,
  armOrLeg: "arm" | "leg",
  side: "left" | "right",
): number | undefined {
  if (!poseDefaults) return undefined;
  if (armOrLeg === "arm") {
    const n = poseDefaults[`shoulder_${side}`]?.neutral;
    return typeof n === "number" ? n : undefined;
  }
  const hip = poseDefaults[`hip_${side}`]?.neutral;
  if (typeof hip === "number") return hip;
  const seg = poseDefaults[`${side === "left" ? "l" : "r"}_leg_upper`]?.neutral;
  return typeof seg === "number" ? seg : undefined;
}

function relativeElevation(raw: number, neutral: number | undefined, restBias = 0): number {
  if (typeof neutral !== "number") {
    // No baseline → rest pose only (avoid star-jump from absolute MPU degrees)
    return restBias;
  }
  return clampDeg(Math.abs(raw - neutral) + restBias);
}

/** Bend relative to pose_defaults neutral (same as Python apply_pose_defaults). */
function relativeBend(absoluteBend: number, neutral: number | undefined): number {
  if (typeof neutral !== "number") return clampDeg(absoluteBend);
  return clampDeg(Math.abs(absoluteBend - neutral));
}

function lowerNeutral(
  poseDefaults: PoseDefaultProfile | undefined,
  key: "elbow_left" | "elbow_right" | "knee_left" | "knee_right",
): number | undefined {
  const n = poseDefaults?.[key]?.neutral;
  return typeof n === "number" ? n : undefined;
}

function applyLegPlanesAndSquat(
  frame: SensorFrame,
  mode: "sitting" | "standing" | undefined,
): SensorFrame {
  let elevL = frame.l_leg_upper.elevation;
  let elevR = frame.r_leg_upper.elevation;
  let kneeL = frame.l_leg_lower.bend;
  let kneeR = frame.r_leg_lower.bend;

  if (mode === "sitting") {
    elevL = Math.max(elevL, 50);
    elevR = Math.max(elevR, 50);
    kneeL = Math.max(kneeL, 70);
    kneeR = Math.max(kneeR, 70);
    frame.l_leg_lower.bend = kneeL;
    frame.r_leg_lower.bend = kneeR;
  }

  const planeL = mode === "sitting" || elevL > LEG_ELEV_PLANE_THRESHOLD ? 90 : 0;
  const planeR = mode === "sitting" || elevR > LEG_ELEV_PLANE_THRESHOLD ? 90 : 0;
  frame.l_leg_upper.elevation = elevL;
  frame.l_leg_upper.plane = planeL;
  frame.r_leg_upper.elevation = elevR;
  frame.r_leg_upper.plane = planeR;

  const squat = computeSquatTransform(
    { elevation: elevL, plane: planeL, bend: kneeL },
    { elevation: elevR, plane: planeR, bend: kneeR },
    { mode },
  );
  frame.body = {
    rootY: squat.rootY,
    rootZ: squat.rootZ,
    mode: mode ?? "standing",
  };
  return frame;
}

export function mapJointsAndSensorsToFrame(
  joints: {
    elbow_left: number;
    elbow_right: number;
    knee_left: number;
    knee_right: number;
    shoulder_left?: number;
    shoulder_right?: number;
    sensors?: SensorChannelReading[];
    angles_relative?: {
      elbow_left?: number;
      elbow_right?: number;
      knee_left?: number;
      knee_right?: number;
      shoulder_left?: number;
      shoulder_right?: number;
      hip_left?: number;
      hip_right?: number;
    };
  } | null,
  channelMap: ChannelMap,
  activePose?: string,
  poseDefaults?: PoseDefaultProfile,
): SensorFrame {
  const mode = activePose === "sitting" || activePose === "standing" ? activePose : undefined;

  if (!joints) return createNeutralFrame();

  const degrees = joints.sensors ? sensorsToDegreesByChannel(joints.sensors) : null;

  if (degrees) {
    const frame = mapChannelsToFrame(degrees, channelMap);
    const byPose: Partial<Record<PoseKey, number>> = {};
    for (let ch = 0; ch < 8; ch++) {
      const key = channelMap[ch];
      if (key) byPose[key] = degrees[ch];
    }

    const rel = joints.angles_relative;
    const shNeutralL = upperNeutral(poseDefaults, "arm", "left");
    const shNeutralR = upperNeutral(poseDefaults, "arm", "right");

    // Always abs(raw − hang) for elevation — matches Python apply_pose_defaults.
    // Do not trust one-sided angles_relative.shoulder_* (can stick at 0 when pitch falls on raise).
    frame.l_arm_upper.elevation = relativeElevation(
      byPose.l_arm_upper ?? 0,
      shNeutralL,
      ARM_REST_ELEV,
    );
    frame.r_arm_upper.elevation = relativeElevation(
      byPose.r_arm_upper ?? 0,
      shNeutralR,
      ARM_REST_ELEV,
    );

    frame.l_leg_upper.elevation = relativeElevation(
      byPose.l_leg_upper ?? 0,
      upperNeutral(poseDefaults, "leg", "left"),
    );
    frame.r_leg_upper.elevation = relativeElevation(
      byPose.r_leg_upper ?? 0,
      upperNeutral(poseDefaults, "leg", "right"),
    );

    // Bends: prefer angles_relative (pose_defaults zero), else Δ from neutral, else absolute
    const hasRelOrDefaults = Boolean(rel) || Boolean(poseDefaults);
    if (hasRelOrDefaults) {
      frame.l_arm_lower.bend =
        rel?.elbow_left !== undefined
          ? clampDeg(rel.elbow_left)
          : relativeBend(frame.l_arm_lower.bend, lowerNeutral(poseDefaults, "elbow_left"));
      frame.r_arm_lower.bend =
        rel?.elbow_right !== undefined
          ? clampDeg(rel.elbow_right)
          : relativeBend(frame.r_arm_lower.bend, lowerNeutral(poseDefaults, "elbow_right"));
      frame.l_leg_lower.bend =
        rel?.knee_left !== undefined
          ? clampDeg(Math.min(140, rel.knee_left))
          : Math.min(140, relativeBend(frame.l_leg_lower.bend, lowerNeutral(poseDefaults, "knee_left")));
      frame.r_leg_lower.bend =
        rel?.knee_right !== undefined
          ? clampDeg(Math.min(140, rel.knee_right))
          : Math.min(140, relativeBend(frame.r_leg_lower.bend, lowerNeutral(poseDefaults, "knee_right")));
    }

    return applyLegPlanesAndSquat(frame, mode);
  }

  // Fallback: joint payload only (no per-channel sensors)
  const frame = createNeutralFrame();
  const rel = joints.angles_relative;
  frame.l_arm_upper.elevation = rel
    ? clampDeg(Math.abs(rel.shoulder_left ?? 0) + ARM_REST_ELEV)
    : relativeElevation(joints.shoulder_left ?? 0, upperNeutral(poseDefaults, "arm", "left"), ARM_REST_ELEV);
  frame.r_arm_upper.elevation = rel
    ? clampDeg(Math.abs(rel.shoulder_right ?? 0) + ARM_REST_ELEV)
    : relativeElevation(joints.shoulder_right ?? 0, upperNeutral(poseDefaults, "arm", "right"), ARM_REST_ELEV);
  frame.l_arm_lower.bend =
    rel?.elbow_left !== undefined
      ? clampDeg(rel.elbow_left)
      : relativeBend(joints.elbow_left, lowerNeutral(poseDefaults, "elbow_left"));
  frame.r_arm_lower.bend =
    rel?.elbow_right !== undefined
      ? clampDeg(rel.elbow_right)
      : relativeBend(joints.elbow_right, lowerNeutral(poseDefaults, "elbow_right"));
  frame.l_leg_lower.bend =
    rel?.knee_left !== undefined
      ? clampDeg(Math.min(140, rel.knee_left))
      : Math.min(140, relativeBend(joints.knee_left, lowerNeutral(poseDefaults, "knee_left")));
  frame.r_leg_lower.bend =
    rel?.knee_right !== undefined
      ? clampDeg(Math.min(140, rel.knee_right))
      : Math.min(140, relativeBend(joints.knee_right, lowerNeutral(poseDefaults, "knee_right")));
  frame.l_leg_upper.elevation =
    rel?.hip_left !== undefined
      ? clampDeg(Math.abs(rel.hip_left))
      : relativeElevation(0, upperNeutral(poseDefaults, "leg", "left"));
  frame.r_leg_upper.elevation =
    rel?.hip_right !== undefined
      ? clampDeg(Math.abs(rel.hip_right))
      : relativeElevation(0, upperNeutral(poseDefaults, "leg", "right"));
  return applyLegPlanesAndSquat(frame, mode);
}

// Re-export limb pairs for UI
export const LIMB_PAIR_KEYS = LIMB_PAIRS;

export function mappingSummary(map: ChannelMap): string {
  return Array.from({ length: 8 }, (_, ch) => `CH${ch}→${map[ch]?.replace("_", " ") ?? "?"}`).join(
    " · ",
  );
}

export function isUpperPoseKey(key: PoseKey): boolean {
  return isUpperKey(key);
}

/** Force upper-limb plane to rest — Live IMU cannot measure abduction plane. */
export function stripImuUnreachablePlane(frame: SensorFrame): SensorFrame {
  return {
    ...frame,
    l_arm_upper: { ...frame.l_arm_upper, plane: ARM_REST.plane },
    r_arm_upper: { ...frame.r_arm_upper, plane: ARM_REST.plane },
  };
}
