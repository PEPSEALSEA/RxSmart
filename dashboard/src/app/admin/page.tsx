"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import AdminDeviceModal from "@/components/admin/AdminDeviceModal";
import AdminSensorDebugGrid from "@/components/admin/AdminSensorDebugGrid";
import SensorReadout from "@/components/SensorReadout";
import FadeIn from "@/components/ui/FadeIn";
import { Device, formatLastSeen, getApiUrl, getErrorMessage, isDeviceOnline } from "@/lib/devices";
import { FIRMWARE_SENSOR_TO_POSE, isUpperKey, POSE_KEYS, POSE_LABELS, PoseKey } from "@/lib/pose";
import { REHAB_EXERCISES } from "@/lib/rehab-exercises";
import {
  buildSessionFeedback,
  createNeutralFrame,
  SensorFrame,
} from "@/lib/pose-physics";

const PoseViewer = dynamic(() => import("@/components/PoseViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[320px] items-center justify-center rounded-2xl border border-neutral-200 bg-neutral-50">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900" />
    </div>
  ),
});

type AdminTab = "devices" | "telemetry" | "commands" | "lab" | "system";

type DebugTelemetry = {
  timestamp: string;
  device_id: string;
  schema_version: number;
  session_id: string;
  session_state: string;
  exercise_id: string;
  payload_json: Record<string, unknown> | null;
  status: string;
  wifi_ssid: string;
};

type SavedDebugSample = {
  timestamp: string;
  device_id: string;
  pose_name: string;
  test_target: string;
  sensor_map: string;
  packet_json: string;
  notes: string;
};

type PoseTemplate = {
  created_at: string;
  pose_name: string;
  test_target: string;
  sensor_map: string;
  reference_json: string;
  device_id: string;
};

type PendingCommand = {
  command?: string;
  wifi_ssid?: string;
  session_id?: string;
  exercise_id?: string;
  rep_target?: number;
  [key: string]: unknown;
} | null;

type LatestSession = {
  session_id: string;
  device_id: string;
  exercise_id: string;
  state: string;
  started_at: string;
  ended_at: string;
  rep_target: number;
  rep_final: number;
};

type FirmwareInfo = {
  latest_version: string;
  bin_url: string;
};

const TABS: { id: AdminTab; label: string }[] = [
  { id: "devices", label: "อุปกรณ์" },
  { id: "telemetry", label: "Live Telemetry" },
  { id: "commands", label: "คำสั่ง & Session" },
  { id: "lab", label: "Debug Lab" },
  { id: "system", label: "ระบบ" },
];

function toDisplayAngle(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(180, value));
}

function mapTelemetryToFrame(payload: Record<string, unknown> | null): SensorFrame {
  const frame = createNeutralFrame();
  if (!payload) return frame;

  const angles = payload.angles as Record<string, unknown> | undefined;
  if (angles) {
    frame.l_arm_lower.bend = toDisplayAngle(angles.elbow_left);
    frame.r_arm_lower.bend = toDisplayAngle(angles.elbow_right);
    frame.l_leg_lower.bend = toDisplayAngle(angles.knee_left);
    frame.r_leg_lower.bend = toDisplayAngle(angles.knee_right);
  }

  const sensors = payload.sensors;
  if (Array.isArray(sensors)) {
    for (const item of sensors) {
      const sensor = item as { key?: string; calibrated?: number };
      const poseKey = sensor.key ? FIRMWARE_SENSOR_TO_POSE[sensor.key] : undefined;
      if (!poseKey || typeof sensor.calibrated !== "number") continue;
      const angle = Math.max(0, Math.min(180, Math.abs(sensor.calibrated) * (180 / 4095)));
      if (isUpperKey(poseKey)) {
        frame[poseKey].elevation = angle;
      } else {
        frame[poseKey].bend = angle;
      }
    }
  }

  return frame;
}

