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

const GamePoseCanvas = dynamic(() => import("@/components/game/GamePoseCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[420px] items-center justify-center bg-[#0b1220] text-sm text-slate-400">
      กำลังโหลดเวทีเกม 3D…
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
      if (missTicks.current > 60) {
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

function useGhostFrame(exercise: RehabExercise, feedback: SessionFeedback): SensorFrame {
  const [ghost, setGhost] = useState(() => resolvedPoseToFrame(exercise.startPose));
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
      if (animateDemo) {
        const t = ((now - start) / 1800) % 2;
        const u = t < 1 ? t : 2 - t;
        setGhost(lerpFrames(from, to, u));
      } else {
        setGhost(to);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [exercise, feedback.status, phaseIndex]);

  return ghost;
}

export default function GameStage({
  frame,
  feedback,
  exercise,
  onSelectExercise,
  onStart,
  onStop,
  onReset,
}: GameStageProps) {
  const combo = useCombo(feedback);
  const ghostFrame = useGhostFrame(exercise, feedback);
  const { muted, toggleMute } = useGameAudio(feedback, true);

  return (
    <section className="overflow-hidden rounded-3xl border border-slate-700/80 bg-[#0b1220] shadow-[0_0_60px_rgba(34,211,238,0.08)]">
      <div className="grid lg:grid-cols-12">
        <div className="relative min-h-[520px] lg:col-span-8 xl:col-span-9">
          <GamePoseCanvas
            frame={frame}
            ghostFrame={ghostFrame}
            activeJoints={feedback.activeJoints}
            showGhost
          />
          <GameHud
            feedback={feedback}
            combo={combo}
            exerciseName={exercise.name}
            muted={muted}
            onToggleMute={toggleMute}
          />
          <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex gap-3 text-[10px] uppercase tracking-wider text-slate-400">
            <span className="rounded-full bg-slate-950/70 px-2 py-1">คุณ</span>
            <span className="rounded-full bg-cyan-500/20 px-2 py-1 text-cyan-200">โค้ช (ท่าเป้าหมาย)</span>
          </div>
        </div>

        <aside className="border-t border-white/10 bg-slate-950/90 p-5 lg:col-span-4 xl:col-span-3 lg:border-l lg:border-t-0">
          <GameControls
            exercise={exercise}
            feedback={feedback}
            onSelectExercise={onSelectExercise}
            onStart={onStart}
            onStop={onStop}
            onReset={onReset}
          />
        </aside>
      </div>
    </section>
  );
}
