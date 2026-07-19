"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import RehabPanel from "@/components/RehabPanel";
import LocalBridgePanel from "@/components/LocalBridgePanel";
import SensorReadout from "@/components/SensorReadout";
import FadeIn from "@/components/ui/FadeIn";
import GameStage from "@/components/game/GameStage";
import {
  LocalBridgeState,
  loadBridgeUrl,
  mapBridgeSessionFeedback,
  postBridgeSessionAction,
  selectBridgeExercise,
} from "@/lib/local-bridge";
import { getExerciseById, REHAB_EXERCISES, RehabExercise } from "@/lib/rehab-exercises";
import {
  RehabSessionEngine,
  SessionFeedback,
  SensorFrame,
  buildSessionFeedback,
  createNeutralFrame,
  stepPhysics,
} from "@/lib/pose-physics";

type DataMode = "simulation" | "live" | "camera";

const MODE_OPTIONS: { id: DataMode; label: string }[] = [
  { id: "simulation", label: "จำลอง Physics" },
  { id: "live", label: "Live IMU" },
  { id: "camera", label: "Camera" },
];

const PoseViewer = dynamic(() => import("@/components/PoseViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[400px] items-center justify-center rounded-cohere-sm bg-cohere-primary/5">
      <div className="flex flex-col items-center gap-3 animate-fade-in-only">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-cohere-hairline border-t-cohere-primary" />
        <p className="cohere-mono-label text-[11px]">กำลังโหลด 3D viewer…</p>
      </div>
    </div>
  ),
});

