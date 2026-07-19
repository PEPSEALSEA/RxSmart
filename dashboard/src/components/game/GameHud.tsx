"use client";

import { buildDirectionHints } from "@/lib/game-hints";
import { SessionFeedback, SessionStatus } from "@/lib/pose-physics";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "พร้อมเล่น",
  moving: "เคลื่อนไหว",
  holding: "ค้างท่า!",
  rest: "พัก",
  complete: "เคลียร์ด่าน",
};

const ARROW_GLYPH: Record<string, string> = {
  up: "↑",
  down: "↓",
  "rotate-cw": "↻",
  "rotate-ccw": "↺",
  "bend-more": "↷",
  "bend-less": "↶",
  ok: "✓",
};

interface GameHudProps {
  feedback: SessionFeedback;
  combo: number;
  exerciseName: string;
  muted: boolean;
  onToggleMute: () => void;
  imuMode?: boolean;
}

export default function GameHud({
  feedback,
  combo,
  exerciseName,
  muted,
  onToggleMute,
  imuMode = false,
}: GameHudProps) {
  const hints = buildDirectionHints(feedback, { ignorePlane: imuMode });
  const progress = feedback.totalReps > 0 ? (feedback.rep / feedback.totalReps) * 100 : 0;
  const scoreRing = Math.min(100, Math.max(0, feedback.score));
  const celebrating = feedback.status === "complete";

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="pointer-events-auto rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 backdrop-blur-md">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-cyan-300/80">
            Stage
          </p>
          <p className="mt-1 max-w-[14rem] text-sm font-semibold text-white sm:max-w-xs">
            {exerciseName}
          </p>
          <p className="mt-1 text-xs text-slate-300">
            {STATUS_LABELS[feedback.status]} · {feedback.phaseLabel}
          </p>
        </div>

        <div className="flex items-start gap-2">
          <div className="rounded-2xl border border-amber-400/30 bg-amber-500/15 px-3 py-2 text-center backdrop-blur-md">
            <p className="text-[10px] uppercase tracking-wider text-amber-200/90">Combo</p>
            <p className="font-mono text-2xl font-bold tabular-nums text-amber-300">
              {combo}
              <span className="text-sm text-amber-200/70">x</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleMute}
            className="pointer-events-auto rounded-xl border border-white/15 bg-slate-950/70 px-3 py-2 text-xs text-slate-200 backdrop-blur-md"
          >
            {muted ? "เสียงปิด" : "เสียงเปิด"}
          </button>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-3">
        {feedback.messages[0] && (
          <div className="rounded-2xl border border-cyan-400/25 bg-cyan-500/10 px-5 py-3 text-center backdrop-blur-md">
            <p className="text-sm font-medium text-cyan-50 sm:text-base">{feedback.messages[0]}</p>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-2">
          {hints.map((hint) => (
            <div
              key={hint.joint}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs backdrop-blur-md ${
                hint.arrow === "ok"
                  ? "border-emerald-400/40 bg-emerald-500/20 text-emerald-100"
                  : "border-white/15 bg-slate-950/65 text-slate-100"
              }`}
            >
              <span className="text-base leading-none">{ARROW_GLYPH[hint.arrow]}</span>
              <span>{hint.tip}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div className="relative h-20 w-20 shrink-0">
          <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(148,163,184,0.25)" strokeWidth="3" />
            <circle
              cx="18"
              cy="18"
              r="15.5"
              fill="none"
              stroke={scoreRing >= 80 ? "#34d399" : "#22d3ee"}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${(scoreRing / 100) * 97.4} 97.4`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-lg font-bold tabular-nums text-white">
              {Math.round(feedback.score)}
            </span>
            <span className="text-[9px] uppercase tracking-wider text-slate-400">score</span>
          </div>
        </div>

        <div className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
            <span>
              Rep {feedback.rep}/{feedback.totalReps}
            </span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {celebrating && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/40">
          <div className="animate-pulse rounded-3xl border border-emerald-400/40 bg-emerald-500/20 px-8 py-6 text-center backdrop-blur-md">
            <p className="text-3xl font-bold text-emerald-200">CLEAR!</p>
            <p className="mt-2 text-sm text-emerald-100/90">เสร็จโปรแกรม · คะแนน {Math.round(feedback.score)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
