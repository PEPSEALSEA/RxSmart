"use client";

import { useEffect, useRef, useState } from "react";
import { buildDirectionHints } from "@/lib/game-hints";
import { POSE_LABELS, PoseKey } from "@/lib/pose";
import { SessionFeedback, SessionStatus } from "@/lib/pose-physics";
import { agentDbgLog } from "@/lib/debug-session-log";

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "รอเริ่ม",
  moving: "ขยับตามท่า",
  holding: "ค้างท่า!",
  rest: "พักหายใจ",
  complete: "ผ่านแล้ว",
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
  sourceLabel?: string;
  holdProgress?: number;
}

function useOnTarget(feedback: SessionFeedback): boolean {
  if (feedback.status === "holding") return true;
  if (feedback.status !== "moving") return false;
  if (feedback.activeJoints.length === 0) return false;
  return feedback.activeJoints.every((key) => {
    const jf = feedback.jointFeedback[key];
    return !jf?.isActive || jf.angleOk;
  });
}

export default function GameHud({
  feedback,
  combo,
  exerciseName,
  muted,
  onToggleMute,
  imuMode = false,
  sourceLabel,
  holdProgress = 0,
}: GameHudProps) {
  const hints = buildDirectionHints(feedback, { ignorePlane: imuMode });
  const progress = feedback.totalReps > 0 ? (feedback.rep / feedback.totalReps) * 100 : 0;
  const scoreRing = Math.min(100, Math.max(0, feedback.score));
  const celebrating = feedback.status === "complete";
  const onTarget = useOnTarget(feedback);
  const holding = feedback.status === "holding";
  const tense = feedback.status === "moving" || holding;

  const [pulseMiss, setPulseMiss] = useState(false);
  const prevOk = useRef(onTarget);

  // #region agent log
  const statusRef = useRef(feedback.status);
  statusRef.current = feedback.status;
  useEffect(() => {
    agentDbgLog({
      hypothesisId: "C",
      location: "GameHud.tsx:mount",
      message: "GameHud mounted",
      data: {
        status: statusRef.current,
        exerciseName,
      },
    });
    return () => {
      agentDbgLog({
        hypothesisId: "C",
        location: "GameHud.tsx:unmount",
        message: "GameHud unmounted",
        data: { lastStatus: statusRef.current },
      });
    };
  }, [exerciseName]);
  // #endregion

  useEffect(() => {
    if (prevOk.current && !onTarget && feedback.status === "moving") {
      setPulseMiss(true);
      const t = window.setTimeout(() => setPulseMiss(false), 600);
      prevOk.current = onTarget;
      return () => window.clearTimeout(t);
    }
    prevOk.current = onTarget;
  }, [onTarget, feedback.status]);

  const activeDeltas = imuMode
    ? feedback.activeJoints
        .map((key) => {
          const delta =
            feedback.deltaByJoint?.[key] ??
            feedback.jointFeedback[key]?.delta ??
            null;
          return delta == null ? null : { key, delta };
        })
        .filter((row): row is { key: PoseKey; delta: number } => row != null)
    : [];

  const leaderKey = (feedback.leaderJoint ?? feedback.imuDiagnostics?.leaderJoint) as
    | PoseKey
    | undefined;
  const leaderLabel = leaderKey ? POSE_LABELS[leaderKey] ?? leaderKey : null;

  const ringColor = holding
    ? "#c98500"
    : onTarget
      ? "#1f7a4c"
      : pulseMiss || (tense && !onTarget)
        ? "#b42318"
        : "#0f6a62";

  const holdPct = Math.min(100, Math.max(0, holdProgress * 100));

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-3 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="max-w-[min(100%,22rem)] rounded-2xl border-2 border-[var(--rx-line)] bg-[var(--rx-sand)]/95 px-4 py-3 shadow-sm backdrop-blur-sm">
          <p className="font-game text-xs font-semibold uppercase tracking-wide text-[var(--rx-ink-soft)]">
            ท่าที่ฝึก
          </p>
          <p className="font-game mt-1 text-lg font-bold leading-snug text-[var(--rx-ink)] sm:text-xl">
            {exerciseName}
          </p>
          <p className="mt-1 text-base font-medium text-[var(--rx-ink)]">
            {STATUS_LABELS[feedback.status]}
            {feedback.phaseLabel ? ` · ${feedback.phaseLabel}` : ""}
          </p>
          {sourceLabel && (
            <p
              className={`mt-1 text-sm font-semibold ${
                sourceLabel.startsWith("DEBUG") ? "text-[var(--rx-warn)]" : "text-[var(--rx-ok)]"
              }`}
            >
              {sourceLabel.startsWith("DEBUG") ? "ทดลอง · ไม่มีบอร์ด" : "จริง · IMU เชื่อมแล้ว"}
            </p>
          )}
          {imuMode && leaderLabel && (
            <p className="mt-1 text-sm text-[var(--rx-ink-soft)]">นำโดย {leaderLabel}</p>
          )}
        </div>

        <div className="flex items-start gap-2">
          {combo > 0 && (
            <div
              className={`rounded-2xl border-2 px-3 py-2 text-center ${
                combo >= 3
                  ? "border-[var(--rx-gold)] bg-[var(--rx-warn-soft)] rx-hold-pulse"
                  : "border-[var(--rx-line)] bg-[var(--rx-sand)]/95"
              }`}
            >
              <p className="text-xs font-semibold text-[var(--rx-ink-soft)]">ต่อเนื่อง</p>
              <p className="font-game text-2xl font-bold tabular-nums text-[var(--rx-ink)]">
                {combo}
                <span className="text-base">×</span>
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={onToggleMute}
            className="pointer-events-auto min-h-12 min-w-12 rounded-2xl border-2 border-[var(--rx-line)] bg-[var(--rx-sand)] px-3 text-base font-semibold text-[var(--rx-ink)]"
            aria-label={muted ? "เปิดเสียง" : "ปิดเสียง"}
          >
            {muted ? "เปิดเสียง" : "ปิดเสียง"}
          </button>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3">
        {holding && (
          <div className="rx-hold-pulse w-full max-w-sm rounded-3xl border-2 border-[var(--rx-gold)] bg-[var(--rx-warn-soft)] px-5 py-4 text-center shadow-md">
            <p className="font-game text-2xl font-bold text-[var(--rx-ink)] sm:text-3xl">
              ค้างท่าไว้!
            </p>
            <div className="mt-3 h-4 overflow-hidden rounded-full bg-white/80">
              <div
                className="h-full rounded-full bg-[var(--rx-gold)] transition-[width] duration-150"
                style={{ width: `${holdPct || 8}%` }}
              />
            </div>
            <p className="mt-2 text-base font-medium text-[var(--rx-ink)]">อย่าขยับ · เกือบครบแล้ว</p>
          </div>
        )}

        {!holding && feedback.messages[0] && (
          <div
            className={`w-full max-w-lg rounded-2xl border-2 px-5 py-3.5 text-center shadow-sm ${
              pulseMiss || (tense && !onTarget)
                ? "border-[var(--rx-danger)] bg-[var(--rx-danger-soft)] rx-tension-flash"
                : onTarget
                  ? "border-[var(--rx-ok)] bg-[var(--rx-ok-soft)]"
                  : "border-[var(--rx-line)] bg-[var(--rx-sand)]/95"
            }`}
          >
            <p className="font-game text-lg font-semibold text-[var(--rx-ink)] sm:text-xl">
              {feedback.messages[0]}
            </p>
          </div>
        )}

        {imuMode && activeDeltas.length > 0 && !holding && (
          <div className="flex flex-wrap justify-center gap-2">
            {activeDeltas.map(({ key, delta }) => (
              <div
                key={key}
                className="rounded-xl border-2 border-[var(--rx-line)] bg-[var(--rx-sand)]/95 px-3 py-2 text-base font-semibold tabular-nums text-[var(--rx-ink)]"
              >
                {POSE_LABELS[key] ?? key} · {Math.round(delta)}°
              </div>
            ))}
          </div>
        )}

        {!holding && hints.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {hints.map((hint) => (
              <div
                key={hint.joint}
                className={`flex items-center gap-2 rounded-xl border-2 px-3 py-2 text-base font-medium ${
                  hint.arrow === "ok"
                    ? "border-[var(--rx-ok)] bg-[var(--rx-ok-soft)] text-[var(--rx-ok)]"
                    : "border-[var(--rx-line)] bg-[var(--rx-sand)]/95 text-[var(--rx-ink)]"
                }`}
              >
                <span className="font-game text-xl leading-none">{ARROW_GLYPH[hint.arrow]}</span>
                <span>{hint.tip}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="relative h-24 w-24 shrink-0 rounded-full border-2 border-[var(--rx-line)] bg-[var(--rx-sand)]/95 shadow-sm">
          <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90 p-1">
            <circle cx="18" cy="18" r="14.5" fill="none" stroke="#d9d1c2" strokeWidth="3.5" />
            <circle
              cx="18"
              cy="18"
              r="14.5"
              fill="none"
              stroke={ringColor}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={`${(scoreRing / 100) * 91} 91`}
              className="transition-[stroke-dasharray] duration-200"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-game text-2xl font-bold tabular-nums text-[var(--rx-ink)]">
              {Math.round(feedback.score)}
            </span>
            <span className="text-xs font-semibold text-[var(--rx-ink-soft)]">คะแนน</span>
          </div>
        </div>

        <div className="min-w-0 flex-1 rounded-2xl border-2 border-[var(--rx-line)] bg-[var(--rx-sand)]/95 px-4 py-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between text-base font-semibold text-[var(--rx-ink)]">
            <span>
              รอบ {feedback.rep}/{feedback.totalReps}
            </span>
            <span className="tabular-nums">{Math.round(progress)}%</span>
          </div>
          <div className="h-3.5 overflow-hidden rounded-full bg-[var(--rx-sand-deep)]">
            <div
              className="h-full rounded-full bg-[var(--rx-focus)] transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {celebrating && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--rx-stage-deep)]/45">
          <div className="rx-countdown-pop rounded-3xl border-2 border-[var(--rx-ok)] bg-[var(--rx-ok-soft)] px-8 py-7 text-center shadow-lg">
            <p className="font-game text-4xl font-bold text-[var(--rx-ok)] sm:text-5xl">ผ่านแล้ว!</p>
            <p className="mt-3 text-lg font-medium text-[var(--rx-ink)]">
              คะแนน {Math.round(feedback.score)} · เก่งมาก
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