const SkeletonViewer = dynamic(() => import("@/components/SkeletonViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[340px] items-center justify-center rounded-cohere-sm bg-cohere-primary/5">
      <p className="cohere-mono-label text-[11px]">กำลังโหลด 3D skeleton…</p>
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

/**
 * Live IMU + Camera: score/angleOk judged on Python (exercise_engine).
 * Browser only renders session_feedback from the local bridge.
 */
function makeBridgeFeedback(state: LocalBridgeState, sourceLabel: string): SessionFeedback | null {
  const mapped = mapBridgeSessionFeedback(state.session_feedback);
  if (!mapped) return null;
  const joints = state.joints;
  return {
    ...mapped,
    messages: [
      ...mapped.messages,
      joints
        ? `${sourceLabel} · ${joints.source} · conf ${Math.round(joints.confidence * 100)}%`
        : `รอข้อมูลจาก ${sourceLabel}…`,
    ].slice(0, 3),
  };
}

function StatusBadge({ label }: { label: string }) {
  return (
    <span className="cohere-mono-label animate-fade-in-only rounded-full border border-cohere-hairline bg-cohere-soft-stone px-3 py-1 text-[10px]">
      {label}
    </span>
  );
}

function PanelCard({
  title,
  subtitle,
  badge,
  children,
  variant = "light",
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  children: React.ReactNode;
  variant?: "light" | "agent";
}) {
  const isAgent = variant === "agent";

  return (
    <div
      className={`flex h-full flex-col p-5 sm:p-6 ${
        isAgent
          ? "cohere-agent-card"
          : "cohere-card"
      }`}
    >
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2
            className={`text-base font-normal tracking-tight ${
              isAgent ? "text-cohere-on-primary" : "text-cohere-ink"
            }`}
          >
            {title}
          </h2>
          {subtitle && (
            <p
              className={`mt-1 text-sm ${
                isAgent ? "text-cohere-muted" : "text-cohere-body-muted"
              }`}
            >
              {subtitle}
            </p>
          )}
        </div>
        {badge && <StatusBadge label={badge} />}
      </div>
      <div className="min-h-[min(52vh,480px)] flex-1">{children}</div>
    </div>
  );
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
  const useBridgeControls = dataMode === "live" || dataMode === "camera";
  const useExternalFrame = useBridgeControls && bridgeConnected;

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
    setExercise(next);

    if (useBridgeControls) {
      void selectBridgeExercise(loadBridgeUrl(), next.id).catch(() => undefined);
      return;
    }

    engineRef.current.setExercise(next);
    frameRef.current = createNeutralFrame();
    setFrame(createNeutralFrame());
    setFeedback(makeIdleFeedback(next, createNeutralFrame()));
  };

  const handleStart = () => {
    if (useBridgeControls) {
      void postBridgeSessionAction(loadBridgeUrl(), "start").catch(() => undefined);
      return;
    }
    engineRef.current.start();
    setFeedback(engineRef.current.tick(0, frameRef.current));
  };

  const handleStop = () => {
    if (useBridgeControls) {
      void postBridgeSessionAction(loadBridgeUrl(), "stop").catch(() => undefined);
      return;
    }
    engineRef.current.stop();
  };

  const handleReset = () => {
    if (useBridgeControls) {
      void postBridgeSessionAction(loadBridgeUrl(), "reset").catch(() => undefined);
      return;
    }
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
    if (state.exercise_id && state.exercise_id !== exercise.id) {
      const synced = getExerciseById(state.exercise_id);
      if (synced) setExercise(synced);
    }
    if (dataMode === "live") {
      const liveFb = makeBridgeFeedback(state, "IMU");
      if (liveFb) setFeedback(liveFb);
    } else if (dataMode === "camera") {
      const camFb = makeBridgeFeedback(state, "Camera");
      if (camFb) setFeedback(camFb);
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

  const footerStatus =
    dataMode === "camera"
      ? bridgeConnected
        ? `Camera bridge · ${bridgeState?.mode ?? "—"}`
        : "Camera — รัน python main.py แล้วกดเชื่อมต่อ"
      : isLive
        ? `Local USB · ${bridgeState?.iot_status ?? "—"} · ${bridgeState?.iot_poll_rate_hz?.toFixed(1) ?? "0"} Hz`
        : "Simulation mode — ไม่ต้องใช้อุปกรณ์";

  return (
    <main className="min-h-screen bg-cohere-canvas text-cohere-ink">
      <div className="cohere-announcement">
        <span className="text-cohere-muted">
          RxSmart · Hybrid Motion Tracking
        </span>
        <span className="mx-3 text-cohere-slate">·</span>
        <span>Physics · Live IMU · Camera (MediaPipe)</span>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-8 sm:py-14">
        <FadeIn>
          <header className="mb-14 flex flex-col gap-8 border-b border-cohere-hairline pb-10 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-2xl">
              <p className="cohere-mono-label mb-4">RxSmart</p>
              <h1 className="font-display text-4xl font-normal leading-none tracking-[-0.04em] text-cohere-ink sm:text-5xl lg:text-[60px]">
                กายภาพบำบัดอัจฉริยะ
              </h1>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-cohere-body-muted">
                ติดตามท่าทางแบบเรียลไทม์จาก sensor 8 จุด — จำลอง physics, IMU สด, หรือกล้อง MediaPipe
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex flex-wrap gap-1.5 rounded-cohere-xl border border-cohere-hairline p-1">
                {MODE_OPTIONS.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => handleModeChange(mode.id)}
                    data-active={dataMode === mode.id}
                    className="cohere-btn-pill-outline text-xs"
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              <Link
                href="/admin"
                className="cohere-btn-pill-outline text-xs no-underline"
              >
                Admin
              </Link>
            </div>
          </header>
        </FadeIn>

        {dataMode === "live" && (
          <FadeIn delay={80} className="mb-8 space-y-8">
            <LocalBridgePanel
              autoConnect
              defaultMode="IOT_ONLY"
              showPreview={false}
              variant="imu"
              onConnectChange={handleBridgeConnectChange}
              onFrameUpdate={handleBridgeFrameUpdate}
              onStateUpdate={handleBridgeStateUpdate}
            />

            {bridgeConnected && (
              <FadeIn delay={120}>
                <GameStage
                  frame={frame}
                  feedback={feedback}
                  exercise={exercise}
                  onSelectExercise={handleSelectExercise}
                  onStart={handleStart}
                  onStop={handleStop}
                  onReset={handleReset}
                  imuMode
                />
              </FadeIn>
            )}
          </FadeIn>
        )}

        {dataMode === "camera" && (
          <FadeIn delay={80} className="mb-8 space-y-8">
            <LocalBridgePanel
              autoConnect
              onConnectChange={handleBridgeConnectChange}
              onFrameUpdate={handleBridgeFrameUpdate}
              onStateUpdate={handleBridgeStateUpdate}
            />

            {bridgeConnected && (
              <section className="grid gap-8 lg:grid-cols-12">
                <FadeIn delay={120} className="lg:col-span-7">
                  <PanelCard
                    title="3D Skeleton"
                    subtitle="World landmarks · เท้าติดพื้น · ไม่บินตอนยืนนิ่ง"
                    badge="Camera Live"
                    variant="agent"
                  >
                    <SkeletonViewer
                      landmarks={bridgeState?.pose_landmarks ?? null}
                      worldLandmarks={bridgeState?.pose_world_landmarks ?? null}
                      hands={bridgeState?.hand_landmarks ?? null}
                      skeletonDebug={bridgeState?.skeleton_debug}
                    />
                  </PanelCard>
                </FadeIn>

                <FadeIn delay={180} className="lg:col-span-5">
                  <div className="cohere-card flex h-full min-h-[480px] flex-col p-5 sm:p-6">
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
                <section className="cohere-card overflow-hidden">
                  <div className="border-b border-cohere-hairline px-6 py-5">
                    <h2 className="text-base font-normal text-cohere-ink">Joint readout</h2>
                    <p className="mt-1 text-sm text-cohere-body-muted">มุมข้อต่อจากกล้อง</p>
                  </div>
                  <div className="px-6 py-5">
                    <SensorReadout jointFeedback={feedback.jointFeedback} />
                  </div>
                </section>
              </FadeIn>
            )}
          </FadeIn>
        )}

        {dataMode === "simulation" && (
          <section className="grid gap-8 lg:grid-cols-12">
            <FadeIn delay={120} className="lg:col-span-7">
              <PanelCard
                title="3D ท่าทาง"
                subtitle="ลากหมุน · spring animation"
                badge="Physics Sim"
                variant="agent"
              >
                <PoseViewer frame={frame} activeJoints={activeJoints} />
              </PanelCard>
            </FadeIn>

            <FadeIn delay={180} className="lg:col-span-5">
              <div className="cohere-card flex h-full min-h-[480px] flex-col p-5 sm:p-6">
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

        {dataMode === "simulation" && (
          <FadeIn delay={240} className="mt-8">
            <section className="cohere-card overflow-hidden">
              <button
                type="button"
                onClick={() => setSensorsOpen((open) => !open)}
                className="flex w-full items-center justify-between px-6 py-5 text-left transition hover:bg-cohere-soft-stone/50"
              >
                <div>
                  <h2 className="text-base font-normal text-cohere-ink">Sensor 8 จุด</h2>
                  <p className="mt-1 text-sm text-cohere-body-muted">มุมข้อต่อ · ความเร็ว · tolerance</p>
                </div>
                <span className="font-display text-2xl font-light text-cohere-muted transition-transform duration-300">
                  {sensorsOpen ? "−" : "+"}
                </span>
              </button>

              <div
                className={`transition-all duration-500 ease-out ${
                  sensorsOpen ? "max-h-[900px] opacity-100" : "max-h-0 opacity-0"
                }`}
              >
                <div className="border-t border-cohere-hairline px-6 py-5">
                  <SensorReadout jointFeedback={feedback.jointFeedback} />
                </div>
              </div>
            </section>
          </FadeIn>
        )}

        <FadeIn delay={300}>
          <footer className="cohere-dark-band mt-16 px-6 py-10 sm:px-10">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <p className="cohere-mono-label mb-2 text-cohere-coral-soft">Smart Physical Therapy</p>
                <p className="font-display text-2xl font-normal tracking-tight text-cohere-on-primary">
                  RxSmart
                </p>
              </div>
              <p className="cohere-mono-label text-[11px] text-cohere-muted">{footerStatus}</p>
            </div>
          </footer>
        </FadeIn>
      </div>
    </main>
  );
}
