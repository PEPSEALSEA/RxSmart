"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import RehabPanel from "@/components/RehabPanel";
import LocalBridgePanel from "@/components/LocalBridgePanel";
import SensorReadout from "@/components/SensorReadout";
import FadeIn from "@/components/ui/FadeIn";
import { Device, formatLastSeen, getApiUrl, getErrorMessage, isDeviceOnline } from "@/lib/devices";
import { LocalBridgeState, mapLocalJointsToFrame } from "@/lib/local-bridge";
import { FIRMWARE_SENSOR_TO_POSE, isUpperKey } from "@/lib/pose";
import { REHAB_EXERCISES, RehabExercise } from "@/lib/rehab-exercises";
import {
  RehabSessionEngine,
  SessionFeedback,
  SensorFrame,
  buildSessionFeedback,
  createNeutralFrame,
  stepPhysics,
} from "@/lib/pose-physics";

type LiveTelemetry = {
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
  sensors?: Array<{ key?: string; calibrated?: number }>;
};

type DataMode = "simulation" | "live" | "camera";

const PoseViewer = dynamic(() => import("@/components/PoseViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-neutral-200 bg-neutral-50">
      <div className="flex flex-col items-center gap-3 animate-fade-in-only">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900" />
        <p className="text-xs text-neutral-400">กำลังโหลด 3D viewer…</p>
      </div>
    </div>
  ),
});

function makeIdleFeedback(exercise: RehabExercise, frame: SensorFrame): SessionFeedback {
  const fb = buildSessionFeedback(
    frame,
    exercise.startPose,
    exercise.phases[0],
    0,
    exercise.reps,
    "idle",
  );
  return { ...fb, messages: ["เลือกโปรแกรมฝึกแล้วกดเริ่ม — โหมดจำลอง physics 8 sensor"] };
}

function mapTelemetryToFrame(payload: LiveTelemetry): SensorFrame {
  const base = createNeutralFrame();
  if (payload.angles) {
    base.l_arm_lower.bend = payload.angles.elbow_left ?? base.l_arm_lower.bend;
    base.r_arm_lower.bend = payload.angles.elbow_right ?? base.r_arm_lower.bend;
    base.l_leg_lower.bend = payload.angles.knee_left ?? base.l_leg_lower.bend;
    base.r_leg_lower.bend = payload.angles.knee_right ?? base.r_leg_lower.bend;
  }

  if (Array.isArray(payload.sensors)) {
    for (const sensor of payload.sensors) {
      const poseKey = sensor.key ? FIRMWARE_SENSOR_TO_POSE[sensor.key] : undefined;
      if (!poseKey || typeof sensor.calibrated !== "number") continue;
      const calibrated = Math.max(0, Math.min(180, Math.abs(sensor.calibrated) * (180 / 4095)));
      if (isUpperKey(poseKey)) {
        base[poseKey].elevation = calibrated;
      } else {
        base[poseKey].bend = calibrated;
      }
    }
  }

  return base;
}

function mapSessionState(state?: string): "idle" | "moving" | "holding" | "rest" | "complete" {
  if (state === "exercise") return "moving";
  if (state === "complete") return "complete";
  return "idle";
}

function makeLiveFeedback(exercise: RehabExercise, payload: LiveTelemetry): SessionFeedback {
  const base = makeIdleFeedback(exercise, createNeutralFrame());
  return {
    ...base,
    status: mapSessionState(payload.session_state),
    rep: payload.rep_count ?? 0,
    totalReps: payload.rep_target ?? exercise.reps,
    messages: [
      `ESP32 session: ${payload.session_state || "idle"}`,
      `ความเร็ว ${(payload.speed_dps ?? 0).toFixed(1)}°/s · posture ${payload.posture?.state || "—"}`,
    ],
  };
}

