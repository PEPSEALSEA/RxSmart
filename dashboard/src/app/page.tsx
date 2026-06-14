"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import RehabPanel from "@/components/RehabPanel";
import SensorReadout from "@/components/SensorReadout";
import { Device, formatLastSeen, getApiUrl, getErrorMessage, isDeviceOnline } from "@/lib/devices";
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

const PoseViewer = dynamic(() => import("@/components/PoseViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[400px] items-center justify-center rounded-2xl border border-sky-100 bg-sky-50">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-sky-200 border-t-sky-500" />
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
  return { ...fb, messages: ["เลือกโปรแกรมฝึกแล้วกดเริ่ม — ระบบจำลอง sensor 8 จุดพร้อม physics"] };
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
      `session: ${payload.session_state || "idle"}`,
      `speed: ${(payload.speed_dps ?? 0).toFixed(1)} dps`,
      `posture: ${payload.posture?.state || "unknown"}`,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);

  const frameRef = useRef<SensorFrame>(createNeutralFrame());
  const engineRef = useRef<RehabSessionEngine>(new RehabSessionEngine(REHAB_EXERCISES[0]));
  const lastTickRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const apiUrl = getApiUrl();

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

  const fetchLiveTelemetry = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    try {
      const res = await fetch(`${apiUrl}/api/debug/telemetry?device_id=${encodeURIComponent(deviceId)}&limit=1`);
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
      setFeedback(makeLiveFeedback(exercise, payload));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [apiUrl, exercise]);

  useEffect(() => {
    const initialLoad = setTimeout(() => void fetchDevices(), 0);
    const interval = setInterval(() => void fetchDevices(), 30000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [fetchDevices]);

  useEffect(() => {
    if (!liveDeviceId) return;
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
  }, [fetchLiveTelemetry, liveDeviceId]);

  useEffect(() => {
    const tick = (now: number) => {
      if (!lastTickRef.current) lastTickRef.current = now;
      const dt = Math.min((now - lastTickRef.current) / 1000, 0.05);
      lastTickRef.current = now;

      const engine = engineRef.current;
      const targets = engine.getTargets();
      const nextFrame = stepPhysics(frameRef.current, targets, dt);
      frameRef.current = nextFrame;

      if (!liveTelemetry) {
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
  }, [liveTelemetry]);

  const handleSelectExercise = (next: RehabExercise) => {
    engineRef.current.setExercise(next);
    setExercise(next);
    if (liveTelemetry) {
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

  const activeJoints = feedback.activeJoints;
  const onlineCount = devices.filter((d) => isDeviceOnline(d.last_online, currentTime)).length;

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-50 via-blue-50/80 to-sky-100 text-slate-700">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-16 h-72 w-72 rounded-full bg-sky-200/50 blur-3xl" />
        <div className="absolute top-1/3 -left-20 h-64 w-64 rounded-full bg-blue-200/40 blur-3xl" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10">
        <header className="mb-8 text-center">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-sky-200/80 bg-white/70 px-4 py-1.5 text-sm text-sky-600 shadow-sm">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
            RxSmart · กายภาพบำบัด
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-800 sm:text-4xl">
            ฝึกท่า
            <span className="text-sky-500"> แบบ Physics</span>
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-500 sm:text-base">
            ข้อต่อบนมี 2 แกน (ยก + หมุนรอบตัว) รองรับท่าว่ายน้ำ — ข้อต่อล่างงอ-เหยียด
          </p>
          <p className="mx-auto mt-2 max-w-2xl text-xs text-slate-500">
            โหมดข้อมูล: {liveTelemetry ? `Live (${liveDeviceId})` : "Physics Simulation"}
          </p>
        </header>

        <section className="mb-6 grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="rounded-3xl border border-white/80 bg-white/80 p-4 shadow-lg shadow-sky-100/80 sm:p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-800">3D ท่าทาง</h2>
                <p className="text-xs text-slate-400">Spring animation · ลากหมุนได้</p>
              </div>
              <div className="h-[min(55vh,460px)]">
                <PoseViewer frame={frame} activeJoints={activeJoints} />
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="rounded-3xl border border-white/80 bg-white/80 p-4 shadow-lg shadow-sky-100/80 sm:p-5">
              <RehabPanel
                exercise={exercise}
                feedback={feedback}
                onSelectExercise={handleSelectExercise}
                onStart={handleStart}
                onStop={handleStop}
                onReset={handleReset}
              />
            </div>
          </div>
        </section>

        <section className="mb-6 rounded-3xl border border-white/80 bg-white/80 p-4 shadow-lg shadow-sky-100/80 sm:p-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-800">Sensor 8 จุด — มุม & ความเร็ว</h2>
          <SensorReadout jointFeedback={feedback.jointFeedback} />
        </section>

        <section className="mb-8 rounded-3xl border border-white/80 bg-white/80 p-5 shadow-lg shadow-sky-100/80 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-800">อุปกรณ์</h2>
              <p className="text-sm text-slate-400">ออนไลน์ {onlineCount} / {devices.length}</p>
            </div>
            <button
              onClick={fetchDevices}
              disabled={loading}
              className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-600 hover:bg-sky-100 disabled:opacity-60"
            >
              {loading ? "โหลด..." : "รีเฟรช"}
            </button>
          </div>

          {error ? (
            <p className="text-sm text-rose-600">{error}</p>
          ) : devices.length === 0 ? (
            <p className="text-center text-sm text-slate-400 py-4">ยังไม่มีบอร์ด — mock physics ทำงานอยู่</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              {devices.map((device) => {
                const online = isDeviceOnline(device.last_online, currentTime);
                return (
                  <button
                    key={device.device_id}
                    onClick={() => setLiveDeviceId(device.device_id)}
                    className={`rounded-xl border px-3 py-2 text-xs text-left ${
                      liveDeviceId === device.device_id ? "border-sky-400 bg-sky-50" : "border-sky-100"
                    }`}
                  >
                    <span className="font-mono text-slate-600">{device.device_id}</span>
                    <span className={`ml-2 ${online ? "text-emerald-600" : "text-slate-400"}`}>
                      {online ? "ออนไลน์" : "ออฟไลน์"}
                    </span>
                    <p className="text-slate-400">{formatLastSeen(device.last_online)}</p>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <footer className="flex flex-col items-center gap-3 border-t border-sky-100 pt-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <p className="text-sm text-slate-400">RxSmart — Rehab Live Session</p>
          <Link href="/admin" className="text-sm text-slate-400 hover:text-sky-500">
            เข้าสู่ระบบผู้ดูแล →
          </Link>
        </footer>
      </div>
    </main>
  );
}
