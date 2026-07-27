import {
  CENTER_CHANNEL,
  CENTER_KEY,
  DEFAULT_CHANNEL_TO_POSE,
  isMappingKey,
  isPoseKey,
  isUpperKey,
  LIMB_CHANNEL_COUNT,
  LIMB_PAIRS,
  LowerPoseKey,
  MappingKey,
  PoseKey,
  SENSOR_COUNT,
  UPPER_KEYS,
} from "@/lib/pose";
import { createNeutralFrame, SensorFrame } from "@/lib/pose-physics";
import { computeSquatTransform } from "@/lib/mannequin-rig";

export type ChannelMap = Record<number, MappingKey>;

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
  /** Live CH0–CH8 degrees from motion buffer (when available). */
  channel_degrees?: number[] | null;
};

const STORAGE_KEY = "rxsmart_sensor_channel_map";

export const POSE_PROFILE_LABELS: Record<string, string> = {
  standing: "ท่ายืนปกติ",
  sitting: "ท่านั่งปกติ",
};

export const CALIBRATION_STEP_LABELS: Record<string, string> = {
  neutral: "ยืนนิ่ง — แขนขาห้อยธรรมชาติ (baseline + ตรวจ CH8)",
  l_elbow: "งอข้อศอกซ้ายอย่างเดียว (ข้างขวานิ่ง)",
  l_shoulder: "ยกแขนซ้ายอย่างเดียว",
  r_elbow: "งอข้อศอกขวาอย่างเดียว (ข้างซ้ายนิ่ง)",
  r_shoulder: "ยกแขนขวาอย่างเดียว",
  l_knee: "งอเข่าซ้ายอย่างเดียว",
  l_hip: "ยกขา / ต้นขาซ้ายอย่างเดียว",
  r_knee: "งอเข่าขวาอย่างเดียว",
  r_hip: "ยกขา / ต้นขาขวาอย่างเดียว",
  standing_hold: "ยืนห้อยแขนนิ่ง — จับ pose_defaults (standing + center)",
};

export const CALIBRATION_STEP_SAVE_HINTS: Record<string, string> = {
  neutral: "ยืนนิ่ง — baseline ให้ขั้นถัดไป · ตรวจว่ามีเซ็นเซอร์ครบ 9 รวม CH8",
  l_elbow: "ล็อก top 1 CH ที่ขยับ → ปลายแขนซ้าย (l_arm_lower)",
  l_shoulder: "ล็อก top 1 จากที่เหลือ → ต้นแขนซ้าย (l_arm_upper)",
  r_elbow: "ล็อก top 1 → ปลายแขนขวา (r_arm_lower)",
  r_shoulder: "ล็อก top 1 → ต้นแขนขวา (r_arm_upper)",
  l_knee: "ล็อก top 1 → ปลายขาซ้าย (l_leg_lower)",
  l_hip: "ล็อก top 1 → ต้นขาซ้าย (l_leg_upper)",
  r_knee: "ล็อก top 1 → ปลายขาขวา (r_leg_lower)",
  r_hip: "ล็อก top 1 → ต้นขาขวา แล้วเขียน channel_map (+ CH8 center)",
  standing_hold: "หลังกดถัดไปจะเขียน pose_defaults (standing) + center ลง sensor_map.json",
};

export const UNILATERAL_STEP_TO_POSE: Record<string, PoseKey> = {
  l_elbow: "l_arm_lower",
  l_shoulder: "l_arm_upper",
  r_elbow: "r_arm_lower",
  r_shoulder: "r_arm_upper",
  l_knee: "l_leg_lower",
  l_hip: "l_leg_upper",
  r_knee: "r_leg_lower",
  r_hip: "r_leg_upper",
};

export function swapPoseSidePairs(
  map: ChannelMap,
  pairs: [PoseKey, PoseKey][],
): ChannelMap {
  const next = ensureCenterInMap({ ...map });
  for (const [a, b] of pairs) {
    let chA: number | undefined;
    let chB: number | undefined;
    for (let ch = 0; ch < SENSOR_COUNT; ch++) {
      if (next[ch] === a) chA = ch;
      if (next[ch] === b) chB = ch;
    }
    if (chA === undefined || chB === undefined) continue;
    next[chA] = b;
    next[chB] = a;
  }
  return next;
}

export function swapArmSides(map: ChannelMap): ChannelMap {
  return swapPoseSidePairs(map, [
    ["l_arm_upper", "r_arm_upper"],
    ["l_arm_lower", "r_arm_lower"],
  ]);
}

export function swapLegSides(map: ChannelMap): ChannelMap {
  return swapPoseSidePairs(map, [
    ["l_leg_upper", "r_leg_upper"],
    ["l_leg_lower", "r_leg_lower"],
  ]);
}

export function calibratedToDegrees(calibrated: number): number {
  return Math.max(0, Math.min(180, Math.abs(calibrated) * (180 / 4095)));
}

export function ensureCenterInMap(map: ChannelMap): ChannelMap {
  const next: ChannelMap = { ...map };
  for (const [chStr, key] of Object.entries(next)) {
    if (key === CENTER_KEY && Number(chStr) !== CENTER_CHANNEL) {
      delete next[Number(chStr)];
    }
  }
  next[CENTER_CHANNEL] = CENTER_KEY;
  return next;
}

