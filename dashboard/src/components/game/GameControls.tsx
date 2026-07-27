"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { playSfx, unlockGameAudio } from "@/lib/game-audio";
import {
  applyExerciseOverride,
  captureCorrectStep,
  captureDefaultStep,
  catalogOverrideFromExercise,
  clearOverride,
  ExercisePoseOverride,
  getOverride,
  saveOverride,
} from "@/lib/exercise-pose-overrides";
import { ExerciseCategory, RehabExercise, REHAB_EXERCISES, supportsImuExercise } from "@/lib/rehab-exercises";
import { SessionFeedback, SensorFrame } from "@/lib/pose-physics";

interface GameControlsProps {
  exercise: RehabExercise;
  catalogExercise: RehabExercise;
  feedback: SessionFeedback;
  liveFrame: SensorFrame;
  onSelectExercise: (exercise: RehabExercise) => void;
  onExerciseReady: (exercise: RehabExercise, override: ExercisePoseOverride) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  imuMode?: boolean;
  sourceLabel?: string;
}

type Screen = "select" | "brief" | "calibrate" | "play";

type CalibStep =
  | { kind: "default"; label: string }
  | { kind: "correct"; phaseId: string; label: string };

const CATEGORY_TABS: { id: ExerciseCategory | "all"; label: string }[] = [
  { id: "all", label: "ทั้งหมด" },
  { id: "arm", label: "แขน" },
  { id: "leg", label: "ขา" },
  { id: "bilateral", label: "ทั้งตัว" },
];

const CATEGORY_NAME: Record<ExerciseCategory, string> = {
  arm: "แขน",
  leg: "ขา",
  bilateral: "ทั้งตัว",
  assessment: "ประเมิน",
};

function thaiDescription(exercise: RehabExercise): string {
  const plain = exercise.description
    .replace(/\s*—\s*.*$/, "")
    .replace(/\b(Shoulder|Elbow|Hip|Freestyle|Abduction|flexion)\b/gi, "")
    .trim();
  if (plain.length >= 8) return plain;
  return `${exercise.phases.length} ขั้นตอน · ${exercise.reps} ครั้ง`;
}

function buildCalibSteps(exercise: RehabExercise): CalibStep[] {
  const steps: CalibStep[] = [{ kind: "default", label: "ท่าเริ่มต้น (default)" }];
  for (const phase of exercise.phases) {
    if (phase.activeJoints.length === 0) continue;
    steps.push({ kind: "correct", phaseId: phase.id, label: `ท่าถูก · ${phase.label}` });
  }
  return steps;
}

