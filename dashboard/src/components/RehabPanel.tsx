"use client";

import { useMemo, useState } from "react";
import FadeIn from "@/components/ui/FadeIn";
import { ExerciseCategory, RehabExercise, REHAB_EXERCISES } from "@/lib/rehab-exercises";
import { SessionFeedback, SessionStatus } from "@/lib/pose-physics";

interface RehabPanelProps {
  exercise: RehabExercise;
  feedback: SessionFeedback;
  onSelectExercise: (exercise: RehabExercise) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "พร้อม",
  moving: "กำลังเคลื่อนไหว",
  holding: "ค้างท่า",
  rest: "พัก",
  complete: "เสร็จสิ้น",
};

const STATUS_DOT: Record<SessionStatus, string> = {
  idle: "bg-neutral-400",
  moving: "bg-neutral-900 animate-pulse-soft",
  holding: "bg-amber-500",
  rest: "bg-violet-500",
  complete: "bg-emerald-500",
};

const CATEGORY_TABS: { id: ExerciseCategory | "all"; label: string }[] = [
  { id: "all", label: "ทั้งหมด" },
  { id: "arm", label: "แขน" },
  { id: "leg", label: "ขา" },
  { id: "bilateral", label: "ทั้งตัว" },
  { id: "assessment", label: "ประเมิน" },
];

export default function RehabPanel({
  exercise,
  feedback,
  onSelectExercise,
  onStart,
  onStop,
  onReset,
}: RehabPanelProps) {
  const [category, setCategory] = useState<ExerciseCategory | "all">("all");
  const [listOpen, setListOpen] = useState(false);

  const isRunning = feedback.status !== "idle" && feedback.status !== "complete";
  const progress = feedback.totalReps > 0 ? (feedback.rep / feedback.totalReps) * 100 : 0;

  const filteredExercises = useMemo(
    () =>
      category === "all"
        ? REHAB_EXERCISES
        : REHAB_EXERCISES.filter((item) => item.category === category),
    [category],
  );

  return (
    <div className="flex h-full flex-col gap-5">
      <FadeIn>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT[feedback.status]}`} />
            <span className="text-xs font-medium tracking-wide text-neutral-500">
              {STATUS_LABELS[feedback.status]}
            </span>
          </div>
          <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            {exercise.category}
          </span>
        </div>
      </FadeIn>

      <FadeIn delay={60}>
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-neutral-900">{exercise.name}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-500">{exercise.description}</p>
        </div>
      </FadeIn>

      <FadeIn delay={120}>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-2xl border border-neutral-200/80 bg-neutral-50/50 px-3 py-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Rep</p>
            <p className="mt-1 font-mono text-lg font-semibold text-neutral-900">
              {feedback.rep}
              <span className="text-sm font-normal text-neutral-400">/{feedback.totalReps}</span>
            </p>
          </div>
          <div className="rounded-2xl border border-neutral-200/80 bg-neutral-50/50 px-3 py-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Phase</p>
            <p className="mt-1 truncate text-sm font-medium text-neutral-800">{feedback.phaseLabel}</p>
          </div>
          <div className="rounded-2xl border border-neutral-900/10 bg-neutral-900 px-3 py-3 text-white">
            <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">Score</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{feedback.score}</p>
          </div>
        </div>
      </FadeIn>

      <FadeIn delay={160}>
        <div>
          <div className="mb-2 flex justify-between text-[11px] text-neutral-400">
            <span>ความคืบหน้า</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full rounded-full bg-neutral-900 transition-all duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </FadeIn>

      {feedback.messages.length > 0 && (
        <FadeIn delay={200} className="space-y-2">
          {feedback.messages.map((msg, index) => (
            <p
              key={`${msg}-${index}`}
              className="animate-fade-in-only rounded-xl border border-neutral-200/80 bg-white px-3 py-2.5 text-sm text-neutral-600"
              style={{ animationDelay: `${220 + index * 60}ms` }}
            >
              {msg}
            </p>
          ))}
        </FadeIn>
      )}

      <FadeIn delay={240}>
        <div className="flex gap-2">
          {!isRunning ? (
            <button
              type="button"
              onClick={onStart}
              className="flex-1 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-neutral-800 active:scale-[0.98]"
            >
              {feedback.status === "complete" ? "ฝึกอีกครั้ง" : "เริ่มฝึก"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onStop}
              className="flex-1 rounded-xl bg-neutral-100 px-4 py-3 text-sm font-medium text-neutral-900 ring-1 ring-neutral-200 transition hover:bg-neutral-200 active:scale-[0.98]"
            >
              หยุดชั่วคราว
            </button>
          )}
          <button
            type="button"
            onClick={onReset}
            className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-medium text-neutral-600 transition hover:border-neutral-300 hover:bg-neutral-50 active:scale-[0.98]"
          >
            รีเซ็ต
          </button>
        </div>
      </FadeIn>

      <FadeIn delay={280} className="mt-auto flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setListOpen((open) => !open)}
          className="mb-3 flex w-full items-center justify-between text-left text-xs font-medium uppercase tracking-wider text-neutral-400 transition hover:text-neutral-600"
        >
          <span>เลือกโปรแกรมฝึก</span>
          <span className="text-neutral-300">{listOpen ? "−" : "+"}</span>
        </button>

        <div
          className={`overflow-hidden transition-all duration-500 ease-out ${
            listOpen ? "max-h-[320px] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          <div className="mb-3 flex flex-wrap gap-1.5">
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setCategory(tab.id)}
                disabled={isRunning}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 ${
                  category === tab.id
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
            {filteredExercises.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectExercise(item)}
                disabled={isRunning}
                className={`animate-fade-in w-full rounded-xl border px-3 py-2.5 text-left text-sm transition disabled:opacity-40 ${
                  item.id === exercise.id
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-transparent bg-neutral-50 text-neutral-700 hover:border-neutral-200 hover:bg-white"
                }`}
                style={{ animationDelay: `${index * 30}ms` }}
              >
                <span className="font-medium">{item.name}</span>
                <span
                  className={`ml-2 text-xs ${
                    item.id === exercise.id ? "text-neutral-400" : "text-neutral-400"
                  }`}
                >
                  {item.reps} reps
                </span>
              </button>
            ))}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
