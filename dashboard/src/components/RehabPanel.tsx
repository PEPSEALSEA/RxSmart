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
  idle: "bg-cohere-muted",
  moving: "bg-cohere-on-primary animate-pulse-soft",
  holding: "bg-cohere-coral",
  rest: "bg-cohere-action-blue",
  complete: "bg-cohere-deep-green",
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
    <div className="flex h-full flex-col gap-6">
      <FadeIn>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT[feedback.status]}`} />
            <span className="cohere-mono-label text-[11px]">
              {STATUS_LABELS[feedback.status]}
            </span>
          </div>
          <span className="cohere-chip-coral" data-active="false">
            {exercise.category}
          </span>
        </div>
      </FadeIn>

      <FadeIn delay={60}>
        <div>
          <h2 className="font-display text-2xl font-normal tracking-[-0.02em] text-cohere-ink">
            {exercise.name}
          </h2>
          <p className="mt-2 text-base leading-relaxed text-cohere-body-muted">
            {exercise.description}
          </p>
        </div>
      </FadeIn>

      <FadeIn delay={120}>
        <div className="grid grid-cols-3 gap-3">
          <div className="cohere-product-card">
            <p className="cohere-mono-label text-[10px]">Rep</p>
            <p className="mt-1 font-mono-label text-xl font-medium tabular-nums text-cohere-ink">
              {feedback.rep}
              <span className="text-sm font-normal text-cohere-muted">/{feedback.totalReps}</span>
            </p>
          </div>
          <div className="cohere-product-card">
            <p className="cohere-mono-label text-[10px]">Phase</p>
            <p className="mt-1 truncate text-sm font-medium text-cohere-ink">{feedback.phaseLabel}</p>
          </div>
          <div className="rounded-cohere-sm bg-cohere-primary px-4 py-4 text-cohere-on-primary">
            <p className="cohere-mono-label text-[10px] text-cohere-muted">Score</p>
            <p className="mt-1 font-mono-label text-xl font-medium tabular-nums">{feedback.score}</p>
          </div>
        </div>
      </FadeIn>

      <FadeIn delay={160}>
        <div>
          <div className="mb-2 flex justify-between text-xs text-cohere-muted">
            <span>ความคืบหน้า</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-cohere-hairline/60">
            <div
              className="h-full rounded-full bg-cohere-primary transition-all duration-700 ease-out"
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
              className="animate-fade-in-only rounded-cohere-sm border border-cohere-hairline bg-cohere-pale-blue px-4 py-3 text-sm text-cohere-ink"
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
              className="cohere-btn-primary flex-1 text-sm active:scale-[0.98]"
            >
              {feedback.status === "complete" ? "ฝึกอีกครั้ง" : "เริ่มฝึก"}
            </button>
          ) : (
            <button
              type="button"
              onClick={onStop}
              className="flex-1 rounded-cohere-pill border border-cohere-hairline bg-cohere-soft-stone px-6 py-3 text-sm font-medium text-cohere-ink transition hover:bg-cohere-hairline/40 active:scale-[0.98]"
            >
              หยุดชั่วคราว
            </button>
          )}
          <button
            type="button"
            onClick={onReset}
            className="cohere-btn-pill-outline px-5 py-3 text-sm active:scale-[0.98]"
          >
            รีเซ็ต
          </button>
        </div>
      </FadeIn>

      <FadeIn delay={280} className="mt-auto flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setListOpen((open) => !open)}
          className="cohere-mono-label mb-3 flex w-full items-center justify-between text-left text-[11px] transition hover:text-cohere-ink"
        >
          <span>เลือกโปรแกรมฝึก</span>
          <span className="font-display text-lg text-cohere-muted">{listOpen ? "−" : "+"}</span>
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
                data-active={category === tab.id}
                className="cohere-chip-coral text-[11px] disabled:opacity-40"
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
                className={`animate-fade-in w-full rounded-cohere-sm border px-4 py-3 text-left text-sm transition disabled:opacity-40 ${
                  item.id === exercise.id
                    ? "border-cohere-primary bg-cohere-primary text-cohere-on-primary"
                    : "border-transparent bg-cohere-soft-stone text-cohere-ink hover:border-cohere-hairline"
                }`}
                style={{ animationDelay: `${index * 30}ms` }}
              >
                <span className="font-medium">{item.name}</span>
                <span
                  className={`ml-2 text-xs ${
                    item.id === exercise.id ? "text-cohere-muted" : "text-cohere-slate"
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
