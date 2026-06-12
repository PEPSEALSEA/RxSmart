"use client";

import { RehabExercise, REHAB_EXERCISES } from "@/lib/rehab-exercises";
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

const STATUS_COLORS: Record<SessionStatus, string> = {
  idle: "bg-slate-100 text-slate-600",
  moving: "bg-sky-100 text-sky-700",
  holding: "bg-amber-100 text-amber-700",
  rest: "bg-violet-100 text-violet-700",
  complete: "bg-emerald-100 text-emerald-700",
};

export default function RehabPanel({
  exercise,
  feedback,
  onSelectExercise,
  onStart,
  onStop,
  onReset,
}: RehabPanelProps) {
  const isRunning = feedback.status !== "idle" && feedback.status !== "complete";
  const progress = feedback.totalReps > 0 ? (feedback.rep / feedback.totalReps) * 100 : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-sky-100 bg-gradient-to-br from-white to-sky-50/60 p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-sky-500">โปรแกรมฝึก</p>
            <p className="mt-1 text-lg font-semibold text-slate-800">{exercise.name}</p>
          </div>
          <span className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[feedback.status]}`}>
            {STATUS_LABELS[feedback.status]}
          </span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">{exercise.description}</p>

        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1">
            <div className="mb-1 flex justify-between text-xs text-slate-400">
              <span>Rep {feedback.rep}/{feedback.totalReps}</span>
              <span>{feedback.phaseLabel}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-sky-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-sky-400 to-cyan-400 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
          <div className="text-center">
            <p className="text-xs text-slate-400">คะแนน</p>
            <p className="text-xl font-bold text-sky-600">{feedback.score}</p>
          </div>
        </div>
      </div>

      {feedback.messages.length > 0 && (
        <div className="space-y-1.5">
          {feedback.messages.map((msg) => (
            <p
              key={msg}
              className="rounded-xl border border-sky-100 bg-white px-3 py-2 text-sm text-slate-600"
            >
              {msg}
            </p>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {!isRunning ? (
          <button
            type="button"
            onClick={onStart}
            className="flex-1 rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-sky-200 transition hover:bg-sky-600"
          >
            {feedback.status === "complete" ? "ฝึกอีกครั้ง" : "เริ่มฝึก"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onStop}
            className="flex-1 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-600"
          >
            หยุด
          </button>
        )}
        <button
          type="button"
          onClick={onReset}
          className="rounded-xl border border-sky-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-sky-50"
        >
          รีเซ็ต
        </button>
      </div>

      <div className="max-h-36 space-y-1 overflow-y-auto">
        {REHAB_EXERCISES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectExercise(item)}
            disabled={isRunning}
            className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${
              item.id === exercise.id
                ? "border-sky-300 bg-sky-50 font-medium text-sky-800"
                : "border-sky-100 bg-white/80 text-slate-600 hover:border-sky-200 hover:bg-sky-50/50"
            }`}
          >
            {item.name}
            <span className="ml-2 text-xs text-slate-400">{item.reps} reps</span>
          </button>
        ))}
      </div>
    </div>
  );
}
