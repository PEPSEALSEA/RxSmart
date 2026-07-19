import {
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
  move_forearms: "งอข้อศอกทั้งสองข้าง (ปลายแขนขยับ ไหล่นิ่ง)",
  move_shoulders: "ยกไหล่ / ยกแขนทั้งสองข้าง",
  move_shins: "งอเข่าทั้งสองข้าง (ปลายขาขยับ)",
  move_thighs: "ยกขา / ขยับต้นขาทั้งสองข้าง",
  arms_down: "ห้อยแขนทั้งสองข้าง — จับค่า default (baseline)",
  arms_up_down: "ยกแขนขึ้น–ลงช้าๆ ทั้งสองข้าง — จับช่วง default",
};

/** What the wizard is collecting / when it writes disk for each guided step. */
export const CALIBRATION_STEP_SAVE_HINTS: Record<string, string> = {
  neutral: "กำลังเก็บตัวอย่างท่านิ่งในหน่วยความจำ — ยังไม่เขียนไฟล์",
  move_forearms: "กำลังเก็บว่า CH ไหนขยับตอนงอศอก — ยังไม่เขียนไฟล์",
  move_shoulders: "กำลังเก็บว่า CH ไหนขยับตอนยกไหล่ — ยังไม่เขียนไฟล์",
  move_shins: "กำลังเก็บว่า CH ไหนขยับตอนงอเข่า — ยังไม่เขียนไฟล์",
  move_thighs: "หลังกดถัดไปจะเขียน channel_map ลง sensor_map.json",
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
    };
  } | null,
  channelMap: ChannelMap,
  activePose?: string,
): SensorFrame {
  // Mannequin uses joint bends — never raw MPU channel degrees as elevation
  // (that produced star-jump poses).
  const frame = createNeutralFrame();
  if (!joints) return frame;

  const mode = activePose === "sitting" || activePose === "standing" ? activePose : undefined;
  const rel = joints.angles_relative;
  // Shoulders: prefer deviation-from-default so "at default pose" ≈ arms rest.
  const shL = rel
    ? Math.min(180, Math.max(0, (rel.shoulder_left ?? 0) + 8))
    : Math.min(180, Math.max(0, joints.shoulder_left ?? 0));
  const shR = rel
    ? Math.min(180, Math.max(0, (rel.shoulder_right ?? 0) + 8))
    : Math.min(180, Math.max(0, joints.shoulder_right ?? 0));

  frame.l_arm_upper.elevation = shL;
  frame.r_arm_upper.elevation = shR;
  frame.l_arm_lower.bend = joints.elbow_left;
  frame.r_arm_lower.bend = joints.elbow_right;

  // Live knees drive height; sitting mode raises a chair-sit floor so pelvis drops.
  let kneeL = Math.min(140, Math.max(0, joints.knee_left));
  let kneeR = Math.min(140, Math.max(0, joints.knee_right));
  if (mode === "sitting") {
    const relKnee =
      ((rel?.knee_left ?? 0) + (rel?.knee_right ?? 0)) * 0.5;
    // Near sitting default (rel≈0) → force chair sit; standing up raises rel → blend to live knees.
    const nearSitDefault = 1 - Math.min(1, relKnee / 55);
    const SIT_KNEE = 90;
    kneeL = kneeL * (1 - nearSitDefault) + Math.max(kneeL, SIT_KNEE) * nearSitDefault;
    kneeR = kneeR * (1 - nearSitDefault) + Math.max(kneeR, SIT_KNEE) * nearSitDefault;
  }

  frame.l_leg_lower.bend = kneeL;
  frame.r_leg_lower.bend = kneeR;

  // Thigh elevation from knee bend → sitting reads as seated, not a V-split.
  const elevScale = mode === "sitting" ? 0.78 : 0.65;
  const elevCap = mode === "sitting" ? 78 : 70;
  let elevL = Math.min(elevCap, kneeL * elevScale);
  let elevR = Math.min(elevCap, kneeR * elevScale);
  if (mode === "sitting") {
    elevL = Math.max(elevL, 58);
    elevR = Math.max(elevR, 58);
  }
  // plane 0 = lateral (V-spread); plane 90 = forward (chair sit / squat).
  const planeL = elevL > 5 || mode === "sitting" ? 90 : 0;
  const planeR = elevR > 5 || mode === "sitting" ? 90 : 0;
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

  void channelMap;
  return frame;
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