export default function GameControls({
  exercise,
  catalogExercise,
  feedback,
  liveFrame,
  onSelectExercise,
  onExerciseReady,
  onStart,
  onStop,
  onReset,
  imuMode = false,
  sourceLabel,
}: GameControlsProps) {
  const [category, setCategory] = useState<ExerciseCategory | "all">("all");
  const [screen, setScreen] = useState<Screen>("select");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [calibIndex, setCalibIndex] = useState(0);
  const [draft, setDraft] = useState<ExercisePoseOverride | null>(null);
  const [calibMsg, setCalibMsg] = useState("");
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;

  const isRunning = feedback.status !== "idle" && feedback.status !== "complete";
  const isComplete = feedback.status === "complete";
  const isDebug = Boolean(sourceLabel?.startsWith("DEBUG"));

  const filtered = useMemo(
    () =>
      (category === "all"
        ? REHAB_EXERCISES
        : REHAB_EXERCISES.filter((item) => item.category === category)
      ).filter((item) => !imuMode || supportsImuExercise(item)),
    [category, imuMode],
  );

  const phaseIndex = useMemo(() => {
    const idx = exercise.phases.findIndex((p) => p.label === feedback.phaseLabel);
    return idx >= 0 ? idx : 0;
  }, [exercise.phases, feedback.phaseLabel]);

  const calibSteps = useMemo(() => buildCalibSteps(catalogExercise), [catalogExercise]);
  const currentCalib = calibSteps[calibIndex] ?? calibSteps[0];

  useEffect(() => {
    if (isRunning || isComplete) setScreen("play");
    else if (feedback.status === "idle" && countdown == null && screen === "play") {
      setScreen("brief");
    }
  }, [isRunning, isComplete, feedback.status, countdown, screen]);

  useEffect(() => {
    if (countdown == null) return;
    if (countdown === 0) {
      setCountdown(null);
      onStartRef.current();
      return;
    }
    playSfx("tick");
    const t = window.setTimeout(() => setCountdown((c) => (c == null ? null : c - 1)), 700);
    return () => window.clearTimeout(t);
  }, [countdown]);

  const beginCalibrate = (base: RehabExercise) => {
    const existing = getOverride(base.id);
    setDraft(existing ?? catalogOverrideFromExercise(base));
    setCalibIndex(0);
    setCalibMsg(existing ? "มีค่าที่ตั้งไว้แล้ว — จับใหม่หรือใช้ค่าเดิมได้" : "จับท่าจากบอร์ดตาม wizard map");
    setScreen("calibrate");
  };

  const handlePick = (item: RehabExercise) => {
    onSelectExercise(item);
    setScreen("brief");
    playSfx("click");
  };

  const finishCalibrate = (override: ExercisePoseOverride) => {
    saveOverride(override);
    const ready = applyExerciseOverride(catalogExercise, override);
    onExerciseReady(ready, override);
    setDraft(override);
    setCalibMsg("บันทึกท่าแล้ว");
    playSfx("click");
  };

  const handleCaptureNow = () => {
    if (!draft || !currentCalib) return;
    const next: ExercisePoseOverride = {
      ...draft,
      exerciseId: catalogExercise.id,
      phases: { ...draft.phases },
      capturedAt: Date.now(),
    };
    if (currentCalib.kind === "default") {
      next.startPose = captureDefaultStep(catalogExercise, liveFrame, imuMode);
      setCalibMsg("จับท่าเริ่มต้นแล้ว");
    } else {
      next.phases[currentCalib.phaseId] = captureCorrectStep(
        catalogExercise,
        currentCalib.phaseId,
        liveFrame,
        imuMode,
        next.startPose,
      );
      setCalibMsg(`จับท่าถูก · ${currentCalib.label} แล้ว`);
    }
    setDraft(next);
    playSfx("click");
  };

  const handleUseCatalogStep = () => {
    if (!draft || !currentCalib) return;
    const catalog = catalogOverrideFromExercise(catalogExercise);
    const next: ExercisePoseOverride = {
      ...draft,
      exerciseId: catalogExercise.id,
      phases: { ...draft.phases },
      capturedAt: Date.now(),
    };
    if (currentCalib.kind === "default") {
      next.startPose = structuredClone(catalog.startPose);
      setCalibMsg("ใช้ค่ามาตรฐานสำหรับท่าเริ่มต้น");
    } else {
      next.phases[currentCalib.phaseId] = structuredClone(
        catalog.phases[currentCalib.phaseId] ?? {},
      );
      setCalibMsg(`ใช้ค่ามาตรฐาน · ${currentCalib.label}`);
    }
    setDraft(next);
    playSfx("click");
  };

  const handleCalibNext = () => {
    if (!draft) return;
    if (calibIndex < calibSteps.length - 1) {
      setCalibIndex((i) => i + 1);
      setCalibMsg("");
      playSfx("click");
      return;
    }
    finishCalibrate(draft);
    setCountdown(3);
  };

  const handleSkipAllCatalog = () => {
    const catalog = catalogOverrideFromExercise(catalogExercise);
    finishCalibrate(catalog);
    setCountdown(3);
  };

  const handleResetOverrides = () => {
    clearOverride(catalogExercise.id);
    const fresh = catalogOverrideFromExercise(catalogExercise);
    setDraft(fresh);
    setCalibIndex(0);
    setCalibMsg("รีเซ็ตเป็นค่ามาตรฐานแล้ว");
    onSelectExercise(catalogExercise);
    playSfx("click");
  };

  const handleBeginFromBrief = () => {
    void unlockGameAudio().then(() => playSfx("click"));
    beginCalibrate(catalogExercise);
  };

  const handleBeginCountdown = () => {
    void unlockGameAudio().then(() => playSfx("click"));
    const existing = getOverride(catalogExercise.id);
    if (existing) {
      finishCalibrate(existing);
      setCountdown(3);
      return;
    }
    beginCalibrate(catalogExercise);
  };

  const handleStop = () => {
    onStop();
    setScreen("brief");
    setCountdown(null);
  };

  const handleReset = () => {
    onReset();
    setCountdown(null);
    setScreen("brief");
  };

  const handleChooseAnother = () => {
    onReset();
    setCountdown(null);
    setScreen("select");
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-game text-[13px] font-semibold tracking-wide text-[var(--rx-ink-soft)]">
            ฝึกท่าทีละขั้น
          </p>
          <p className="mt-0.5 text-sm text-[var(--rx-ink-soft)]">
            {isDebug ? "โหมดทดลอง · ไม่ต้องมีบอร์ด" : "โหมดจริง · บอร์ด IMU"}
          </p>
        </div>
        {screen !== "select" && !isRunning && countdown == null && (
          <button
            type="button"
            onClick={handleChooseAnother}
            className="rounded-xl border border-[var(--rx-line)] bg-white px-3 py-2 text-sm font-medium text-[var(--rx-ink)]"
          >
            เลือกท่าใหม่
          </button>
        )}
      </div>

      {screen === "select" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <p className="font-game text-xl font-semibold text-[var(--rx-ink)] sm:text-2xl">
            1. เลือกท่าที่จะฝึก
          </p>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setCategory(tab.id)}
                className={`min-h-11 rounded-xl px-4 text-base font-medium ${
                  category === tab.id
                    ? "bg-[var(--rx-focus)] text-white"
                    : "border border-[var(--rx-line)] bg-white text-[var(--rx-ink)]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {imuMode && (
              <p className="rounded-xl border border-[var(--rx-line)] bg-[var(--rx-sand)] px-3 py-2 text-sm text-[var(--rx-ink-soft)]">
                โหมด IMU แสดงเฉพาะท่าที่วัดได้จริงจากบอร์ดเดียวแกนเดียว
              </p>
            )}
            {filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handlePick(item)}
                className={`block w-full rounded-2xl border px-4 py-3.5 text-left transition ${
                  item.id === exercise.id
                    ? "border-[var(--rx-focus)] bg-[var(--rx-focus-soft)]"
                    : "border-[var(--rx-line)] bg-white hover:border-[var(--rx-focus)]"
                }`}
              >
                <span className="flex items-start gap-3">
                  <span className="font-game flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--rx-sand-deep)] text-lg font-bold text-[var(--rx-ink)]">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="font-game block text-lg font-semibold text-[var(--rx-ink)]">
                      {item.name}
                    </span>
                    <span className="mt-1 block text-sm text-[var(--rx-ink-soft)]">
                      {CATEGORY_NAME[item.category]} · {item.phases.length} ขั้น · {item.reps} ครั้ง
                    </span>
                    <span className="mt-1 block text-sm text-[var(--rx-ink-soft)]">
                      {thaiDescription(item)}
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {screen === "brief" && (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div>
            <p className="font-game text-xl font-semibold text-[var(--rx-ink)] sm:text-2xl">
              2. ดูขั้นตอนก่อนเริ่ม
            </p>
            <p className="mt-2 font-game text-lg font-medium text-[var(--rx-focus)]">
              {exercise.name}
            </p>
            <p className="mt-1 text-base text-[var(--rx-ink-soft)]">{thaiDescription(exercise)}</p>
          </div>

          <ol className="space-y-2">
            {exercise.phases.map((phase, index) => (
              <li
                key={phase.id}
                className="flex items-center gap-3 rounded-2xl border border-[var(--rx-line)] bg-white px-3 py-3"
              >
                <span className="font-game flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--rx-sand-deep)] text-lg font-bold">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="font-game block text-lg font-semibold text-[var(--rx-ink)]">
                    {phase.label}
                  </span>
                  <span className="text-sm text-[var(--rx-ink-soft)]">
                    {phase.holdSeconds > 0
                      ? `ค้างประมาณ ${phase.holdSeconds} วินาที`
                      : "เคลื่อนไหวไปยังท่านี้"}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          <p className="rounded-xl bg-[var(--rx-warn-soft)] px-3 py-2 text-sm text-[var(--rx-warn)]">
            ก่อนเริ่มจะตั้งท่า default + ท่าถูกของแต่ละขั้น · โมเดลผู้ใช้จะ fake ตามครูเมื่ออยู่ใน range
          </p>

          <div className="mt-auto flex flex-col gap-2">
            {countdown != null ? (
              <div className="flex min-h-14 items-center justify-center rounded-2xl bg-[var(--rx-ink)] text-white">
                <span className="rx-countdown-pop font-game text-4xl font-bold tabular-nums">
                  {countdown === 0 ? "เริ่ม!" : countdown}
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleBeginFromBrief}
                className="min-h-14 rounded-2xl bg-[var(--rx-focus)] px-4 text-lg font-semibold text-white shadow-md"
              >
                3. ตั้งท่าก่อนเล่น
              </button>
            )}
            {getOverride(catalogExercise.id) && countdown == null && (
              <button
                type="button"
                onClick={handleBeginCountdown}
                className="min-h-12 rounded-2xl border border-[var(--rx-line)] bg-white px-4 text-base font-medium text-[var(--rx-ink)]"
              >
                ใช้ท่าที่ตั้งไว้แล้ว · เริ่มเลย
              </button>
            )}
            <button
              type="button"
              onClick={handleChooseAnother}
              className="min-h-12 rounded-2xl border border-[var(--rx-line)] bg-white px-4 text-base font-medium text-[var(--rx-ink)]"
            >
              กลับไปเลือกท่า
            </button>
          </div>
        </div>
      )}

      {screen === "calibrate" && currentCalib && (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div>
            <p className="font-game text-xl font-semibold text-[var(--rx-ink)] sm:text-2xl">
              3. ตั้งท่าก่อนเล่น
            </p>
            <p className="mt-2 font-game text-lg font-medium text-[var(--rx-focus)]">
              {catalogExercise.name}
            </p>
            <p className="mt-1 text-sm text-[var(--rx-ink-soft)]">
              ขั้น {calibIndex + 1} / {calibSteps.length} · ใช้บอร์ดตาม setup wizard
            </p>
          </div>

          <div className="rounded-2xl border border-[var(--rx-focus)] bg-[var(--rx-focus-soft)] px-4 py-4">
            <p className="font-game text-lg font-semibold text-[var(--rx-ink)]">{currentCalib.label}</p>
            <p className="mt-2 text-sm text-[var(--rx-ink-soft)]">
              {currentCalib.kind === "default"
                ? "ยืน/นั่งตามท่าเริ่มต้น แล้วกดจับท่า (หรือใช้ค่ามาตรฐาน)"
                : "ทำท่าเป้าหมายของขั้นนี้ค้างไว้ แล้วกดจับท่า — ไม่ต้องเป๊ะ แค่ในช่วงที่วัดได้"}
            </p>
            {calibMsg && <p className="mt-2 text-sm font-medium text-[var(--rx-focus)]">{calibMsg}</p>}
          </div>

          <ol className="max-h-40 space-y-1 overflow-y-auto">
            {calibSteps.map((step, i) => (
              <li
                key={`${step.kind}-${step.kind === "correct" ? step.phaseId : "default"}`}
                className={`rounded-xl px-3 py-2 text-sm ${
                  i === calibIndex
                    ? "bg-[var(--rx-warn-soft)] font-semibold text-[var(--rx-warn)]"
                    : i < calibIndex
                      ? "text-[var(--rx-ok)]"
                      : "text-[var(--rx-ink-soft)]"
                }`}
              >
                {i < calibIndex ? "✓ " : `${i + 1}. `}
                {step.label}
              </li>
            ))}
          </ol>

          <div className="mt-auto flex flex-col gap-2">
            {countdown != null ? (
              <div className="flex min-h-14 items-center justify-center rounded-2xl bg-[var(--rx-ink)] text-white">
                <span className="rx-countdown-pop font-game text-4xl font-bold tabular-nums">
                  {countdown === 0 ? "เริ่ม!" : countdown}
                </span>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleCaptureNow}
                  className="min-h-14 rounded-2xl bg-[var(--rx-focus)] px-4 text-lg font-semibold text-white shadow-md"
                >
                  จับท่าตอนนี้
                </button>
                <button
                  type="button"
                  onClick={handleUseCatalogStep}
                  className="min-h-12 rounded-2xl border border-[var(--rx-line)] bg-white px-4 text-base font-medium"
                >
                  ใช้ค่ามาตรฐานขั้นนี้
                </button>
                <button
                  type="button"
                  onClick={handleCalibNext}
                  className="min-h-12 rounded-2xl border-2 border-[var(--rx-ok)] bg-[var(--rx-ok-soft)] px-4 text-base font-semibold text-[var(--rx-ok)]"
                >
                  {calibIndex < calibSteps.length - 1 ? "ขั้นถัดไป" : "บันทึกแล้วเริ่มฝึก"}
                </button>
                <button
                  type="button"
                  onClick={handleSkipAllCatalog}
                  className="min-h-11 rounded-2xl border border-[var(--rx-line)] bg-white px-4 text-sm font-medium text-[var(--rx-ink-soft)]"
                >
                  ข้ามทั้งหมด · ใช้ค่ามาตรฐาน
                </button>
                <button
                  type="button"
                  onClick={handleResetOverrides}
                  className="min-h-11 rounded-2xl border border-[var(--rx-line)] bg-white px-4 text-sm font-medium text-[var(--rx-ink-soft)]"
                >
                  รีเซ็ตท่าที่ตั้งไว้
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {screen === "play" && (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div>
            <p className="font-game text-xl font-semibold text-[var(--rx-ink)]">
              {isComplete ? "เสร็จแล้ว!" : "กำลังฝึก"}
            </p>
            <p className="mt-1 font-game text-lg text-[var(--rx-focus)]">{exercise.name}</p>
          </div>

          <ol className="space-y-2">
            {exercise.phases.map((phase, index) => {
              const done = isComplete || index < phaseIndex;
              const current = !isComplete && index === phaseIndex;
              return (
                <li
                  key={phase.id}
                  className={`flex items-center gap-3 rounded-2xl border px-3 py-3 ${
                    current
                      ? "border-[var(--rx-gold)] bg-[var(--rx-warn-soft)] rx-tension-flash"
                      : done
                        ? "border-[var(--rx-ok)] bg-[var(--rx-ok-soft)]"
                        : "border-[var(--rx-line)] bg-white"
                  }`}
                >
                  <span
                    className={`font-game flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg font-bold ${
                      current
                        ? "bg-[var(--rx-gold)] text-white"
                        : done
                          ? "bg-[var(--rx-ok)] text-white"
                          : "bg-[var(--rx-sand-deep)] text-[var(--rx-ink)]"
                    }`}
                  >
                    {done && !current ? "✓" : index + 1}
                  </span>
                  <span className="font-game text-lg font-semibold text-[var(--rx-ink)]">
                    {phase.label}
                    {current && feedback.status === "holding" ? " · ค้างไว้!" : ""}
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="rounded-2xl border border-[var(--rx-line)] bg-white px-4 py-3">
            <p className="text-sm text-[var(--rx-ink-soft)]">รอบที่</p>
            <p className="font-game text-3xl font-bold tabular-nums text-[var(--rx-ink)]">
              {Math.min(feedback.rep || 1, feedback.totalReps)}
              <span className="text-xl font-medium text-[var(--rx-ink-soft)]">
                {" "}
                / {feedback.totalReps}
              </span>
            </p>
          </div>

          <div className="mt-auto flex flex-col gap-2">
            {isComplete ? (
              <>
                <button
                  type="button"
                  onClick={handleBeginCountdown}
                  className="min-h-14 rounded-2xl bg-[var(--rx-focus)] px-4 text-lg font-semibold text-white"
                >
                  เล่นอีกครั้ง
                </button>
                <button
                  type="button"
                  onClick={handleChooseAnother}
                  className="min-h-12 rounded-2xl border border-[var(--rx-line)] bg-white px-4 text-base font-medium"
                >
                  เลือกท่าอื่น
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleStop}
                  className="min-h-14 rounded-2xl border-2 border-[var(--rx-danger)] bg-[var(--rx-danger-soft)] px-4 text-lg font-semibold text-[var(--rx-danger)]"
                >
                  หยุด
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="min-h-12 rounded-2xl border border-[var(--rx-line)] bg-white px-4 text-base font-medium"
                >
                  เริ่มรอบใหม่
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
