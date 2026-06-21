import { createNeutralFrame, SensorFrame } from "@/lib/pose-physics";

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
  joints: LocalJointData | null;
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

export function bridgeFrameUrl(baseUrl: string, cacheBust = Date.now()) {
  return `${normalizeBase(baseUrl)}/api/frame.jpg?ts=${cacheBust}`;
}

export function mapLocalJointsToFrame(joints: LocalJointData | null): SensorFrame {
  const frame = createNeutralFrame();
  if (!joints) return frame;

  frame.l_arm_lower.bend = joints.elbow_left;
  frame.r_arm_lower.bend = joints.elbow_right;
  frame.l_leg_lower.bend = joints.knee_left;
  frame.r_leg_lower.bend = joints.knee_right;
  frame.l_arm_upper.elevation = Math.min(180, joints.shoulder_left);
  frame.r_arm_upper.elevation = Math.min(180, joints.shoulder_right);

  return frame;
}
