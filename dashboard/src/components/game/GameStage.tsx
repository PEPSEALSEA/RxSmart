"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import GameControls from "@/components/game/GameControls";
import GameHud from "@/components/game/GameHud";
import { useGameAudio } from "@/hooks/useGameAudio";
import {
  lerpFrames,
  resolvedPoseToFrame,
} from "@/lib/glb-pose-map";
import { resolvePose } from "@/lib/pose";
import { SessionFeedback, SensorFrame } from "@/lib/pose-physics";
import { RehabExercise } from "@/lib/rehab-exercises";
import { applyImuDisplayPlanes } from "@/lib/sensor-mapping";
const GamePoseCanvas = dynamic(() => import("@/components/game/GamePoseCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[420px] items-center justify-center bg-[var(--rx-stage)] font-game text-lg text-white/80">
      กำลังโหลดเวทีฝึก…
    </div>
  ),
});

interface GameStageProps {
  frame: SensorFrame;
  feedback: SessionFeedback;
  exercise: RehabExercise;
  onSelectExercise: (exercise: RehabExercise) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  imuMode?: boolean;
  /** DEBUG · no board vs LIVE · IMU */
  sourceLabel?: string;
}

function useCombo(feedback: SessionFeedback): number {
  const [combo, setCombo] = useState(0);
  const prevStatus = useRef(feedback.status);
  const prevRep = useRef(feedback.rep);
  const missTicks = useRef(0);

  useEffect(() => {
    const prev = prevStatus.current;

    if (prev !== "holding" && feedback.status === "holding") {
      setCombo((c) => c + 1);
      missTicks.current = 0;
    }

    if (feedback.rep > prevRep.current) {
      setCombo((c) => c + 1);
      missTicks.current = 0;
    }

    if (feedback.status === "idle") {
      setCombo(0);
      missTicks.current = 0;
    }

    const activeOk =
      feedback.activeJoints.length === 0 ||
      feedback.activeJoints.every((key) => {
        const jf = feedback.jointFeedback[key];
        return !jf?.isActive || jf.angleOk;
      });

    if (feedback.status === "moving" && !activeOk) {
      missTicks.current += 1;
      if (missTicks.current > 45) {
        setCombo(0);
        missTicks.current = 0;
      }
    } else if (activeOk) {
      missTicks.current = 0;
    }

    prevStatus.current = feedback.status;
    prevRep.current = feedback.rep;
  }, [
    feedback.activeJoints,
    feedback.jointFeedback,
    feedback.rep,
    feedback.status,
  ]);

  return combo;
}

function useGhostFrame(
  exercise: RehabExercise,
  feedback: SessionFeedback,
): SensorFrame {
  const [ghost, setGhost] = useState(() =>
    resolvedPoseToFrame(exercise.startPose),
  );
  const phaseIndex = useMemo(() => {
    const idx = exercise.phases.findIndex((p) => p.label === feedback.phaseLabel);
    return idx >= 0 ? idx : 0;
  }, [exercise.phases, feedback.phaseLabel]);

  useEffect(() => {
    let raf = 0;
    let start = performance.now();
    const from = resolvedPoseToFrame(exercise.startPose);
    const phase = exercise.phases[phaseIndex] ?? exercise.phases[0];
    const to = resolvedPoseToFrame(resolvePose(exercise.startPose, phase.targets));
    const animateDemo = feedback.status === "idle" || feedback.status === "rest";

    const tick = (now: number) => {
      let next: SensorFrame;
      if (animateDemo) {
        const t = ((now - start) / 1800) % 2;
        const u = t < 1 ? t : 2 - t;
        next = lerpFrames(from, to, u);
      } else {
        next = to;
      }
      setGhost(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [exercise, feedback.status, phaseIndex]);

  return ghost;
}

/** Approximate hold fill from status + phase holdSeconds (visual tension only). */
function useHoldProgress(feedback: SessionFeedback, exercise: RehabExercise): number {
  const [progress, setProgress] = useState(0);
  const holdStarted = useRef<number | null>(null);

  const holdSeconds = useMemo(() => {
    const phase = exercise.phases.find((p) => p.label === feedback.phaseLabel);
    return phase?.holdSeconds ?? 0;
  }, [exercise.phases, feedback.phaseLabel]);

  useEffect(() => {
    if (feedback.status !== "holding" || holdSeconds <= 0) {
      holdStarted.current = null;
      setProgress(0);
      return;
    }
    if (holdStarted.current == null) holdStarted.current = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const started = holdStarted.current ?? now;
      setProgress(Math.min(1, (now - started) / (holdSeconds * 1000)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [feedback.status, feedback.phaseLabel, holdSeconds]);

  return progress;
}

export default function GameStage({
  frame,
  feedback,
  exercise,
  onSelectExercise,
  onStart,
  onStop,
  onReset,
  imuMode = false,
  sourceLabel,
}: GameStageProps) {
  const combo = useCombo(feedback);
  const ghostFrame = useGhostFrame(exercise, feedback);
  const holdProgress = useHoldProgress(feedback, exercise);
  const { muted, toggleMute } = useGameAudio(feedback, true);
  const playerFrame = imuMode ? applyImuDisplayPlanes(frame, ghostFrame) : frame;
  const safeFeedback = feedback;
  const inSession =
    feedback.status === "moving" ||
    feedback.status === "holding" ||
    feedback.status === "rest" ||
    feedback.status === "complete";

  return (
    <section className="rx-game overflow-hidden rounded-[28px] border-2 border-[var(--rx-line)] bg-[var(--rx-sand)] shadow-[0_18px_50px_rgba(26,35,50,0.12)]">
      <div className="border-b border-[var(--rx-line)] bg-[var(--rx-sand-deep)] px-5 py-4 sm:px-6">
        <p className="font-game text-2xl font-bold text-[var(--rx-ink)] sm:text-3xl">ฝึกท่า Live IMU</p>
        <p className="mt-1 max-w-2xl text-base text-[var(--rx-ink-soft)]">
          เลือกท่า → ดูขั้นตอน → เริ่มฝึก ใช้ได้ทั้งโหมดทดลองและโหมดบอร์ดจริง
        </p>
      </div>

      <div className="grid lg:grid-cols-12">
        <div className="relative min-h-[520px] lg:col-span-7 xl:col-span-8">
          <GamePoseCanvas
            frame={playerFrame}
            ghostFrame={ghostFrame}
            activeJoints={safeFeedback.activeJoints}
            showGhost
            imuMode={imuMode}
            tension={
              safeFeedback.status === "holding"
                ? "hold"
                : safeFeedback.status === "moving"
                  ? "move"
                  : "idle"
            }
          />
          {inSession && (
            <GameHud
              feedback={safeFeedback}
              combo={combo}
              exerciseName={exercise.name}
              muted={muted}
              onToggleMute={toggleMute}
              imuMode={imuMode}
              sourceLabel={sourceLabel}
              holdProgress={holdProgress}
            />
          )}
        </div>

        <aside className="border-t border-[var(--rx-line)] bg-[var(--rx-sand)] p-5 lg:col-span-5 xl:col-span-4 lg:border-l lg:border-t-0">
          <GameControls
            exercise={exercise}
            feedback={safeFeedback}
            onSelectExercise={onSelectExercise}
            onStart={onStart}
            onStop={onStop}
            onReset={onReset}
            imuMode={imuMode}
            sourceLabel={sourceLabel}
          />
        </aside>
      </div>
    </section>
  );
}
