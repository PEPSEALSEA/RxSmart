import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getDatabase,
  ref,
  onValue,
  get,
  set,
  update,
  remove,
  push,
  Unsubscribe,
} from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyCHd_GuAIdOihuUA8gL2EzeAAk5m6zafrs",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "secret-timeloop-2026.firebaseapp.com",
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL || "https://secret-timeloop-2026-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "secret-timeloop-2026",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "secret-timeloop-2026.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "376101821454",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:376101821454:web:b6102bd6d12d0ae6f0305f",
};

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const rtdb = getDatabase(app);

export interface FirebaseDeviceInfo {
  device_id: string;
  platform?: string;
  firmware_version?: string;
  wifi_ssid?: string;
  last_online?: number | string;
}

export interface FirebaseLiveTelemetry {
  ts: number;
  device_id: string;
  status: string;
  calibrated: boolean;
  session_id: string;
  session_state: string;
  exercise_id: string;
  rep_target: number;
  rep_count: number;
  angles?: {
    elbow_left?: number;
    elbow_right?: number;
    knee_left?: number;
    knee_right?: number;
    primary?: number;
  };
  speed_dps?: number;
  posture?: {
    state?: string;
    fault_mask?: number;
    stability_score?: number;
  };
  injury_alert?: boolean;
  alert_level?: string;
  alert_code?: number;
}

export interface FirebaseCommand {
  command: string;
  exercise_id?: string;
  rep_target?: number;
  wifi_ssid?: string;
  wifi_password?: string;
  consumed: boolean;
  timestamp: number;
  executed_at?: number;
}

export interface FirebaseSessionRecord {
  session_id: string;
  device_id: string;
  exercise_id: string;
  state: string;
  rep_final: number;
  rep_target: number;
  started_at: number;
  completed_at: number;
  posture_fault_mask?: number;
  backed_up_to_sheets?: boolean;
}

// Subscribe to all devices
export function subscribeDevices(callback: (devices: Record<string, { info?: FirebaseDeviceInfo; live?: FirebaseLiveTelemetry }>) => void): Unsubscribe {
  const devicesRef = ref(rtdb, "rxsmart/devices");
  return onValue(devicesRef, (snapshot) => {
    const val = snapshot.val() || {};
    callback(val);
  });
}

// Subscribe to live telemetry of a specific device
export function subscribeLiveTelemetry(deviceId: string, callback: (telemetry: FirebaseLiveTelemetry | null) => void): Unsubscribe {
  const liveRef = ref(rtdb, `rxsmart/devices/${deviceId}/live`);
  return onValue(liveRef, (snapshot) => {
    callback(snapshot.val());
  });
}

// Send command to device
export async function sendDeviceCommand(deviceId: string, command: Omit<FirebaseCommand, "consumed" | "timestamp">): Promise<void> {
  const cmdRef = ref(rtdb, `rxsmart/devices/${deviceId}/command`);
  await set(cmdRef, {
    ...command,
    consumed: false,
    timestamp: Date.now(),
  });
}

// Subscribe to sessions
export function subscribeSessions(callback: (sessions: Record<string, FirebaseSessionRecord>) => void): Unsubscribe {
  const sessionsRef = ref(rtdb, "rxsmart/sessions");
  return onValue(sessionsRef, (snapshot) => {
    callback(snapshot.val() || {});
  });
}

// Add debug sample
export async function pushDebugSample(sample: Record<string, any>): Promise<void> {
  const samplesRef = ref(rtdb, "rxsmart/debug_samples");
  await push(samplesRef, {
    ...sample,
    created_at: Date.now(),
  });
}

// Add debug pose
export async function pushDebugPose(pose: Record<string, any>): Promise<void> {
  const posesRef = ref(rtdb, "rxsmart/debug_poses");
  await push(posesRef, {
    ...pose,
    created_at: Date.now(),
  });
}
