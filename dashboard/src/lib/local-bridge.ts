import { createNeutralFrame, SensorFrame } from "@/lib/pose-physics";
import type { MediaPipeHandSet, MediaPipeLandmark } from "@/lib/mediapipe-pose";
import {
  ChannelMap,
  mapJointsAndSensorsToFrame,
  parseChannelMap,
  SensorChannelReading,
  SensorMappingState,
} from "@/lib/sensor-mapping";

export type { MediaPipeHandSet, MediaPipeLandmark } from "@/lib/mediapipe-pose";

export type LocalBridgeMode = "CAMERA_ONLY" | "IOT_ONLY" | "FUSION";

export type LocalJointData = {
  elbow_left: number;
  elbow_right: number;
  knee_left: number;
  knee_right: number;
  shoulder_left: number;
  shoulder_right: number;
  source: string;
  confidence: number;
  posture_state?: string;
  rep_count?: number;
  rep_target?: number;
  speed_dps?: number;
  session_state?: string;
  alert_level?: string;
  hand_left_detected?: boolean;
  hand_right_detected?: boolean;
  palm_left_facing?: string;
  palm_right_facing?: string;
  palm_left_ok?: boolean;
  palm_right_ok?: boolean;
  fingers_left_extended?: boolean;
  fingers_right_extended?: boolean;
  fingers_left_straight?: boolean;
  fingers_right_straight?: boolean;
  finger_left_straight_score?: number;
  finger_right_straight_score?: number;
  sensors?: SensorChannelReading[];
  sensor_map?: Record<string, string>;
};

export type LocalBridgeState = {
  ok: boolean;
  ts: number;
  mode: LocalBridgeMode;
  camera_status: string;
  iot_status: string;
  camera_fps: number;
  camera_latency_ms: number;
  iot_poll_rate_hz: number;
  iot_latency_ms: number;
  fusion_alpha: number;
  has_frame: boolean;
  skeleton_debug: boolean;
  pose_count: number;
  max_poses: number;
  pose_landmarks: MediaPipeLandmark[] | null;
  hand_landmarks: MediaPipeHandSet[];
  joints: LocalJointData | null;
  sensor_mapping?: SensorMappingState;
};

const STORAGE_KEY = "rxsmart_local_bridge_url";

export function getDefaultBridgeUrl() {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LOCAL_BRIDGE_URL) {
    return process.env.NEXT_PUBLIC_LOCAL_BRIDGE_URL;
  }
  return "http://127.0.0.1:8766";
}

export function loadBridgeUrl() {
  if (typeof window === "undefined") return getDefaultBridgeUrl();
  return window.localStorage.getItem(STORAGE_KEY) || getDefaultBridgeUrl();
}

export function saveBridgeUrl(url: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, url.replace(/\/$/, ""));
}

function normalizeBase(url: string) {
  return url.trim().replace(/\/$/, "");
}

export async function pingBridge(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeBase(baseUrl)}/api/health`, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

export async function fetchBridgeState(baseUrl: string): Promise<LocalBridgeState> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/state`, {
    method: "GET",
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "โหลด local bridge ไม่สำเร็จ");
  return data as LocalBridgeState;
}

export async function setBridgeMode(baseUrl: string, mode: LocalBridgeMode) {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "สลับโหมดไม่สำเร็จ");
  return data;
}

export async function setBridgeSkeletonDebug(baseUrl: string, enabled: boolean) {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/debug`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skeleton_debug: enabled }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "สลับ skeleton debug ไม่สำเร็จ");
  return data;
}

export function bridgeFrameUrl(baseUrl: string, cacheBust = Date.now()) {
  return `${normalizeBase(baseUrl)}/api/frame.jpg?ts=${cacheBust}`;
}

export function mapLocalJointsToFrame(
  joints: LocalJointData | null,
  channelMap?: ChannelMap,
): SensorFrame {
  const map = channelMap ?? parseChannelMap(joints?.sensor_map);
  return mapJointsAndSensorsToFrame(joints, map);
}

export type BridgeLiveTelemetry = {
  session_state?: "idle" | "calibrate" | "exercise" | "complete";
  rep_count?: number;
  rep_target?: number;
  speed_dps?: number;
  posture?: { state?: "correct" | "incorrect" };
  angles?: {
    elbow_left?: number;
    elbow_right?: number;
    knee_left?: number;
    knee_right?: number;
  };
  sensors?: Array<{ key?: string; calibrated?: number; channel?: number; degrees?: number }>;
  sensor_map?: Record<string, string>;
};

export function mapBridgeToLiveTelemetry(state: LocalBridgeState): BridgeLiveTelemetry | null {
  const joints = state.joints;
  if (!joints) return null;

  const sessionState = joints.session_state as BridgeLiveTelemetry["session_state"] | undefined;

  return {
    session_state: sessionState,
    rep_count: joints.rep_count,
    rep_target: joints.rep_target,
    speed_dps: joints.speed_dps,
    posture: {
      state: joints.posture_state === "correct" ? "correct" : "incorrect",
    },
    angles: {
      elbow_left: joints.elbow_left,
      elbow_right: joints.elbow_right,
      knee_left: joints.knee_left,
      knee_right: joints.knee_right,
    },
    sensors: joints.sensors,
    sensor_map: joints.sensor_map,
  };
}

export async function fetchSensorMapping(baseUrl: string): Promise<SensorMappingState> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/sensor-map`, {
    method: "GET",
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "โหลด sensor map ไม่สำเร็จ");
  return data as SensorMappingState;
}

export async function postSensorMappingAction(
  baseUrl: string,
  action: "reset" | "auto_recheck" | "calibrate_start" | "calibrate_next" | "set",
  channelMap?: Record<string, string>,
) {
  const body: Record<string, unknown> = { action };
  if (action === "set" && channelMap) {
    body.channel_map = channelMap;
  }
  const res = await fetch(`${normalizeBase(baseUrl)}/api/sensor-map`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "sensor map action ไม่สำเร็จ");
  return data;
}
