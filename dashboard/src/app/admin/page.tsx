"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Device, getApiUrl, getErrorMessage, isDeviceOnline } from "@/lib/devices";
import { FIRMWARE_SENSOR_TO_POSE, isUpperKey, POSE_KEYS, POSE_LABELS, PoseKey } from "@/lib/pose";
import { createNeutralFrame, SensorFrame } from "@/lib/pose-physics";

const PoseViewer = dynamic(() => import("@/components/PoseViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[360px] items-center justify-center rounded-2xl border border-white/10 bg-slate-900/50">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-slate-700 border-t-indigo-400" />
    </div>
  ),
});

type DebugTelemetry = {
  timestamp: string;
  device_id: string;
  schema_version: number;
  session_id: string;
  session_state: string;
  exercise_id: string;
  payload_json: {
    sensors?: Array<{ key?: string; calibrated?: number }>;
    angles?: {
      elbow_left?: number;
      elbow_right?: number;
      knee_left?: number;
      knee_right?: number;
    };
    rep_count?: number;
    speed_dps?: number;
    posture?: {
      state?: string;
    };
    [key: string]: unknown;
  } | null;
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

function toDisplayAngle(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(180, value));
}

function mapTelemetryToFrame(payload: DebugTelemetry["payload_json"]): SensorFrame {
  const frame = createNeutralFrame();
  if (!payload) return frame;

  if (payload.angles) {
    frame.l_arm_lower.bend = toDisplayAngle(payload.angles.elbow_left);
    frame.r_arm_lower.bend = toDisplayAngle(payload.angles.elbow_right);
    frame.l_leg_lower.bend = toDisplayAngle(payload.angles.knee_left);
    frame.r_leg_lower.bend = toDisplayAngle(payload.angles.knee_right);
  }

  if (Array.isArray(payload.sensors)) {
    for (const sensor of payload.sensors) {
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

export default function AdminPage() {
  const [loadingFix, setLoadingFix] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [devicesError, setDevicesError] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState("");
  const [debugMessage, setDebugMessage] = useState("");
  const [latestTelemetry, setLatestTelemetry] = useState<DebugTelemetry | null>(null);
  const [debugSamples, setDebugSamples] = useState<SavedDebugSample[]>([]);
  const [poseTemplates, setPoseTemplates] = useState<PoseTemplate[]>([]);
  const [debugDeviceId, setDebugDeviceId] = useState("");
  const [poseName, setPoseName] = useState("");
  const [notes, setNotes] = useState("");
  const [testTarget, setTestTarget] = useState<PoseKey>("l_arm_upper");
  const [sensorAKey, setSensorAKey] = useState<PoseKey>("l_arm_upper");
  const [sensorBKey, setSensorBKey] = useState<PoseKey>("r_arm_upper");

  const apiUrl = getApiUrl();
  const selectedDevice = useMemo(
    () => devices.find((device) => device.device_id === selectedDeviceId) || null,
    [devices, selectedDeviceId],
  );
  const liveFrame = useMemo(() => mapTelemetryToFrame(latestTelemetry?.payload_json ?? null), [latestTelemetry]);

  const fetchDevices = useCallback(async () => {
    setLoadingDevices(true);
    setDevicesError("");
    setCurrentTime(Date.now());
    try {
      const res = await fetch(`${apiUrl}/api/devices`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch devices");
      const nextDevices = data.devices || [];
      setDevices(nextDevices);
      setDebugDeviceId((current) => {
        if (current && nextDevices.some((device: Device) => device.device_id === current)) return current;
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
      if (!res.ok) throw new Error(data.error || "Failed to fetch telemetry");
      const latest = (data.samples?.[0] || null) as DebugTelemetry | null;
      setLatestTelemetry(latest);
    } catch (err) {
      const message = getErrorMessage(err);
      if (message.includes("Quota exceeded") || message.includes("RESOURCE_EXHAUSTED")) {
        setDebugError("Google Sheets quota ชั่วคราวเต็ม ระบบจะอ่านข้อมูลช้าลงอัตโนมัติ");
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
      if (!res.ok) throw new Error(data.error || "Failed to fetch samples");
      setDebugSamples(data.samples || []);
    } catch (err) {
      setDebugError(getErrorMessage(err));
    }
  }, [apiUrl]);

  const fetchPoseTemplates = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/debug/poses?limit=20`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch pose templates");
      setPoseTemplates(data.poses || []);
    } catch (err) {
      setDebugError(getErrorMessage(err));
    }
  }, [apiUrl]);

  useEffect(() => {
    const initialLoad = setTimeout(() => {
      void fetchDevices();
    }, 0);
    const interval = setInterval(() => {
      void fetchDevices();
    }, 30000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [fetchDevices]);

  useEffect(() => {
    if (!debugDeviceId) return;
    const bootstrap = setTimeout(() => {
      void fetchPoseTemplates();
      void fetchDebugTelemetry(debugDeviceId);
      void fetchDebugSamples(debugDeviceId);
    }, 0);
    const interval = setInterval(() => {
      void fetchDebugTelemetry(debugDeviceId);
    }, 4000);
    return () => {
      clearTimeout(bootstrap);
      clearInterval(interval);
    };
  }, [debugDeviceId, fetchDebugTelemetry, fetchDebugSamples, fetchPoseTemplates]);

  const openDevice = (device: Device) => {
    setSelectedDeviceId(device.device_id);
    setWifiSsid(device.wifi_ssid === "Unknown" ? "" : device.wifi_ssid);
    setWifiPassword("");
    setActionMessage("");
    setActionError("");
  };

  const fixSheet = async () => {
    setLoadingFix(true);
    setMessage("");
    setError("");

    try {
      const res = await fetch(`${apiUrl}/api/fix-sheet`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fix sheet");
      setMessage(data.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoadingFix(false);
    }
  };

  const queueCommand = async (
    command: "SET_WIFI" | "CLEAR_WIFI" | "START_SESSION" | "END_SESSION" | "RECALIBRATE",
    body: Record<string, string | number> = {},
  ) => {
    if (!selectedDevice) return;

    setActionLoading(command);
    setActionMessage("");
    setActionError("");

    try {
      const res = await fetch(`${apiUrl}/api/devices/${encodeURIComponent(selectedDevice.device_id)}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to queue command");
      setActionMessage(data.message || "Command queued.");
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
    if (!confirm(`Remove ${selectedDevice.device_id} from the dashboard? This does not erase the physical board.`)) return;

    setActionLoading("REMOVE");
    setActionMessage("");
    setActionError("");

    try {
      const res = await fetch(`${apiUrl}/api/devices/${encodeURIComponent(selectedDevice.device_id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to remove board");
      setDevices((current) => current.filter((device) => device.device_id !== selectedDevice.device_id));
      setSelectedDeviceId(null);
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setActionLoading("");
    }
  };

  const checkSelectedStatus = async () => {
    await fetchDevices();
    setActionMessage("Status refreshed from the dashboard data.");
  };

  const captureSample = async () => {
    if (!debugDeviceId || !latestTelemetry) {
      setDebugError("No telemetry available to capture yet.");
      return;
    }
    setDebugLoading(true);
    setDebugError("");
    setDebugMessage("");
    try {
      const sensorMap = { sensorA: sensorAKey, sensorB: sensorBKey };
      const res = await fetch(`${apiUrl}/api/debug/samples`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: debugDeviceId,
          pose_name: poseName.trim() || "debug-sample",
          test_target: testTarget,
          sensor_map: sensorMap,
          packet: latestTelemetry.payload_json,
          notes: notes.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save sample");
      setDebugMessage("Saved sample snapshot.");
      await fetchDebugSamples(debugDeviceId);
    } catch (err) {
      setDebugError(getErrorMessage(err));
    } finally {
      setDebugLoading(false);
    }
  };

  const saveAsPoseTemplate = async () => {
    if (!debugDeviceId || !latestTelemetry) {
      setDebugError("No telemetry available to create pose.");
      return;
    }
    const normalizedPoseName = poseName.trim();
    if (!normalizedPoseName) {
      setDebugError("Pose name is required.");
      return;
    }
    setDebugLoading(true);
    setDebugError("");
    setDebugMessage("");
    try {
      const sensorMap = { sensorA: sensorAKey, sensorB: sensorBKey };
      const res = await fetch(`${apiUrl}/api/debug/poses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: debugDeviceId,
          pose_name: normalizedPoseName,
          test_target: testTarget,
          sensor_map: sensorMap,
          reference: latestTelemetry.payload_json,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save pose template");
      setDebugMessage("Added new pose template.");
      await fetchPoseTemplates();
    } catch (err) {
      setDebugError(getErrorMessage(err));
    } finally {
      setDebugLoading(false);
    }
  };

  const onlineCount = devices.filter((device) => isDeviceOnline(device.last_online, currentTime)).length;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 p-6 font-sans relative overflow-hidden">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-600 rounded-full blur-[120px] opacity-20 pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-rose-600 rounded-full blur-[120px] opacity-20 pointer-events-none" />

      <div className="relative z-10 max-w-6xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row justify-between items-center bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl">
          <div>
            <p className="text-xs uppercase tracking-widest text-slate-500 mb-1">Admin</p>
            <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-rose-400">
              IoT Control Center
            </h1>
            <p className="text-sm text-slate-400">Click a board to edit WiFi, clear WiFi, refresh status, or remove it.</p>
          </div>

          <div className="flex items-center gap-6 mt-4 md:mt-0">
            <div className="flex items-center space-x-6">
              <div className="text-center">
                <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Total Boards</p>
                <p className="text-2xl font-bold text-white">{devices.length}</p>
              </div>
              <div className="w-px h-10 bg-white/10" />
              <div className="text-center">
                <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Online</p>
                <p className="text-2xl font-bold text-emerald-400">{onlineCount}</p>
              </div>
            </div>
            <Link
              href="/"
              className="text-sm text-slate-400 hover:text-white border border-white/10 rounded-xl px-4 py-2 transition-colors"
            >
              หน้าผู้ใช้
            </Link>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <section className="lg:col-span-2 bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Boards</h2>
              <button onClick={fetchDevices} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                {loadingDevices ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {loadingDevices && devices.length === 0 ? (
              <div className="flex justify-center items-center h-40">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
              </div>
            ) : devicesError ? (
              <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl text-sm">
                Error loading devices: {devicesError}
              </div>
            ) : devices.length === 0 ? (
              <div className="text-center text-slate-500 py-10">No boards found in the database.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {devices.map((device) => {
                  const online = isDeviceOnline(device.last_online, currentTime);
                  return (
                    <button
                      key={device.device_id}
                      onClick={() => openDevice(device)}
                      className="text-left rounded-2xl border border-white/10 bg-slate-900/60 p-5 hover:bg-white/10 hover:border-indigo-400/40 transition-colors"
                    >
                      <div className="flex justify-between gap-3">
                        <p className="font-mono text-sm text-white break-all">{device.device_id}</p>
                        <span className={`shrink-0 h-fit px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                          online
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                            : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        }`}>
                          {online ? "Online" : "Offline"}
                        </span>
                      </div>
                      <div className="mt-4 space-y-2 text-sm text-slate-400">
                        <p>WiFi: <span className="text-slate-200">{device.wifi_ssid}</span></p>
                        <p>Last online: <span className="text-slate-200">{new Date(device.last_online).toLocaleString()}</span></p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl h-fit">
            <h2 className="text-xl font-semibold mb-6">System Tools</h2>
            <div className="bg-slate-900/50 p-5 rounded-2xl border border-white/5">
              <h3 className="text-sm font-semibold mb-2">Google Sheets Auto-Fix</h3>
              <p className="text-xs text-slate-400 mb-5">
                Restores telemetry headers and ensures the Devices and Commands tabs exist.
              </p>
              <button
                onClick={fixSheet}
                disabled={loadingFix}
                className="w-full py-2.5 px-4 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-60"
              >
                {loadingFix ? "Processing..." : "Run Auto-Fix"}
              </button>

              {message && <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-xs">{message}</div>}
              {error && <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">{error}</div>}
            </div>
          </section>
        </div>

        <section className="bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
            <div>
              <h2 className="text-xl font-semibold">MPU6050 Debug Lab (2 Sensors)</h2>
              <p className="text-xs text-slate-400">เลือกจุดทดสอบ บันทึก sample และเพิ่มท่าใหม่จากข้อมูลจริงของ ESP32</p>
            </div>
            <button
              onClick={() => {
                if (!debugDeviceId) return;
                void fetchDebugTelemetry(debugDeviceId);
                void fetchDebugSamples(debugDeviceId);
                void fetchPoseTemplates();
              }}
              className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Refresh Debug Data
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4 space-y-3">
              <label className="text-xs text-slate-400 uppercase tracking-wider">Device</label>
              <select
                value={debugDeviceId}
                onChange={(event) => setDebugDeviceId(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm"
              >
                <option value="">Select board</option>
                {devices.map((device) => (
                  <option key={device.device_id} value={device.device_id}>
                    {device.device_id}
                  </option>
                ))}
              </select>

              <label className="text-xs text-slate-400 uppercase tracking-wider">Test Target</label>
              <select
                value={testTarget}
                onChange={(event) => setTestTarget(event.target.value as PoseKey)}
                className="w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm"
              >
                {POSE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {POSE_LABELS[key]}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-slate-400 uppercase tracking-wider">Sensor A</label>
                  <select
                    value={sensorAKey}
                    onChange={(event) => setSensorAKey(event.target.value as PoseKey)}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm"
                  >
                    {POSE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {POSE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 uppercase tracking-wider">Sensor B</label>
                  <select
                    value={sensorBKey}
                    onChange={(event) => setSensorBKey(event.target.value as PoseKey)}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm"
                  >
                    {POSE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {POSE_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="text-xs text-slate-400 uppercase tracking-wider">Pose Name</label>
              <input
                value={poseName}
                onChange={(event) => setPoseName(event.target.value)}
                placeholder="e.g. shoulder-flexion-45"
                className="w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm"
              />

              <label className="text-xs text-slate-400 uppercase tracking-wider">Notes</label>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                className="w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm"
              />

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={captureSample}
                  disabled={debugLoading || !debugDeviceId}
                  className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-semibold hover:bg-cyan-500 disabled:opacity-60"
                >
                  {debugLoading ? "Saving..." : "Save Sample"}
                </button>
                <button
                  onClick={saveAsPoseTemplate}
                  disabled={debugLoading || !debugDeviceId}
                  className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold hover:bg-violet-500 disabled:opacity-60"
                >
                  {debugLoading ? "Saving..." : "Add New Pose"}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4">
              <h3 className="text-sm font-semibold mb-3">Latest ESP32 Packet</h3>
              {!latestTelemetry ? (
                <p className="text-xs text-slate-500">No data yet. Send telemetry from ESP32 first.</p>
              ) : (
                <div className="space-y-2 text-xs">
                  <p className="text-slate-400">Time: <span className="text-slate-200">{new Date(latestTelemetry.timestamp).toLocaleString()}</span></p>
                  <p className="text-slate-400">Status: <span className="text-slate-200">{latestTelemetry.status || "-"}</span></p>
                  <p className="text-slate-400">Session: <span className="text-slate-200">{latestTelemetry.session_state || "idle"}</span></p>
                  <p className="text-slate-400">Rep: <span className="text-slate-200">{latestTelemetry.payload_json?.rep_count ?? 0}</span></p>
                  <p className="text-slate-400">Posture: <span className="text-slate-200">{latestTelemetry.payload_json?.posture?.state ?? "-"}</span></p>
                  <p className="text-slate-400">Speed: <span className="text-slate-200">{latestTelemetry.payload_json?.speed_dps ?? 0}</span></p>
                  <pre className="max-h-64 overflow-auto rounded-xl border border-white/10 bg-slate-950 p-3 text-[11px] text-slate-300">
                    {JSON.stringify(latestTelemetry.payload_json, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4">
                <h3 className="text-sm font-semibold mb-3">Saved Samples</h3>
                <div className="max-h-56 overflow-auto space-y-2">
                  {debugSamples.length === 0 ? (
                    <p className="text-xs text-slate-500">No samples yet.</p>
                  ) : (
                    debugSamples.map((sample, index) => (
                      <div key={`${sample.timestamp}-${index}`} className="rounded-xl border border-white/10 bg-slate-950/60 p-2 text-xs">
                        <p className="text-slate-300">{sample.pose_name || "debug-sample"}</p>
                        <p className="text-slate-500">{new Date(sample.timestamp).toLocaleString()}</p>
                        <p className="text-slate-500 truncate">{sample.test_target}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4">
                <h3 className="text-sm font-semibold mb-3">Pose Library</h3>
                <div className="max-h-56 overflow-auto space-y-2">
                  {poseTemplates.length === 0 ? (
                    <p className="text-xs text-slate-500">No poses yet.</p>
                  ) : (
                    poseTemplates.map((pose, index) => (
                      <div key={`${pose.created_at}-${index}`} className="rounded-xl border border-white/10 bg-slate-950/60 p-2 text-xs">
                        <p className="text-slate-300">{pose.pose_name}</p>
                        <p className="text-slate-500">{pose.test_target || "-"}</p>
                        <p className="text-slate-500">{new Date(pose.created_at).toLocaleString()}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">3D Live Pose (ESP32)</h3>
                <span className="text-[11px] text-slate-400">
                  {latestTelemetry ? `Updated: ${new Date(latestTelemetry.timestamp).toLocaleTimeString()}` : "Waiting..."}
                </span>
              </div>
              <div className="h-[380px]">
                <PoseViewer frame={liveFrame} activeJoints={POSE_KEYS} />
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4">
              <h3 className="text-sm font-semibold mb-3">Realtime Summary</h3>
              {!latestTelemetry ? (
                <p className="text-xs text-slate-500">No live telemetry yet.</p>
              ) : (
                <div className="space-y-2 text-xs">
                  <p className="text-slate-400">Device: <span className="text-slate-200">{latestTelemetry.device_id}</span></p>
                  <p className="text-slate-400">Session: <span className="text-slate-200">{latestTelemetry.session_state || "-"}</span></p>
                  <p className="text-slate-400">Rep count: <span className="text-slate-200">{latestTelemetry.payload_json?.rep_count ?? 0}</span></p>
                  <p className="text-slate-400">Speed: <span className="text-slate-200">{latestTelemetry.payload_json?.speed_dps ?? 0} dps</span></p>
                  <p className="text-slate-400">Posture: <span className="text-slate-200">{latestTelemetry.payload_json?.posture?.state ?? "unknown"}</span></p>
                  <p className="text-slate-400">
                    Sensors: <span className="text-slate-200">{latestTelemetry.payload_json?.sensors?.length ?? 0}/8</span>
                  </p>
                </div>
              )}
            </div>
          </div>

          {debugMessage && <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-xs">{debugMessage}</div>}
          {debugError && <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">{debugError}</div>}
        </section>
      </div>

      {selectedDevice && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm p-4 flex items-center justify-center">
          <section className="w-full max-w-xl rounded-3xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">Board Controls</h2>
                <p className="font-mono text-xs text-slate-400 mt-1 break-all">{selectedDevice.device_id}</p>
              </div>
              <button onClick={() => setSelectedDeviceId(null)} className="text-slate-400 hover:text-white">Close</button>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-6">
              <div className="rounded-2xl bg-white/5 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500">Status</p>
                <p className={isDeviceOnline(selectedDevice.last_online, currentTime) ? "text-emerald-400 font-semibold" : "text-rose-400 font-semibold"}>
                  {isDeviceOnline(selectedDevice.last_online, currentTime) ? "Online" : "Offline"}
                </p>
              </div>
              <div className="rounded-2xl bg-white/5 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500">Current WiFi</p>
                <p className="text-slate-200 truncate">{selectedDevice.wifi_ssid}</p>
              </div>
            </div>

            <form onSubmit={submitWifi} className="mt-6 space-y-4">
              <div>
                <label className="text-sm text-slate-300" htmlFor="wifiSsid">New WiFi SSID</label>
                <input
                  id="wifiSsid"
                  value={wifiSsid}
                  onChange={(event) => setWifiSsid(event.target.value)}
                  required
                  className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm outline-none focus:border-indigo-400"
                />
              </div>
              <div>
                <label className="text-sm text-slate-300" htmlFor="wifiPassword">New WiFi Password</label>
                <input
                  id="wifiPassword"
                  value={wifiPassword}
                  onChange={(event) => setWifiPassword(event.target.value)}
                  type="password"
                  placeholder="Leave blank for open network"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm outline-none focus:border-indigo-400"
                />
              </div>
              <button
                disabled={actionLoading === "SET_WIFI"}
                className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
              >
                {actionLoading === "SET_WIFI" ? "Queueing..." : "Save New WiFi To Board"}
              </button>
            </form>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              <button onClick={checkSelectedStatus} className="rounded-xl bg-slate-800 px-4 py-3 text-sm hover:bg-slate-700">
                Check Status
              </button>
              <button
                onClick={() => queueCommand("START_SESSION", { exercise_id: "general", rep_target: 10 })}
                disabled={actionLoading === "START_SESSION"}
                className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60"
              >
                {actionLoading === "START_SESSION" ? "Queueing..." : "Start Session"}
              </button>
              <button
                onClick={() => queueCommand("END_SESSION")}
                disabled={actionLoading === "END_SESSION"}
                className="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-60"
              >
                {actionLoading === "END_SESSION" ? "Queueing..." : "End Session"}
              </button>
              <button
                onClick={() => queueCommand("RECALIBRATE")}
                disabled={actionLoading === "RECALIBRATE"}
                className="rounded-xl bg-cyan-700 px-4 py-3 text-sm font-semibold hover:bg-cyan-600 disabled:opacity-60"
              >
                {actionLoading === "RECALIBRATE" ? "Queueing..." : "Recalibrate"}
              </button>
              <button
                onClick={() => queueCommand("CLEAR_WIFI")}
                disabled={actionLoading === "CLEAR_WIFI"}
                className="rounded-xl bg-amber-600/90 px-4 py-3 text-sm font-semibold hover:bg-amber-500 disabled:opacity-60"
              >
                {actionLoading === "CLEAR_WIFI" ? "Queueing..." : "Clear Board WiFi"}
              </button>
              <button
                onClick={removeDevice}
                disabled={actionLoading === "REMOVE"}
                className="rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold hover:bg-rose-500 disabled:opacity-60"
              >
                {actionLoading === "REMOVE" ? "Removing..." : "Remove Board"}
              </button>
            </div>

            <p className="mt-4 text-xs text-slate-500">
              WiFi commands apply when the board is online and checks the cloud. Clear WiFi restarts the board into setup mode.
            </p>
            {actionMessage && <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-xs">{actionMessage}</div>}
            {actionError && <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">{actionError}</div>}
          </section>
        </div>
      )}
    </main>
  );
}
