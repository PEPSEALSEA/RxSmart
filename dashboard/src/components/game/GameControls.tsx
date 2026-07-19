"use client";

import { useMemo, useState } from "react";
import { playSfx, unlockGameAudio } from "@/lib/game-audio";
import { ExerciseCategory, RehabExercise, REHAB_EXERCISES } from "@/lib/rehab-exercises";
import { SessionFeedback } from "@/lib/pose-physics";

interface GameControlsProps {
  exercise: RehabExercise;
  feedback: SessionFeedback;
  onSelectExercise: (exercise: RehabExercise) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}

const CATEGORY_TABS: { id: ExerciseCategory | "all"; label: string }[] = [
  { id: "all", label: "ทั้งหมด" },
  { id: "arm", label: "แขน" },
  { id: "leg", label: "ขา" },
  { id: "bilateral", label: "ทั้งตัว" },
];

export default function GameControls({
  exercise,
  feedback,
  onSelectExercise,
  onStart,
  onStop,
  onReset,
}: GameControlsProps) {
  const [category, setCategory] = useState<ExerciseCategory | "all">("all");
  const [listOpen, setListOpen] = useState(false);
  const isRunning = feedback.status !== "idle" && feedback.status !== "complete";

  const filtered = useMemo(
    () =>
      category === "all"
        ? REHAB_EXERCISES
        : REHAB_EXERCISES.filter((item) => item.category === category),
    [category],
  );

  const handleStart = () => {
    void unlockGameAudio().then(() => playSfx("click"));
    onStart();
  };

  return (
    <div className="flex h-full flex-col gap-4 text-slate-100">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-cyan-300/80">
          เลือกด่าน
        </p>
        <button
          type="button"
          onClick={() => setListOpen((o) => !o)}
          className="mt-2 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-left text-sm hover:bg-white/10"
        >
          <span className="font-medium text-white">{exercise.name}</span>
          <span className="mt-0.5 block text-xs text-slate-400">{exercise.description}</span>
        </button>
      </div>

      {listOpen && (
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/80 p-2">
          <div className="mb-2 flex flex-wrap gap-1">
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setCategory(tab.id)}
                className={`rounded-full px-2.5 py-1 text-[11px] ${
                  category === tab.id
                    ? "bg-cyan-500/30 text-cyan-100"
                    : "bg-white/5 text-slate-400"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {filtered.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectExercise(item);
                setListOpen(false);
                playSfx("click");
              }}
              className={`block w-full rounded-lg px-2.5 py-2 text-left text-xs ${
                item.id === exercise.id
                  ? "bg-cyan-500/25 text-cyan-50"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2">
        {!isRunning ? (
          <button
            type="button"
            onClick={handleStart}
            className="rounded-xl bg-gradient-to-r from-cyan-400 to-emerald-400 px-4 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/20"
          >
            {feedback.status === "complete" ? "เล่นอีกครั้ง" : "เริ่มฝึก"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onStop}
            className="rounded-xl border border-rose-400/40 bg-rose-500/20 px-4 py-3 text-sm font-semibold text-rose-100"
          >
            หยุด
          </button>
        )}
        <button
          type="button"
          onClick={onReset}
          className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-slate-200 hover:bg-white/10"
        >
          รีเซ็ต
        </button>
      </div>
    </div>
  );
}
