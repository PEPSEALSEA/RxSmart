"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import RehabPanel from "@/components/RehabPanel";
import LocalBridgePanel from "@/components/LocalBridgePanel";
import SensorReadout from "@/components/SensorReadout";
import FadeIn from "@/components/ui/FadeIn";
import {
  BridgeLiveTelemetry,
  LocalBridgeState,
  mapBridgeToLiveTelemetry,
  mapLocalJointsToFrame,
} from "@/lib/local-bridge";
import { FIRMWARE_SENSOR_TO_POSE, isUpperKey } from "@/lib/pose";
import {
  calibratedToDegrees,
  mapSensorsToFrame,
  parseChannelMap,
} from "@/lib/sensor-mapping";
import { REHAB_EXERCISES, RehabExercise } from "@/lib/rehab-exercises";
import {
  RehabSessionEngine,
  SessionFeedback,
  SensorFrame,
  buildSessionFeedback,
  createNeutralFrame,
  stepPhysics,
} from "@/lib/pose-physics";

type LiveTelemetry = BridgeLiveTelemetry;

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

const MediaPipeSkeletonViewer = dynamic(
  () => import("@/components/MediaPipeSkeletonViewer"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[340px] items-center justify-center rounded-2xl border border-neutral-200 bg-neutral-50">
        <p className="text-xs text-neutral-400">กำลังโหลด MediaPipe 3D…</p>
      </div>
    ),
  },
);

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
  if (payload.sensors?.length) {
    return mapSensorsToFrame(
      payload.sensors,
      parseChannelMap(payload.sensor_map),
    );
  }

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
      const calibrated = calibratedToDegrees(sensor.calibrated);
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
      `Board session: ${payload.session_state || "idle"}`,
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
  const [dataMode, setDataMode] = useState<DataMode>("simulation");
  const [sensorsOpen, setSensorsOpen] = useState(true);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [bridgeState, setBridgeState] = useState<LocalBridgeState | null>(null);

  const frameRef = useRef<SensorFrame>(createNeutralFrame());
  const engineRef = useRef<RehabSessionEngine>(new RehabSessionEngine(REHAB_EXERCISES[0]));
  const lastTickRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const isLive = dataMode === "live" && bridgeConnected;
  const isCameraBridge = dataMode === "camera" && bridgeConnected;
  const useExternalFrame = isLive || isCameraBridge;
  const liveTelemetry = bridgeState ? mapBridgeToLiveTelemetry(bridgeState) : null;

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
    if (mode === "simulation") {
      setBridgeConnected(false);
      setBridgeState(null);
      frameRef.current = createNeutralFrame();
      setFrame(createNeutralFrame());
      setFeedback(makeIdleFeedback(exercise, createNeutralFrame()));
    }
  };

  const handleBridgeFrameUpdate = (nextFrame: SensorFrame) => {
    frameRef.current = nextFrame;
    setFrame(nextFrame);
  };

  const handleBridgeStateUpdate = (state: LocalBridgeState | null) => {
    setBridgeState(state);
    if (!state) return;
    if (dataMode === "live") {
      const telemetry = mapBridgeToLiveTelemetry(state);
      if (telemetry) {
        setFeedback(makeLiveFeedback(exercise, telemetry));
      }
    } else if (dataMode === "camera") {
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
            <LocalBridgePanel
              autoConnect
              defaultMode="IOT_ONLY"
              showPreview={false}
              variant="imu"
              onConnectChange={handleBridgeConnectChange}
              onFrameUpdate={handleBridgeFrameUpdate}
              onStateUpdate={handleBridgeStateUpdate}
            />
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
                        <h2 className="text-sm font-semibold text-neutral-900">3D MediaPipe (ตรงกับกล้อง)</h2>
                        <p className="mt-0.5 text-xs text-neutral-400">
                          Landmarks 1:1 จาก Python · ไม่ใช่ mannequin จำลอง
                        </p>
                      </div>
                      <span className="animate-fade-in-only rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                        Camera Live
                      </span>
                    </div>
                    <div className="min-h-[min(52vh,480px)] flex-1">
                      <MediaPipeSkeletonViewer
                        landmarks={bridgeState?.pose_landmarks ?? null}
                        hands={bridgeState?.hand_landmarks ?? null}
                        skeletonDebug={bridgeState?.skeleton_debug}
                      />
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
                  ? `Local USB · ${bridgeState?.iot_status ?? "—"} · ${bridgeState?.iot_poll_rate_hz?.toFixed(1) ?? "0"} Hz`
                  : "Simulation mode — ไม่ต้องใช้อุปกรณ์"}
            </p>
          </footer>
        </FadeIn>
      </div>
    </main>
  );
}