function payloadField(payload: Record<string, unknown> | null, path: string, fallback = "—"): string {
  if (!payload) return fallback;
  const parts = path.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (!current || typeof current !== "object") return fallback;
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined || current === null || current === "") return fallback;
  return String(current);
}

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>("devices");
  const [devices, setDevices] = useState<Device[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [devicesError, setDevicesError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [livePoll, setLivePoll] = useState(true);

  const [latestTelemetry, setLatestTelemetry] = useState<DebugTelemetry | null>(null);
  const [debugSamples, setDebugSamples] = useState<SavedDebugSample[]>([]);
  const [poseTemplates, setPoseTemplates] = useState<PoseTemplate[]>([]);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand>(null);
  const [latestSession, setLatestSession] = useState<LatestSession | null>(null);
  const [firmwareInfo, setFirmwareInfo] = useState<FirmwareInfo | null>(null);

  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState("");
  const [debugMessage, setDebugMessage] = useState("");

  const [loadingFix, setLoadingFix] = useState(false);
  const [fixMessage, setFixMessage] = useState("");
  const [fixError, setFixError] = useState("");

  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [exerciseId, setExerciseId] = useState("general");
  const [repTarget, setRepTarget] = useState(10);
  const [actionLoading, setActionLoading] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");

  const [poseName, setPoseName] = useState("");
  const [notes, setNotes] = useState("");
  const [testTarget, setTestTarget] = useState<PoseKey>("l_arm_upper");
  const [sensorAKey, setSensorAKey] = useState<PoseKey>("l_arm_upper");
  const [sensorBKey, setSensorBKey] = useState<PoseKey>("r_arm_upper");

  const apiUrl = getApiUrl();
  const activeDevice = useMemo(
    () => devices.find((d) => d.device_id === activeDeviceId) || null,
    [devices, activeDeviceId],
  );
  const selectedDevice = useMemo(
    () => devices.find((d) => d.device_id === selectedDeviceId) || null,
    [devices, selectedDeviceId],
  );
  const payload = latestTelemetry?.payload_json ?? null;
  const liveFrame = useMemo(() => mapTelemetryToFrame(payload), [payload]);
  const onlineCount = devices.filter((d) => isDeviceOnline(d.last_online, currentTime)).length;

  const mappedFeedback = useMemo(() => {
    const exercise = REHAB_EXERCISES[0];
    return buildSessionFeedback(liveFrame, exercise.startPose, exercise.phases[0], 0, exercise.reps, "idle");
  }, [liveFrame]);

  const fetchDevices = useCallback(async () => {
    setLoadingDevices(true);
    setDevicesError("");
    setCurrentTime(Date.now());
    try {
      const res = await fetch(`${apiUrl}/api/devices`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลดอุปกรณ์ไม่สำเร็จ");
      const nextDevices = data.devices || [];
      setDevices(nextDevices);
      setActiveDeviceId((current) => {
        if (current && nextDevices.some((d: Device) => d.device_id === current)) return current;
        return nextDevices[0]?.device_id || "";
      });
    } catch (err) {
      setDevicesError(getErrorMessage(err));
    } finally {
      setLoadingDevices(false);
    }
  }, [apiUrl]);

  const fetchDebugTelemetry = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    try {
      const res = await fetch(`${apiUrl}/api/debug/telemetry?device_id=${encodeURIComponent(deviceId)}&limit=1`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลด telemetry ไม่สำเร็จ");
      setLatestTelemetry((data.samples?.[0] || null) as DebugTelemetry | null);
      setDebugError("");
    } catch (err) {
      const message = getErrorMessage(err);
      if (message.includes("Quota exceeded") || message.includes("RESOURCE_EXHAUSTED")) {
        setDebugError("Google Sheets quota เต็มชั่วคราว — ลองใหม่ภายหลัง");
      } else {
        setDebugError(message);
      }
    }
  }, [apiUrl]);

  const fetchDebugSamples = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    try {
      const res = await fetch(`${apiUrl}/api/debug/samples?device_id=${encodeURIComponent(deviceId)}&limit=20`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลด samples ไม่สำเร็จ");
      setDebugSamples(data.samples || []);
    } catch (err) {
      setDebugError(getErrorMessage(err));
    }
  }, [apiUrl]);

  const fetchPoseTemplates = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/debug/poses?limit=20`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลด pose library ไม่สำเร็จ");
      setPoseTemplates(data.poses || []);
    } catch (err) {
      setDebugError(getErrorMessage(err));
    }
  }, [apiUrl]);

  const fetchPendingCommand = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    try {
      const res = await fetch(`${apiUrl}/api/commands?device_id=${encodeURIComponent(deviceId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลด command ไม่สำเร็จ");
      setPendingCommand(data.command ?? null);
    } catch (err) {
      setDebugError(getErrorMessage(err));
    }
  }, [apiUrl]);

  const fetchLatestSession = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    try {
      const res = await fetch(`${apiUrl}/api/sessions/latest?device_id=${encodeURIComponent(deviceId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลด session ไม่สำเร็จ");
      setLatestSession(data.session ?? null);
    } catch (err) {
      setLatestSession(null);
    }
  }, [apiUrl]);

  const fetchFirmware = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/firmware-version`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลด firmware ไม่สำเร็จ");
      setFirmwareInfo(data as FirmwareInfo);
    } catch {
      setFirmwareInfo(null);
    }
  }, [apiUrl]);

  const refreshAllDebug = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    await Promise.all([
      fetchDebugTelemetry(deviceId),
      fetchDebugSamples(deviceId),
      fetchPoseTemplates(),
      fetchPendingCommand(deviceId),
      fetchLatestSession(deviceId),
    ]);
  }, [fetchDebugTelemetry, fetchDebugSamples, fetchPoseTemplates, fetchPendingCommand, fetchLatestSession]);

  useEffect(() => {
    const bootstrap = setTimeout(() => {
      void fetchDevices();
      void fetchFirmware();
    }, 0);
    const interval = setInterval(() => void fetchDevices(), 30000);
    return () => {
      clearTimeout(bootstrap);
      clearInterval(interval);
    };
  }, [fetchDevices, fetchFirmware]);

  useEffect(() => {
    if (!activeDeviceId) return;
    const bootstrap = setTimeout(() => void refreshAllDebug(activeDeviceId), 0);
    if (!livePoll) return () => clearTimeout(bootstrap);

    const interval = setInterval(() => {
      void fetchDebugTelemetry(activeDeviceId);
      void fetchPendingCommand(activeDeviceId);
    }, 3000);
    return () => {
      clearTimeout(bootstrap);
      clearInterval(interval);
    };
  }, [activeDeviceId, livePoll, refreshAllDebug, fetchDebugTelemetry, fetchPendingCommand]);

  const openDevice = (device: Device) => {
    setSelectedDeviceId(device.device_id);
    setActiveDeviceId(device.device_id);
    setWifiSsid(device.wifi_ssid === "Unknown" ? "" : device.wifi_ssid);
    setWifiPassword("");
    setActionMessage("");
    setActionError("");
  };

  const fixSheet = async () => {
    setLoadingFix(true);
    setFixMessage("");
    setFixError("");
    try {
      const res = await fetch(`${apiUrl}/api/fix-sheet`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "fix-sheet ล้มเหลว");
      setFixMessage(data.message || "สำเร็จ");
    } catch (err) {
      setFixError(getErrorMessage(err));
    } finally {
      setLoadingFix(false);
    }
  };

  const queueCommand = async (
    command: "SET_WIFI" | "CLEAR_WIFI" | "START_SESSION" | "END_SESSION" | "RECALIBRATE",
    body: Record<string, string | number> = {},
    deviceId = selectedDevice?.device_id || activeDeviceId,
  ) => {
    if (!deviceId) return;
    setActionLoading(command);
    setActionMessage("");
    setActionError("");
    try {
      const res = await fetch(`${apiUrl}/api/devices/${encodeURIComponent(deviceId)}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "ส่ง command ไม่สำเร็จ");
      setActionMessage(data.message || "Command queued");
      await fetchPendingCommand(deviceId);
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setActionLoading("");
    }
  };

  const submitWifi = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await queueCommand("SET_WIFI", {
      wifi_ssid: wifiSsid.trim(),
      wifi_password: wifiPassword,
    });
  };

  const removeDevice = async () => {
    if (!selectedDevice) return;
    if (!confirm(`ลบ ${selectedDevice.device_id} จาก dashboard? (ไม่ลบบอร์ดจริง)`)) return;
    setActionLoading("REMOVE");
    setActionMessage("");
    setActionError("");
    try {
      const res = await fetch(`${apiUrl}/api/devices/${encodeURIComponent(selectedDevice.device_id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "ลบไม่สำเร็จ");
      setDevices((current) => current.filter((d) => d.device_id !== selectedDevice.device_id));
      setSelectedDeviceId(null);
      if (activeDeviceId === selectedDevice.device_id) {
        setActiveDeviceId("");
      }
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setActionLoading("");
    }
  };

  const captureSample = async () => {
    if (!activeDeviceId || !payload) {
      setDebugError("ยังไม่มี telemetry ให้บันทึก");
      return;
    }
    setDebugLoading(true);
    setDebugError("");
    setDebugMessage("");
    try {
      const res = await fetch(`${apiUrl}/api/debug/samples`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: activeDeviceId,
          pose_name: poseName.trim() || "debug-sample",
          test_target: testTarget,
          sensor_map: { sensorA: sensorAKey, sensorB: sensorBKey },
          packet: payload,
          notes: notes.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "บันทึก sample ไม่สำเร็จ");
      setDebugMessage("บันทึก sample แล้ว");
      await fetchDebugSamples(activeDeviceId);
    } catch (err) {
      setDebugError(getErrorMessage(err));
    } finally {
      setDebugLoading(false);
    }
  };

  const saveAsPoseTemplate = async () => {
    if (!activeDeviceId || !payload) {
      setDebugError("ยังไม่มี telemetry ให้สร้าง pose");
      return;
    }
    const name = poseName.trim();
    if (!name) {
      setDebugError("ต้องใส่ชื่อ pose");
      return;
    }
    setDebugLoading(true);
    setDebugError("");
    setDebugMessage("");
    try {
      const res = await fetch(`${apiUrl}/api/debug/poses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: activeDeviceId,
          pose_name: name,
          test_target: testTarget,
          sensor_map: { sensorA: sensorAKey, sensorB: sensorBKey },
          reference: payload,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "บันทึก pose ไม่สำเร็จ");
      setDebugMessage("เพิ่ม pose template แล้ว");
      await fetchPoseTemplates();
    } catch (err) {
      setDebugError(getErrorMessage(err));
    } finally {
      setDebugLoading(false);
    }
  };

  const alerts = Array.isArray(payload?.alerts) ? (payload?.alerts as Array<{ level?: string; code?: number }>) : [];
  const sensors = Array.isArray(payload?.sensors) ? payload.sensors : undefined;

  return (
    <main className="min-h-screen bg-[#fafafa] text-neutral-900">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <FadeIn>
          <header className="mb-6 flex flex-col gap-4 border-b border-neutral-200/80 pb-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-400">RxSmart Admin</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Therapist Debug Console</h1>
              <p className="mt-2 max-w-2xl text-sm text-neutral-500">
                ดู telemetry v2 ครบ 8 sensor · ส่งคำสั่ง ESP32 · บันทึก debug sample & pose library
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-center">
                <p className="text-[10px] uppercase tracking-wider text-neutral-400">Boards</p>
                <p className="font-mono text-lg font-semibold">{devices.length}</p>
              </div>
              <div className="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-center">
                <p className="text-[10px] uppercase tracking-wider text-neutral-400">Online</p>
                <p className="font-mono text-lg font-semibold text-emerald-600">{onlineCount}</p>
              </div>
              <Link
                href="/"
                className="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs font-medium text-neutral-600 transition hover:border-neutral-300"
              >
                หน้าผู้ใช้
              </Link>
            </div>
          </header>
        </FadeIn>

        <FadeIn delay={60}>
          <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 flex-wrap items-center gap-3">
              <label className="text-xs font-medium text-neutral-500">อุปกรณ์ที่ debug</label>
              <select
                value={activeDeviceId}
                onChange={(event) => setActiveDeviceId(event.target.value)}
                className="min-w-[200px] rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm"
              >
                <option value="">— เลือกบอร์ด —</option>
                {devices.map((device) => (
                  <option key={device.device_id} value={device.device_id}>
                    {device.device_id}
                  </option>
                ))}
              </select>
              {activeDevice && (
                <span
                  className={`text-xs font-medium ${
                    isDeviceOnline(activeDevice.last_online, currentTime)
                      ? "text-emerald-600"
                      : "text-neutral-400"
                  }`}
                >
                  {isDeviceOnline(activeDevice.last_online, currentTime) ? "● online" : "○ offline"}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setLivePoll((v) => !v)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  livePoll ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600"
                }`}
              >
                {livePoll ? "Live poll ON" : "Live poll OFF"}
              </button>
              <button
                type="button"
                onClick={() => activeDeviceId && void refreshAllDebug(activeDeviceId)}
                disabled={!activeDeviceId}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-40"
              >
                รีเฟรชทั้งหมด
              </button>
              <button
                type="button"
                onClick={fetchDevices}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
              >
                {loadingDevices ? "…" : "รีเฟรช devices"}
              </button>
            </div>
          </div>
        </FadeIn>

        <FadeIn delay={100}>
          <nav className="mb-6 flex flex-wrap gap-1 rounded-xl border border-neutral-200 bg-white p-1 shadow-sm">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`rounded-lg px-3 py-2 text-xs font-medium transition-all duration-300 ${
                  tab === item.id
                    ? "bg-neutral-900 text-white shadow-sm"
                    : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </FadeIn>

        {(debugMessage || debugError) && (
          <div className="mb-4 space-y-2">
            {debugMessage && (
              <p className="animate-fade-in-only rounded-xl bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
                {debugMessage}
              </p>
            )}
            {debugError && (
              <p className="animate-fade-in-only rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{debugError}</p>
            )}
          </div>
        )}

        {tab === "devices" && (
          <FadeIn delay={140} className="space-y-4">
            {devicesError && (
              <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{devicesError}</p>
            )}
            {loadingDevices && devices.length === 0 ? (
              <div className="flex h-40 items-center justify-center rounded-2xl border border-neutral-200 bg-white">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900" />
              </div>
            ) : devices.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-neutral-200 bg-white px-6 py-12 text-center text-sm text-neutral-400">
                ยังไม่มีบอร์ดในระบบ — flash ESP32 แล้วให้ register ผ่าน WiFi captive portal
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {devices.map((device, index) => {
                  const online = isDeviceOnline(device.last_online, currentTime);
                  const selected = activeDeviceId === device.device_id;
                  return (
                    <button
                      key={device.device_id}
                      type="button"
                      onClick={() => {
                        setActiveDeviceId(device.device_id);
                        openDevice(device);
                      }}
                      className={`animate-fade-in rounded-2xl border p-4 text-left transition-all duration-300 ${
                        selected
                          ? "border-neutral-900 bg-neutral-900 text-white shadow-md"
                          : "border-neutral-200 bg-white hover:border-neutral-300 hover:shadow-sm"
                      }`}
                      style={{ animationDelay: `${index * 40}ms` }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="break-all font-mono text-xs">{device.device_id}</p>
                        <span
                          className={`shrink-0 text-[10px] font-medium ${
                            selected
                              ? online
                                ? "text-emerald-300"
                                : "text-neutral-400"
                              : online
                                ? "text-emerald-600"
                                : "text-neutral-400"
                          }`}
                        >
                          {online ? "online" : "offline"}
                        </span>
                      </div>
                      <p className={`mt-3 text-xs ${selected ? "text-neutral-400" : "text-neutral-500"}`}>
                        WiFi: {device.wifi_ssid}
                      </p>
                      <p className={`mt-1 text-[10px] ${selected ? "text-neutral-500" : "text-neutral-400"}`}>
                        {formatLastSeen(device.last_online)}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </FadeIn>
        )}

        {tab === "telemetry" && (
          <FadeIn delay={140} className="space-y-6">
            {!activeDeviceId ? (
              <p className="rounded-2xl border border-dashed border-neutral-200 bg-white px-6 py-12 text-center text-sm text-neutral-400">
                เลือกอุปกรณ์ด้านบนก่อน
              </p>
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-3">
                  {[
                    { label: "Session", value: payloadField(payload, "session_state", latestTelemetry?.session_state) },
                    { label: "Exercise", value: payloadField(payload, "exercise_id", latestTelemetry?.exercise_id) },
                    { label: "Rep", value: `${payloadField(payload, "rep_count", "0")} / ${payloadField(payload, "rep_target", "—")}` },
                    { label: "Speed", value: `${payloadField(payload, "speed_dps", "0")} °/s` },
                    { label: "Posture", value: payloadField(payload, "posture.state") },
                    { label: "Stability", value: payloadField(payload, "posture.stability_score") },
                    { label: "Calibrated", value: payloadField(payload, "calibrated") },
                    { label: "Firmware", value: payloadField(payload, "firmware_version") },
                    { label: "Sensors", value: `${sensors?.length ?? 0}/8` },
                  ].map((item, index) => (
                    <div
                      key={item.label}
                      className="animate-fade-in rounded-xl border border-neutral-200 bg-white px-4 py-3"
                      style={{ animationDelay: `${index * 30}ms` }}
                    >
                      <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">{item.label}</p>
                      <p className="mt-1 font-mono text-sm font-semibold text-neutral-900">{item.value}</p>
                    </div>
                  ))}
                </div>

                {alerts.length > 0 && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
                    <p className="text-xs font-medium uppercase tracking-wider text-red-600">Alerts</p>
                    <div className="mt-2 space-y-1">
                      {alerts.map((alert, index) => (
                        <p key={index} className="font-mono text-sm text-red-800">
                          [{alert.level ?? "?"}] code={alert.code ?? "—"}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-semibold">3D Live Pose</h3>
                      <span className="text-[10px] text-neutral-400">
                        {latestTelemetry
                          ? new Date(latestTelemetry.timestamp).toLocaleTimeString("th-TH")
                          : "รอข้อมูล…"}
                      </span>
                    </div>
                    <div className="h-[360px]">
                      <PoseViewer frame={liveFrame} activeJoints={POSE_KEYS} />
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                    <h3 className="mb-3 text-sm font-semibold">มุมข้อต่อ (angles)</h3>
                    <dl className="grid grid-cols-2 gap-2 font-mono text-sm">
                      {[
                        ["elbow_left", "ข้อศอก ซ้าย"],
                        ["elbow_right", "ข้อศอก ขวา"],
                        ["knee_left", "เข่า ซ้าย"],
                        ["knee_right", "เข่า ขวา"],
                        ["primary", "primary"],
                      ].map(([key, label]) => (
                        <div key={key} className="rounded-xl bg-neutral-50 px-3 py-2">
                          <dt className="text-[10px] text-neutral-400">{label}</dt>
                          <dd className="font-semibold text-neutral-900">
                            {payloadField(payload, `angles.${key}`, "0")}°
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </div>

                <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                  <h3 className="mb-3 text-sm font-semibold">MPU6050 × 8 — Raw Debug</h3>
                  <AdminSensorDebugGrid sensors={sensors as Parameters<typeof AdminSensorDebugGrid>[0]["sensors"]} />
                </div>

                <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                  <h3 className="mb-3 text-sm font-semibold">Mapped Joints (dashboard scoring view)</h3>
                  <SensorReadout jointFeedback={mappedFeedback.jointFeedback} />
                </div>

                <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                  <h3 className="mb-2 text-sm font-semibold">Raw JSON (telemetry v2)</h3>
                  <pre className="max-h-80 overflow-auto rounded-xl bg-neutral-950 p-4 text-[11px] leading-relaxed text-neutral-300">
                    {payload ? JSON.stringify(payload, null, 2) : "ยังไม่มี packet"}
                  </pre>
                </div>
              </>
            )}
          </FadeIn>
        )}

        {tab === "commands" && (
          <FadeIn delay={140} className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold">ส่งคำสั่งไป ESP32</h3>
              <p className="mt-1 text-xs text-neutral-500">คำสั่งจะเข้าคิวใน Google Sheets — บอร์ด poll จาก cloud</p>

              {!activeDeviceId ? (
                <p className="mt-6 text-sm text-neutral-400">เลือกอุปกรณ์ก่อน</p>
              ) : (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="text-xs text-neutral-500">exercise_id</label>
                      <select
                        value={exerciseId}
                        onChange={(e) => setExerciseId(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                      >
                        <option value="general">general</option>
                        {REHAB_EXERCISES.map((ex) => (
                          <option key={ex.id} value={ex.id}>
                            {ex.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-neutral-500">rep_target</label>
                      <input
                        type="number"
                        min={1}
                        value={repTarget}
                        onChange={(e) => setRepTarget(Number(e.target.value) || 10)}
                        className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ["START_SESSION", "Start Session", "bg-emerald-600 text-white hover:bg-emerald-500"],
                        ["END_SESSION", "End Session", "bg-neutral-900 text-white hover:bg-neutral-800"],
                        ["RECALIBRATE", "Recalibrate", "border border-neutral-200 hover:bg-neutral-50"],
                      ] as const
                    ).map(([cmd, label, cls]) => (
                      <button
                        key={cmd}
                        type="button"
                        onClick={() =>
                          cmd === "START_SESSION"
                            ? void queueCommand(cmd, { exercise_id: exerciseId, rep_target: repTarget })
                            : void queueCommand(cmd)
                        }
                        disabled={actionLoading === cmd}
                        className={`rounded-xl px-3 py-2.5 text-xs font-medium disabled:opacity-50 ${cls}`}
                      >
                        {actionLoading === cmd ? "…" : label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => activeDevice && openDevice(activeDevice)}
                    className="w-full rounded-xl border border-neutral-200 px-3 py-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                  >
                    เปิด WiFi / Remove / คำสั่งเพิ่มเติม…
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <h3 className="text-sm font-semibold">Pending Command (poll queue)</h3>
                <pre className="mt-3 max-h-48 overflow-auto rounded-xl bg-neutral-950 p-3 text-[11px] text-neutral-300">
                  {pendingCommand ? JSON.stringify(pendingCommand, null, 2) : "ไม่มีคำสั่งค้าง"}
                </pre>
              </div>

              <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <h3 className="text-sm font-semibold">Latest Session (Sheets)</h3>
                {latestSession ? (
                  <dl className="mt-3 space-y-2 text-xs">
                    <div className="flex justify-between gap-2">
                      <dt className="text-neutral-400">session_id</dt>
                      <dd className="font-mono text-neutral-800">{latestSession.session_id}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-neutral-400">state</dt>
                      <dd>{latestSession.state}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-neutral-400">exercise</dt>
                      <dd>{latestSession.exercise_id}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-neutral-400">rep</dt>
                      <dd>
                        {latestSession.rep_final}/{latestSession.rep_target}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-3 text-xs text-neutral-400">ไม่มี session ล่าสุด</p>
                )}
              </div>
            </div>
          </FadeIn>
        )}

        {tab === "lab" && (
          <FadeIn delay={140} className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-3 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm lg:col-span-1">
              <h3 className="text-sm font-semibold">Capture & Pose Library</h3>
              <p className="text-xs text-neutral-500">บันทึก snapshot จาก telemetry จริง — 8 sensor ครบ</p>

              <label className="text-xs text-neutral-500">Test target</label>
              <select
                value={testTarget}
                onChange={(e) => setTestTarget(e.target.value as PoseKey)}
                className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
              >
                {POSE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {POSE_LABELS[key]}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-neutral-500">Sensor A</label>
                  <select
                    value={sensorAKey}
                    onChange={(e) => setSensorAKey(e.target.value as PoseKey)}
                    className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                  >
                    {POSE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {POSE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-neutral-500">Sensor B</label>
                  <select
                    value={sensorBKey}
                    onChange={(e) => setSensorBKey(e.target.value as PoseKey)}
                    className="mt-1 w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
                  >
                    {POSE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {POSE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <input
                value={poseName}
                onChange={(e) => setPoseName(e.target.value)}
                placeholder="ชื่อ pose / sample"
                className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
              />
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="notes"
                className="w-full rounded-xl border border-neutral-200 px-3 py-2 text-sm"
              />

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={captureSample}
                  disabled={debugLoading || !activeDeviceId}
                  className="rounded-xl bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  Save Sample
                </button>
                <button
                  type="button"
                  onClick={saveAsPoseTemplate}
                  disabled={debugLoading || !activeDeviceId}
                  className="rounded-xl border border-neutral-200 px-3 py-2 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  Add Pose
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold">Saved Samples</h3>
              <div className="mt-3 max-h-80 space-y-2 overflow-auto">
                {debugSamples.length === 0 ? (
                  <p className="text-xs text-neutral-400">ยังไม่มี</p>
                ) : (
                  debugSamples.map((sample, index) => (
                    <div key={`${sample.timestamp}-${index}`} className="rounded-xl border border-neutral-100 bg-neutral-50 p-2 text-xs">
                      <p className="font-medium text-neutral-800">{sample.pose_name || "debug-sample"}</p>
                      <p className="text-neutral-400">{new Date(sample.timestamp).toLocaleString("th-TH")}</p>
                      <p className="truncate text-neutral-500">{sample.test_target}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold">Pose Library</h3>
              <div className="mt-3 max-h-80 space-y-2 overflow-auto">
                {poseTemplates.length === 0 ? (
                  <p className="text-xs text-neutral-400">ยังไม่มี</p>
                ) : (
                  poseTemplates.map((pose, index) => (
                    <div key={`${pose.created_at}-${index}`} className="rounded-xl border border-neutral-100 bg-neutral-50 p-2 text-xs">
                      <p className="font-medium text-neutral-800">{pose.pose_name}</p>
                      <p className="text-neutral-500">{pose.test_target || "—"}</p>
                      <p className="text-neutral-400">{new Date(pose.created_at).toLocaleString("th-TH")}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </FadeIn>
        )}

        {tab === "system" && (
          <FadeIn delay={140} className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold">Google Sheets Auto-Fix</h3>
              <p className="mt-1 text-xs text-neutral-500">สร้าง header + tabs Devices, Commands, Sessions…</p>
              <button
                type="button"
                onClick={fixSheet}
                disabled={loadingFix}
                className="mt-4 w-full rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
              >
                {loadingFix ? "กำลังทำ…" : "Run Auto-Fix"}
              </button>
              {fixMessage && <p className="mt-3 text-xs text-emerald-600">{fixMessage}</p>}
              {fixError && <p className="mt-3 text-xs text-red-600">{fixError}</p>}
            </div>

            <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold">Firmware OTA</h3>
              {firmwareInfo ? (
                <dl className="mt-3 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-neutral-400">latest_version</dt>
                    <dd className="font-mono">{firmwareInfo.latest_version}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-neutral-400">bin_url</dt>
                    <dd className="truncate font-mono text-neutral-700">{firmwareInfo.bin_url || "—"}</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-xs text-neutral-400">โหลดไม่ได้</p>
              )}
            </div>

            <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm lg:col-span-2">
              <h3 className="text-sm font-semibold">API Endpoint</h3>
              <p className="mt-2 break-all font-mono text-xs text-neutral-600">{apiUrl}</p>
              <div className="mt-4 grid gap-2 text-[11px] text-neutral-500 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  "GET /api/devices",
                  "GET /api/debug/telemetry",
                  "POST /api/devices/{id}/command",
                  "GET /api/commands",
                  "GET /api/sessions/latest",
                  "POST /api/debug/samples",
                  "POST /api/fix-sheet",
                ].map((route) => (
                  <span key={route} className="rounded-lg bg-neutral-50 px-2 py-1 font-mono">
                    {route}
                  </span>
                ))}
              </div>
            </div>
          </FadeIn>
        )}
      </div>

      {selectedDevice && (
        <AdminDeviceModal
          device={selectedDevice}
          currentTime={currentTime}
          wifiSsid={wifiSsid}
          wifiPassword={wifiPassword}
          exerciseId={exerciseId}
          repTarget={repTarget}
          actionLoading={actionLoading}
          actionMessage={actionMessage}
          actionError={actionError}
          onClose={() => setSelectedDeviceId(null)}
          onWifiSsidChange={setWifiSsid}
          onWifiPasswordChange={setWifiPassword}
          onExerciseIdChange={setExerciseId}
          onRepTargetChange={setRepTarget}
          onSubmitWifi={submitWifi}
          onRefreshStatus={fetchDevices}
          onQueueCommand={(cmd, body) => void queueCommand(cmd, body ?? {})}
          onRemove={removeDevice}
        />
      )}
    </main>
  );
}