export function parseChannelMap(raw: Record<string, string> | undefined): ChannelMap {
  if (!raw) return { ...DEFAULT_CHANNEL_TO_POSE };
  const result: ChannelMap = {};
  for (const [k, v] of Object.entries(raw)) {
    const ch = Number(k);
    if (Number.isNaN(ch) || ch < 0 || ch >= SENSOR_COUNT) continue;
    if (!isMappingKey(v)) continue;
    result[ch] = v;
  }
  const limbKeys = Object.values(result).filter((k) => isPoseKey(k));
  if (limbKeys.length < LIMB_CHANNEL_COUNT) return { ...DEFAULT_CHANNEL_TO_POSE };
  return ensureCenterInMap(result);
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
  const full = ensureCenterInMap(map);
  for (let ch = 0; ch < SENSOR_COUNT; ch++) {
    payload[String(ch)] = full[ch] ?? DEFAULT_CHANNEL_TO_POSE[ch];
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function channelMapToRecord(map: ChannelMap): Record<string, string> {
  const out: Record<string, string> = {};
  const full = ensureCenterInMap(map);
  for (let ch = 0; ch < SENSOR_COUNT; ch++) {
    out[String(ch)] = full[ch] ?? DEFAULT_CHANNEL_TO_POSE[ch];
  }
  return out;
}

export function sensorsToDegreesByChannel(sensors: SensorChannelReading[]): number[] | null {
  if (sensors.length < LIMB_CHANNEL_COUNT) return null;
  const byCh: number[] = Array.from({ length: SENSOR_COUNT }, () => 0);
  for (let idx = 0; idx < sensors.length; idx++) {
    const s = sensors[idx];
    const ch = typeof s.channel === "number" ? s.channel : idx;
    if (ch < 0 || ch >= SENSOR_COUNT) continue;
    byCh[ch] =
      typeof s.degrees === "number"
        ? s.degrees
        : typeof s.calibrated === "number"
          ? calibratedToDegrees(s.calibrated)
          : 0;
  }
  return byCh;
}

function limbElevVsCenter(raw: number, centerDeg: number | undefined): number {
  if (centerDeg === undefined) return clampDeg(raw);
  return clampDeg(Math.abs(raw - centerDeg));
}

export function mapChannelsToFrame(degrees: number[], channelMap: ChannelMap): SensorFrame {
  const frame = createNeutralFrame();
  const byPose: Partial<Record<PoseKey, number>> = {};
  let centerDeg: number | undefined;

  for (let ch = 0; ch < SENSOR_COUNT; ch++) {
    const poseKey = channelMap[ch];
    if (!poseKey) continue;
    const deg = degrees[ch] ?? 0;
    if (poseKey === CENTER_KEY) {
      centerDeg = deg;
      continue;
    }
    if (isPoseKey(poseKey)) byPose[poseKey] = deg;
  }

  for (const key of UPPER_KEYS) {
    if (byPose[key] !== undefined) {
      frame[key].elevation = limbElevVsCenter(byPose[key]!, centerDeg);
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

  if (centerDeg !== undefined && frame.body) {
    frame.body.torsoTilt = centerDeg;
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
    torsoTilt: frame.body?.torsoTilt,
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
      center?: number;
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
    let centerRaw: number | undefined;
    for (let ch = 0; ch < SENSOR_COUNT; ch++) {
      const key = channelMap[ch];
      if (!key) continue;
      if (key === CENTER_KEY) {
        centerRaw = degrees[ch];
        continue;
      }
      if (isPoseKey(key)) byPose[key] = degrees[ch];
    }

    const rel = joints.angles_relative;
    const shNeutralL = upperNeutral(poseDefaults, "arm", "left");
    const shNeutralR = upperNeutral(poseDefaults, "arm", "right");

    frame.l_arm_upper.elevation = relativeElevation(
      limbElevVsCenter(byPose.l_arm_upper ?? 0, centerRaw),
      shNeutralL,
      ARM_REST_ELEV,
    );
    frame.r_arm_upper.elevation = relativeElevation(
      limbElevVsCenter(byPose.r_arm_upper ?? 0, centerRaw),
      shNeutralR,
      ARM_REST_ELEV,
    );

    frame.l_leg_upper.elevation = relativeElevation(
      limbElevVsCenter(byPose.l_leg_upper ?? 0, centerRaw),
      upperNeutral(poseDefaults, "leg", "left"),
    );
    frame.r_leg_upper.elevation = relativeElevation(
      limbElevVsCenter(byPose.r_leg_upper ?? 0, centerRaw),
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

    const centerNeutral = poseDefaults?.center?.neutral;
    if (centerRaw !== undefined && frame.body) {
      frame.body.torsoTilt =
        typeof centerNeutral === "number"
          ? clampDeg(Math.abs(centerRaw - centerNeutral))
          : typeof rel?.center === "number"
            ? clampDeg(Math.abs(rel.center))
            : centerRaw;
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
  return Array.from({ length: SENSOR_COUNT }, (_, ch) => `CH${ch}→${map[ch]?.replace("_", " ") ?? "?"}`).join(
    " · ",
  );
}

export function isUpperPoseKey(key: PoseKey): boolean {
  return isUpperKey(key);
}

export function applyImuDisplayPlanes(
  live: SensorFrame,
  reference: SensorFrame,
): SensorFrame {
  return {
    ...live,
    l_arm_upper: { ...live.l_arm_upper, plane: reference.l_arm_upper.plane },
    r_arm_upper: { ...live.r_arm_upper, plane: reference.r_arm_upper.plane },
    l_leg_upper: { ...live.l_leg_upper, plane: reference.l_leg_upper.plane },
    r_leg_upper: { ...live.r_leg_upper, plane: reference.r_leg_upper.plane },
  };
}