function makeCameraFeedback(exercise: RehabExercise, state: LocalBridgeState): SessionFeedback {
  const joints = state.joints;
  const frame = mapLocalJointsToFrame(joints);
  const fb = buildSessionFeedback(
    frame,
    exercise.startPose,
    exercise.phases[0],
    joints?.rep_count ?? 0,
    joints?.rep_target ?? exercise.reps,
    mapSessionState(joints?.session_state),
  );
  return {
    ...fb,
    messages: [
      `Local bridge · ${state.mode.replace("_", " ")}`,
      joints
        ? `confidence ${Math.round(joints.confidence * 100)}% · ${joints.source}`
        : "รอ MediaPipe จับ pose…",
    ],
  };
}

export default function UserHome() {
  const [frame, setFrame] = useState<SensorFrame>(createNeutralFrame);
  const [feedback, setFeedback] = useState<SessionFeedback>(() =>
    makeIdleFeedback(REHAB_EXERCISES[0], createNeutralFrame()),
  );
  const [exercise, setExercise] = useState<RehabExercise>(REHAB_EXERCISES[0]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [liveDeviceId, setLiveDeviceId] = useState("");
  const [liveTelemetry, setLiveTelemetry] = useState<LiveTelemetry | null>(null);
  const [dataMode, setDataMode] = useState<DataMode>("simulation");
  const [sensorsOpen, setSensorsOpen] = useState(true);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [bridgeState, setBridgeState] = useState<LocalBridgeState | null>(null);

  const frameRef = useRef<SensorFrame>(createNeutralFrame());
  const engineRef = useRef<RehabSessionEngine>(new RehabSessionEngine(REHAB_EXERCISES[0]));
  const lastTickRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const apiUrl = getApiUrl();
  const isLive = dataMode === "live" && Boolean(liveDeviceId && liveTelemetry);
  const isCameraBridge = dataMode === "camera" && bridgeConnected;
  const useExternalFrame = isLive || isCameraBridge;

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError("");
    setCurrentTime(Date.now());
    try {
      const res = await fetch(`${apiUrl}/api/devices`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลดข้อมูลไม่สำเร็จ");
      const nextDevices = data.devices || [];
      setDevices(nextDevices);
      setLiveDeviceId((current) => {
        if (current && nextDevices.some((device: Device) => device.device_id === current)) return current;
        return nextDevices[0]?.device_id || "";
      });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  const fetchLiveTelemetry = useCallback(
    async (deviceId: string) => {
      if (!deviceId) return;
      try {
        const res = await fetch(
          `${apiUrl}/api/debug/telemetry?device_id=${encodeURIComponent(deviceId)}&limit=1`,
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "โหลด telemetry ไม่สำเร็จ");
        const payload = data.samples?.[0]?.payload_json as LiveTelemetry | undefined;
        if (!payload) {
          setLiveTelemetry(null);
          return;
        }
        setLiveTelemetry(payload);
        const mappedFrame = mapTelemetryToFrame(payload);
        frameRef.current = mappedFrame;
        setFrame(mappedFrame);
        if (dataMode === "live") {
          setFeedback(makeLiveFeedback(exercise, payload));
        }
      } catch (err) {
        setError(getErrorMessage(err));
      }
    },
    [apiUrl, dataMode, exercise],
  );

  useEffect(() => {
    const initialLoad = setTimeout(() => void fetchDevices(), 0);
    const interval = setInterval(() => void fetchDevices(), 30000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [fetchDevices]);

  useEffect(() => {
    if (!liveDeviceId || dataMode !== "live") return;
    const bootstrap = setTimeout(() => {
      void fetchLiveTelemetry(liveDeviceId);
    }, 0);
    const interval = setInterval(() => {
      void fetchLiveTelemetry(liveDeviceId);
    }, 3000);
    return () => {
      clearTimeout(bootstrap);
      clearInterval(interval);
    };
  }, [fetchLiveTelemetry, liveDeviceId, dataMode]);

  useEffect(() => {
    const tick = (now: number) => {
      if (!lastTickRef.current) lastTickRef.current = now;
      const dt = Math.min((now - lastTickRef.current) / 1000, 0.05);
      lastTickRef.current = now;

      const engine = engineRef.current;
      const targets = engine.getTargets();
      const nextFrame = stepPhysics(frameRef.current, targets, dt);
      frameRef.current = nextFrame;

      if (!useExternalFrame) {
        const sessionFeedback = engine.tick(dt, nextFrame);
        setFrame({ ...nextFrame });
        setFeedback(sessionFeedback);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [useExternalFrame]);

  const handleSelectExercise = (next: RehabExercise) => {
    engineRef.current.setExercise(next);
    setExercise(next);
    if (isCameraBridge && bridgeState) {
      setFeedback(makeCameraFeedback(next, bridgeState));
    } else if (isLive && liveTelemetry) {
      const mappedFrame = mapTelemetryToFrame(liveTelemetry);
      frameRef.current = mappedFrame;
      setFrame(mappedFrame);
      setFeedback(makeLiveFeedback(next, liveTelemetry));
    } else {
      frameRef.current = createNeutralFrame();
      setFrame(createNeutralFrame());
      setFeedback(makeIdleFeedback(next, createNeutralFrame()));
    }
  };

  const handleStart = () => {
    engineRef.current.start();
    setFeedback(engineRef.current.tick(0, frameRef.current));
  };

  const handleStop = () => {
    engineRef.current.stop();
  };

  const handleReset = () => {
    engineRef.current.reset();
    frameRef.current = createNeutralFrame();
    setFrame(createNeutralFrame());
    setFeedback(makeIdleFeedback(exercise, createNeutralFrame()));
  };

  const handleModeChange = (mode: DataMode) => {
    setDataMode(mode);
    if (mode !== "camera") {
      setBridgeConnected(false);
      setBridgeState(null);
    }
    if (mode === "simulation") {
      frameRef.current = createNeutralFrame();
      setFrame(createNeutralFrame());
      setFeedback(makeIdleFeedback(exercise, createNeutralFrame()));
    } else if (mode === "live" && liveTelemetry) {
      const mappedFrame = mapTelemetryToFrame(liveTelemetry);
      frameRef.current = mappedFrame;
      setFrame(mappedFrame);
      setFeedback(makeLiveFeedback(exercise, liveTelemetry));
    }
  };

  const handleBridgeFrameUpdate = (nextFrame: SensorFrame) => {
    frameRef.current = nextFrame;
    setFrame(nextFrame);
  };

  const handleBridgeStateUpdate = (state: LocalBridgeState | null) => {
    setBridgeState(state);
    if (state) {
      setFeedback(makeCameraFeedback(exercise, state));
    }
  };

  const handleBridgeConnectChange = (connected: boolean) => {
    setBridgeConnected(connected);
    if (!connected) {
      setBridgeState(null);
      frameRef.current = createNeutralFrame();
      setFrame(createNeutralFrame());
      setFeedback(makeIdleFeedback(exercise, createNeutralFrame()));
    }
  };

  const activeJoints = feedback.activeJoints;
  const onlineCount = devices.filter((d) => isDeviceOnline(d.last_online, currentTime)).length;

  return (
    <main className="min-h-screen bg-[#fafafa] text-neutral-900">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <FadeIn>
          <header className="mb-8 flex flex-col gap-6 border-b border-neutral-200/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-400">RxSmart</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                กายภาพบำบัดอัจฉริยะ
              </h1>
              <p className="mt-2 max-w-lg text-sm text-neutral-500">
                Hybrid Motion Tracking — Physics · Live IMU · Camera (MediaPipe local)
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex rounded-xl border border-neutral-200 bg-white p-1 shadow-sm">
                <button
                  type="button"
                  onClick={() => handleModeChange("simulation")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-300 ${
                    dataMode === "simulation"
                      ? "bg-neutral-900 text-white shadow-sm"
                      : "text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  จำลอง Physics
                </button>
                <button
                  type="button"
                  onClick={() => handleModeChange("live")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-300 ${
                    dataMode === "live"
                      ? "bg-neutral-900 text-white shadow-sm"
                      : "text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  Live IMU
                </button>
                <button
                  type="button"
                  onClick={() => handleModeChange("camera")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-300 ${
                    dataMode === "camera"
                      ? "bg-neutral-900 text-white shadow-sm"
                      : "text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  Camera
                </button>
              </div>

              <Link
                href="/admin"
                className="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs font-medium text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-800"
              >
                Admin
              </Link>
            </div>
          </header>
        </FadeIn>

        {dataMode === "live" && (
          <FadeIn delay={80} className="mb-6">
            <div className="rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">อุปกรณ์ ESP32</p>
                  <p className="mt-1 text-sm text-neutral-600">
                    {onlineCount} ออนไลน์ · {devices.length} ทั้งหมด
                    {isLive && (
                      <span className="ml-2 inline-flex items-center gap-1.5 text-emerald-600">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-soft" />
                        รับข้อมูล live
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDevicesOpen((open) => !open)}
                    className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-neutral-50"
                  >
                    {devicesOpen ? "ซ่อนรายการ" : "เลือกอุปกรณ์"}
                  </button>
                  <button
                    type="button"
                    onClick={fetchDevices}
                    disabled={loading}
                    className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-50"
                  >
                    {loading ? "…" : "รีเฟรช"}
                  </button>
                </div>
              </div>

              {error && (
                <p className="mt-3 animate-fade-in-only rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                  {error}
                </p>
              )}

              <div
                className={`overflow-hidden transition-all duration-500 ease-out ${
                  devicesOpen ? "mt-4 max-h-48 opacity-100" : "max-h-0 opacity-0"
                }`}
              >
                {devices.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-400">
                    ยังไม่มีบอร์ด — ตรวจสอบ WiFi และ telemetry จาก ESP32
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {devices.map((device, index) => {
                      const online = isDeviceOnline(device.last_online, currentTime);
                      const selected = liveDeviceId === device.device_id;
                      return (
                        <button
                          key={device.device_id}
                          type="button"
                          onClick={() => setLiveDeviceId(device.device_id)}
                          className={`animate-fade-in rounded-xl border px-3 py-2.5 text-left transition-all duration-300 ${
                            selected
                              ? "border-neutral-900 bg-neutral-900 text-white shadow-sm"
                              : "border-neutral-200 bg-neutral-50 hover:border-neutral-300 hover:bg-white"
                          }`}
                          style={{ animationDelay: `${index * 40}ms` }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono text-[11px]">{device.device_id}</span>
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
                          <p
                            className={`mt-1 text-[10px] ${
                              selected ? "text-neutral-400" : "text-neutral-400"
                            }`}
                          >
                            {formatLastSeen(device.last_online)}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </FadeIn>
        )}

        {dataMode === "camera" && (
          <FadeIn delay={80} className="mb-6 space-y-6">
            <LocalBridgePanel
              onConnectChange={handleBridgeConnectChange}
              onFrameUpdate={handleBridgeFrameUpdate}
              onStateUpdate={handleBridgeStateUpdate}
            />

            {bridgeConnected && (
              <section className="grid gap-6 lg:grid-cols-12 lg:gap-8">
                <FadeIn delay={120} className="lg:col-span-7">
                  <div className="flex h-full flex-col rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm sm:p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-neutral-900">3D จาก Camera Bridge</h2>
                        <p className="mt-0.5 text-xs text-neutral-400">
                          {bridgeState?.mode.replace("_", " ") ?? "—"} · MediaPipe joints
                        </p>
                      </div>
                      <span className="animate-fade-in-only rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                        Camera Live
                      </span>
                    </div>
                    <div className="min-h-[min(52vh,480px)] flex-1">
                      <PoseViewer frame={frame} activeJoints={activeJoints} />
                    </div>
                  </div>
                </FadeIn>

                <FadeIn delay={180} className="lg:col-span-5">
                  <div className="flex h-full min-h-[480px] flex-col rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm sm:p-5">
                    <RehabPanel
                      exercise={exercise}
                      feedback={feedback}
                      onSelectExercise={handleSelectExercise}
                      onStart={handleStart}
                      onStop={handleStop}
                      onReset={handleReset}
                    />
                  </div>
                </FadeIn>
              </section>
            )}

            {bridgeConnected && (
              <FadeIn delay={240}>
                <section className="overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-sm">
                  <div className="border-b border-neutral-100 px-5 py-4">
                    <h2 className="text-sm font-semibold text-neutral-900">Joint readout (camera)</h2>
                  </div>
                  <div className="px-5 pb-5 pt-4">
                    <SensorReadout jointFeedback={feedback.jointFeedback} />
                  </div>
                </section>
              </FadeIn>
            )}
          </FadeIn>
        )}

        {dataMode !== "camera" && (
        <section className="grid gap-6 lg:grid-cols-12 lg:gap-8">
          <FadeIn delay={120} className="lg:col-span-7">
            <div className="flex h-full flex-col rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm sm:p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-900">3D ท่าทาง</h2>
                  <p className="mt-0.5 text-xs text-neutral-400">ลากหมุน · spring animation</p>
                </div>
                <span
                  key={isLive ? "live" : "sim"}
                  className="animate-fade-in-only rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500"
                >
                  {isLive ? "IMU Live" : "Physics Sim"}
                </span>
              </div>
              <div className="min-h-[min(52vh,480px)] flex-1">
                <PoseViewer frame={frame} activeJoints={activeJoints} />
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={180} className="lg:col-span-5">
            <div className="flex h-full min-h-[480px] flex-col rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm sm:p-5">
              <RehabPanel
                exercise={exercise}
                feedback={feedback}
                onSelectExercise={handleSelectExercise}
                onStart={handleStart}
                onStop={handleStop}
                onReset={handleReset}
              />
            </div>
          </FadeIn>
        </section>
        )}

        {dataMode !== "camera" && (
        <FadeIn delay={240} className="mt-6">
          <section className="overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-sm">
            <button
              type="button"
              onClick={() => setSensorsOpen((open) => !open)}
              className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-neutral-50/80"
            >
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">Sensor 8 จุด</h2>
                <p className="mt-0.5 text-xs text-neutral-400">มุมข้อต่อ · ความเร็ว · tolerance</p>
              </div>
              <span className="text-lg font-light text-neutral-300 transition-transform duration-300">
                {sensorsOpen ? "−" : "+"}
              </span>
            </button>

            <div
              className={`transition-all duration-500 ease-out ${
                sensorsOpen ? "max-h-[900px] opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              <div className="border-t border-neutral-100 px-5 pb-5 pt-4">
                <SensorReadout jointFeedback={feedback.jointFeedback} />
              </div>
            </div>
          </section>
        </FadeIn>
        )}

        <FadeIn delay={300}>
          <footer className="mt-10 flex flex-col items-center justify-between gap-2 border-t border-neutral-200/80 pt-6 text-center sm:flex-row sm:text-left">
            <p className="text-xs text-neutral-400">RxSmart · Smart Physical Therapy</p>
            <p className="text-xs text-neutral-300">
              {dataMode === "camera"
                ? bridgeConnected
                  ? `Camera bridge · ${bridgeState?.mode ?? "—"}`
                  : "Camera — รัน python main.py แล้วกดเชื่อมต่อ"
                : isLive
                  ? `Device ${liveDeviceId}`
                  : "Simulation mode — ไม่ต้องใช้อุปกรณ์"}
            </p>
          </footer>
        </FadeIn>
      </div>
    </main>
  );
}
