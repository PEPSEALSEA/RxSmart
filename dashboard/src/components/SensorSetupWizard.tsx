"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postSensorMappingAction } from "@/lib/local-bridge";
import type { SensorChannelReading } from "@/lib/sensor-mapping";
import { POSE_KEYS, POSE_LABELS, PoseKey, DEFAULT_CHANNEL_TO_POSE } from "@/lib/pose";
import {
  CALIBRATION_STEP_LABELS,
  CALIBRATION_STEP_SAVE_HINTS,
  ChannelMap,
  channelMapToRecord,
  parseChannelMap,
  POSE_PROFILE_LABELS,
  saveStoredChannelMap,
  SensorMappingState,
} from "@/lib/sensor-mapping";

type WizardPhase = "intro" | "guided" | "review" | "poses" | "done";

type SensorSetupWizardProps = {
  open: boolean;
  onClose: () => void;
  bridgeUrl: string;
  mapping: SensorMappingState | null;
  sensors?: SensorChannelReading[] | null;
  channelDegrees?: number[] | null;
  onMappingChange: (mapping: SensorMappingState) => void;
};

const GUIDED_ORDER = [
  "neutral",
  "move_forearms",
  "move_shoulders",
  "move_shins",
  "move_thighs",
  "arms_down",
  "arms_up_down",
] as const;

type GuidedStep = (typeof GUIDED_ORDER)[number];

type LockedInfo = { step: string; label: string };

/** Steps that claim top-2 free channels when advancing. */
const LOCK_ON_ADVANCE = new Set<string>([
  "move_forearms",
  "move_shoulders",
  "move_shins",
  "move_thighs",
]);

const LOCK_LABELS: Record<string, string> = {
  move_forearms: "ปลายแขน / ศอก",
  move_shoulders: "ต้นแขน / ไหล่",
  move_shins: "ปลายขา / เข่า",
  move_thighs: "ต้นขา",
};

/** Wizard lock step → body-segment role (L/R assigned from baseline). */
const STEP_TO_PAIR: Record<
  string,
  { left: PoseKey; right: PoseKey }
> = {
  move_forearms: { left: "l_arm_lower", right: "r_arm_lower" },
  move_shoulders: { left: "l_arm_upper", right: "r_arm_upper" },
  move_shins: { left: "l_leg_lower", right: "r_leg_lower" },
  move_thighs: { left: "l_leg_upper", right: "r_leg_upper" },
};

function buildChannelMapFromLocks(
  locked: Record<number, LockedInfo>,
  baseline: number[],
): ChannelMap | null {
  const byStep: Record<string, number[]> = {};
  for (const [chStr, info] of Object.entries(locked)) {
    const ch = Number(chStr);
    if (!STEP_TO_PAIR[info.step]) continue;
    (byStep[info.step] ??= []).push(ch);
  }

  const map: ChannelMap = { ...DEFAULT_CHANNEL_TO_POSE };
  const usedKeys = new Set<PoseKey>();

  for (const [step, pair] of Object.entries(STEP_TO_PAIR)) {
    const chs = byStep[step];
    if (!chs || chs.length !== 2) return null;
    // Lower neutral reading → left (matches Python _assign_left_right_pairs)
    const sorted = [...chs].sort(
      (a, b) => (baseline[a] ?? 0) - (baseline[b] ?? 0),
    );
    map[sorted[0]] = pair.left;
    map[sorted[1]] = pair.right;
    usedKeys.add(pair.left);
    usedKeys.add(pair.right);
  }

  if (usedKeys.size !== 8) return null;
  return map;
}

const ACTIVE_DELTA_DEG = 6;
const BAR_FULL_SCALE_DEG = 12;
const TOP_N = 2;

function degreesFromSources(
  sensors: SensorChannelReading[] | null | undefined,
  channelDegrees: number[] | null | undefined,
): number[] {
  const out = Array.from({ length: 8 }, () => 0);
  if (channelDegrees && channelDegrees.length >= 8) {
    for (let i = 0; i < 8; i++) out[i] = channelDegrees[i] ?? 0;
    return out;
  }
  if (sensors?.length) {
    for (const s of sensors) {
      const ch = typeof s.channel === "number" ? s.channel : -1;
      if (ch < 0 || ch > 7) continue;
      if (typeof s.degrees === "number") out[ch] = s.degrees;
    }
  }
  return out;
}

function pickTopFree(
  peakDeltas: number[],
  locked: Record<number, LockedInfo>,
  topN = TOP_N,
): number[] {
  return peakDeltas
    .map((d, i) => ({ i, d }))
    .filter((r) => !locked[r.i] && r.d >= ACTIVE_DELTA_DEG)
    .sort((a, b) => b.d - a.d)
    .slice(0, topN)
    .map((r) => r.i);
}

function ChannelActivityBars({
  degrees,
  baseline,
  map,
  locked,
  peakDeltas,
  topCandidates,
}: {
  degrees: number[];
  baseline: number[] | null;
  map: ChannelMap;
  locked: Record<number, LockedInfo>;
  peakDeltas: number[];
  topCandidates: number[];
}) {
  const topSet = new Set(topCandidates);

  return (
    <div className="space-y-2">
      <p className="cohere-mono-label text-[10px]">
        Live CH0–CH7 · top {TOP_N} จากช่องที่ยังไม่ล็อก (Δ≥{ACTIVE_DELTA_DEG}°) · ล็อกแล้ว =
        ใช้ไปแล้ว
      </p>
      {degrees.map((deg, ch) => {
        const lock = locked[ch];
        const delta = peakDeltas[ch] ?? 0;
        const isTop = !lock && topSet.has(ch);
        const active = !lock && delta >= ACTIVE_DELTA_DEG;
        const width = lock ? 0 : Math.min(100, (delta / BAR_FULL_SCALE_DEG) * 100);
        const label = POSE_LABELS[map[ch]] ?? map[ch] ?? "—";

        return (
          <div
            key={ch}
            className={`rounded-cohere-sm border px-3 py-2.5 ${
              lock
                ? "border-neutral-300 bg-neutral-200/90 opacity-90"
                : isTop
                  ? "border-cohere-primary bg-cohere-pale-green"
                  : active
                    ? "border-cohere-hairline bg-cohere-primary/5"
                    : "border-cohere-hairline bg-white"
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className={`font-mono-label ${lock ? "text-neutral-500" : "text-cohere-ink"}`}>
                CH{ch}
                {lock ? " · LOCKED" : isTop ? " · top mover" : active ? " · กำลังขยับ" : ""}
              </span>
              <span className={lock ? "text-neutral-500" : "text-cohere-body-muted"}>
                {lock
                  ? lock.label
                  : `${deg.toFixed(1)}° · Δ${delta.toFixed(1)}°`}
              </span>
            </div>
            <p className={`mt-0.5 truncate text-[11px] ${lock ? "text-neutral-500" : "text-cohere-muted"}`}>
              {lock ? `ล็อกจากขั้น: ${lock.label}` : label}
            </p>
            {!lock && (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                <div
                  className={`h-full rounded-full transition-[width] duration-150 ${
                    isTop ? "bg-cohere-primary" : active ? "bg-neutral-500" : "bg-neutral-300"
                  }`}
                  style={{ width: `${width}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function SensorSetupWizard({
  open,
  onClose,
  bridgeUrl,
  mapping,
  sensors,
  channelDegrees,
  onMappingChange,
}: SensorSetupWizardProps) {
  const [phase, setPhase] = useState<WizardPhase>("intro");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [editMap, setEditMap] = useState<ChannelMap>(() => parseChannelMap(mapping?.channel_map));
  /** Baseline from step 1 (neutral) — all later steps compare against this. */
  const [neutralBaseline, setNeutralBaseline] = useState<number[] | null>(null);
  const [locked, setLocked] = useState<Record<number, LockedInfo>>({});
  const [peakDeltas, setPeakDeltas] = useState(() => Array.from({ length: 8 }, () => 0));
  const peakRef = useRef(peakDeltas);
  peakRef.current = peakDeltas;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const degrees = useMemo(
    () => degreesFromSources(sensors, channelDegrees ?? mapping?.channel_degrees),
    [sensors, channelDegrees, mapping?.channel_degrees],
  );

  const step =
    mapping?.calibration_step && mapping.calibration_step !== "idle"
      ? mapping.calibration_step
      : null;
  const stepIndex = step ? GUIDED_ORDER.indexOf(step as GuidedStep) : -1;

  const topCandidates = useMemo(
    () => pickTopFree(peakDeltas, locked),
    [peakDeltas, locked],
  );

  const resetWizardLocal = useCallback(() => {
    setNeutralBaseline(null);
    setLocked({});
    setPeakDeltas(Array.from({ length: 8 }, () => 0));
  }, []);

  useEffect(() => {
    if (!open) return;
    setPhase("intro");
    setMessage("");
    setBusy("");
    resetWizardLocal();
    setEditMap(parseChannelMap(mapping?.channel_map));
  }, [open, resetWizardLocal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mapping?.channel_map) {
      setEditMap(parseChannelMap(mapping.channel_map));
    }
  }, [mapping?.channel_map]);

  // Peak-hold vs neutral baseline; locked channels stay at 0 for ranking
  useEffect(() => {
    if (phase !== "guided" && phase !== "review") return;
    const base = neutralBaseline;
    if (!base) return;

    const instant = degrees.map((d, i) => Math.abs(d - (base[i] ?? d)));
    setPeakDeltas((prev) =>
      prev.map((peak, i) => {
        if (lockedRef.current[i]) return 0;
        const now = instant[i] ?? 0;
        if (now >= peak) return now;
        return Math.max(0, peak - 0.8);
      }),
    );
  }, [degrees, neutralBaseline, phase, locked]);

  // Reset peaks when entering a new motion step (keep locked; keep neutral baseline)
  useEffect(() => {
    if (phase !== "guided" || !step) return;
    if (step === "neutral") return;
    setPeakDeltas((prev) =>
      prev.map((_, i) => (lockedRef.current[i] ? 0 : 0)),
    );
  }, [phase, step]);

  const applyMappingResult = useCallback(
    (data: Record<string, unknown>) => {
      if (data.channel_map) {
        const parsed = parseChannelMap(data.channel_map as Record<string, string>);
        setEditMap(parsed);
        saveStoredChannelMap(parsed);
      }
      onMappingChange(data as unknown as SensorMappingState);
    },
    [onMappingChange],
  );

  const startGuided = async () => {
    setBusy("start");
    setMessage("");
    resetWizardLocal();
    try {
      const data = await postSensorMappingAction(bridgeUrl, "calibrate_start");
      applyMappingResult(data);
      setPhase("guided");
      setMessage(`ขั้น 1/${GUIDED_ORDER.length}: ${CALIBRATION_STEP_LABELS.neutral}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "เริ่ม setup ไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const nextGuided = async () => {
    setBusy("next");
    setMessage("");
    try {
      const current = step;

      // Step 1 → capture neutral baseline for all later steps
      if (current === "neutral") {
        setNeutralBaseline([...degrees]);
        setPeakDeltas(Array.from({ length: 8 }, () => 0));
      }

      // Steps 2–5 → lock top-2 free channels before advancing
      if (current && LOCK_ON_ADVANCE.has(current)) {
        const free = Array.from({ length: 8 }, (_, i) => i).filter((i) => !lockedRef.current[i]);
        let picks = pickTopFree(peakRef.current, lockedRef.current);

        // Last mapping step: assign whatever free channels remain (หลังตัดขั้น 4)
        if (current === "move_thighs" && free.length <= TOP_N) {
          picks = free;
        }

        if (picks.length < Math.min(TOP_N, free.length) || picks.length === 0) {
          setMessage(
            `ยังไม่พอ — ต้องมีอย่างน้อย ${Math.min(TOP_N, free.length)} ช่องที่ Δ≥${ACTIVE_DELTA_DEG}° จาก ${free.length} ช่องที่ยังไม่ล็อก`,
          );
          setBusy("");
          return;
        }

        const nextLocked: Record<number, LockedInfo> = { ...lockedRef.current };
        for (const ch of picks) {
          nextLocked[ch] = {
            step: current,
            label: LOCK_LABELS[current] ?? current,
          };
        }
        setLocked(nextLocked);
        lockedRef.current = nextLocked;
        setMessage(
          `ล็อก CH${picks.join(", CH")} เป็น ${LOCK_LABELS[current] ?? current}`,
        );
      }

      const data = await postSensorMappingAction(bridgeUrl, "calibrate_next");
      applyMappingResult(data);

      // calibrate_next may overwrite map via auto_detect — re-apply wizard locks
      if (current === "move_thighs") {
        const baseline = neutralBaseline ?? degrees;
        const built = buildChannelMapFromLocks(lockedRef.current, baseline);
        if (built) {
          const setData = await postSensorMappingAction(bridgeUrl, "set", {
            channelMap: channelMapToRecord(built),
          });
          applyMappingResult(setData);
        }
      }

      if (data.step === "complete") {
        setPhase("review");
        setMessage("บันทึก channel_map + pose_defaults ลง sensor_map.json แล้ว — ตรวจแมปด้านล่าง");
      } else {
        const label = CALIBRATION_STEP_LABELS[data.step as string] ?? String(data.step);
        const idx = GUIDED_ORDER.indexOf(data.step as GuidedStep);
        setMessage((prev) => {
          const lockNote =
            current && LOCK_ON_ADVANCE.has(current) && prev.startsWith("ล็อก")
              ? `${prev} · `
              : "";
          return `${lockNote}ขั้น ${idx + 1}/${GUIDED_ORDER.length}: ${label}`;
        });
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "ขั้นถัดไปไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const saveManualMap = async () => {
    setBusy("set");
    setMessage("");
    try {
      const channelMap: Record<string, string> = {};
      for (let i = 0; i < 8; i++) channelMap[String(i)] = editMap[i];
      const used = new Set(Object.values(channelMap));
      if (used.size !== 8) {
        setMessage("แต่ละข้อต่อต้องได้คนละ CH — ห้ามซ้ำ");
        return;
      }
      const data = await postSensorMappingAction(bridgeUrl, "set", { channelMap });
      applyMappingResult(data);
      setMessage("บันทึก channel_map ที่แก้ด้วยมือลง sensor_map.json แล้ว");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "บันทึกแมปไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const resetDefault = async () => {
    setBusy("reset");
    setMessage("");
    try {
      const data = await postSensorMappingAction(bridgeUrl, "reset");
      applyMappingResult(data);
      setMessage("รีเซ็ตเป็น firmware default แล้ว (เขียน sensor_map.json)");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "รีเซ็ตไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const runPose = async (action: "capture_pose" | "activate_pose", pose: "standing" | "sitting") => {
    setBusy(`${action}:${pose}`);
    setMessage("");
    try {
      const data = await postSensorMappingAction(bridgeUrl, action, { pose });
      applyMappingResult(data);
      const label = POSE_PROFILE_LABELS[pose] ?? pose;
      setMessage(
        action === "capture_pose"
          ? `บันทึก ${label} ลง pose_profiles ใน sensor_map.json แล้ว`
          : `สลับใช้ ${label} แล้ว`,
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "ตั้งค่าท่าไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  if (!open) return null;

  const mapForBars = phase === "review" ? editMap : parseChannelMap(mapping?.channel_map);
  const lockedCount = Object.keys(locked).length;
  const freeCount = 8 - lockedCount;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-white"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sensor-setup-title"
    >
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-cohere-hairline px-5 py-4 sm:px-8">
        <div>
          <p className="cohere-mono-label text-[11px]">IMU · Local Python · Setup Wizard</p>
          <h2 id="sensor-setup-title" className="mt-1 text-xl text-cohere-ink">
            Setup Wizard
          </h2>
          <p className="mt-1 text-xs text-cohere-muted">
            บันทึก <span className="font-mono-label">rxsmart-local/sensor_map.json</span> · ขั้น 2+
            อิง baseline จากขั้น 1 · CH ที่ล็อกแล้วไม่เลือกซ้ำ
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="cohere-btn-pill-outline px-3 py-1.5 text-xs"
        >
          ปิด
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8">
        {phase === "intro" && (
          <div className="mx-auto max-w-2xl space-y-4 text-sm text-cohere-body-muted">
            <p>
              จับว่า board CH ไหนคือแขน/ขา โดยดูการขยับ — ขั้น 1 ยืนนิ่งเป็น baseline แล้วขั้นต่อๆ
              ไปเทียบจากค่านั้น
            </p>
            <p className="rounded-cohere-sm border border-cohere-hairline bg-white px-3 py-2 text-xs">
              Firmware กรองมุมด้วย accel+gyro แล้ว — ขยับช้าๆ ให้ชัดก็พอ · ยังวัดได้แค่ elevation/bend
              (ไม่มี plane / แยก abduction vs flexion)
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>ก่อน wizard: ยืนนิ่งตอน board calibrate (ประมาณ 3 วินาที) ให้ gyro bias นิ่ง</li>
              <li>ขั้น 2 (งอศอก): เลือก top 2 CH → ล็อก</li>
              <li>ขั้น 3 (ยกไหล่): เลือก top 2 จาก CH ที่ยังไม่ล็อก</li>
              <li>ขั้น 4 (งอเข่า): เลือก top 2 จากที่เหลือ</li>
              <li>ขั้น 5 (ต้นขา): เลือกจากที่เหลือหลังขั้น 4</li>
            </ul>
            <p className="rounded-cohere-sm bg-cohere-primary/5 px-3 py-2 text-xs">
              บล็อกสีเทา = LOCKED ใช้ไปแล้ว ระบบจะไม่เลือกซ้ำ · บันทึกลง sensor_map.json บนเครื่องนี้
            </p>
          </div>
        )}

        {phase === "guided" && (
          <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2">
            <div className="space-y-3">
              <p className="cohere-mono-label text-[11px]">
                ขั้น {Math.max(1, stepIndex + 1)}/{GUIDED_ORDER.length}
                {lockedCount > 0 ? ` · ล็อกแล้ว ${lockedCount} · เหลือ ${freeCount}` : ""}
              </p>
              <p className="text-lg text-cohere-ink">
                {step ? CALIBRATION_STEP_LABELS[step] ?? step : "กำลังเริ่ม…"}
              </p>
              <p className="text-xs text-cohere-muted">
                {step === "neutral"
                  ? "ยืนนิ่ง — ค่านี้จะเป็น baseline ให้ขั้น 2 เป็นต้นไป"
                  : neutralBaseline
                    ? "กำลังเทียบกับ baseline ขั้น 1 (ยืนนิ่ง) · CH ที่ล็อกแล้วถูกตัดออก"
                    : "รอ baseline จากขั้น 1"}
              </p>
              <p className="text-xs text-cohere-muted">
                {step
                  ? CALIBRATION_STEP_SAVE_HINTS[step] ?? "กำลังเก็บตัวอย่างในหน่วยความจำ"
                  : ""}
              </p>
              <p className="rounded-cohere-sm border border-dashed border-cohere-hairline px-3 py-2 text-xs text-cohere-body-muted">
                ขยับช้าๆ ให้ชัด — มุมกรองแล้ว · ให้ Δ ≥ {ACTIVE_DELTA_DEG}° บนช่องที่ยังไม่ล็อก
                แล้วกดขั้นถัดไป — ระบบจะล็อก top {TOP_N} ของขั้นนี้
              </p>
              {lockedCount > 0 && (
                <div className="rounded-cohere-sm bg-neutral-100 px-3 py-2 text-xs text-neutral-600">
                  ล็อกแล้ว:{" "}
                  {Object.entries(locked)
                    .map(([ch, info]) => `CH${ch} (${info.label})`)
                    .join(" · ")}
                </div>
              )}
            </div>
            <ChannelActivityBars
              degrees={degrees}
              baseline={neutralBaseline}
              map={mapForBars}
              locked={locked}
              peakDeltas={peakDeltas}
              topCandidates={topCandidates}
            />
          </div>
        )}

        {phase === "review" && (
          <div className="mx-auto max-w-5xl space-y-4">
            <div>
              <p className="text-sm text-cohere-ink">ตรวจ / แก้แมป CH → ข้อต่อ</p>
              <p className="mt-1 text-xs text-cohere-muted">
                ถ้ายกแขนแล้วขาตาม ให้เปลี่ยน dropdown แล้วกดบันทึกแมป
              </p>
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-2">
                {Array.from({ length: 8 }, (_, ch) => (
                  <label key={ch} className="flex items-center gap-2 text-xs">
                    <span className="w-10 font-mono-label text-cohere-ink">CH{ch}</span>
                    <select
                      className="cohere-input flex-1 py-1.5 text-xs"
                      value={editMap[ch]}
                      onChange={(e) =>
                        setEditMap((prev) => ({
                          ...prev,
                          [ch]: e.target.value as PoseKey,
                        }))
                      }
                    >
                      {POSE_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {POSE_LABELS[key]}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void saveManualMap()}
                    className="cohere-btn-primary px-4 py-2 text-xs disabled:opacity-50"
                  >
                    {busy === "set" ? "…" : "บันทึกแมป"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void resetDefault()}
                    className="cohere-btn-pill-outline text-xs disabled:opacity-50"
                  >
                    Reset default
                  </button>
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs text-cohere-muted">
                  Verify — เทียบกับ baseline ขั้น 1 (หรือตั้งใหม่)
                </p>
                <ChannelActivityBars
                  degrees={degrees}
                  baseline={neutralBaseline}
                  map={editMap}
                  locked={{}}
                  peakDeltas={peakDeltas}
                  topCandidates={pickTopFree(peakDeltas, {})}
                />
                <button
                  type="button"
                  className="cohere-btn-pill-outline mt-2 text-xs"
                  onClick={() => {
                    setNeutralBaseline([...degrees]);
                    setPeakDeltas(Array.from({ length: 8 }, () => 0));
                  }}
                >
                  ตั้ง baseline ใหม่ (ยืนนิ่งแล้วกด)
                </button>
              </div>
            </div>
          </div>
        )}

        {phase === "poses" && (
          <div className="mx-auto max-w-2xl space-y-4 text-sm text-cohere-body-muted">
            <p>
              บันทึกท่ายืน/นั่ง →{" "}
              <span className="font-mono-label text-cohere-ink">pose_profiles</span> ใน{" "}
              <span className="font-mono-label">sensor_map.json</span>
            </p>
            <p className="text-xs">
              ท่าที่ใช้อยู่:{" "}
              {mapping?.active_pose
                ? POSE_PROFILE_LABELS[mapping.active_pose] ?? mapping.active_pose
                : "ยังไม่ตั้ง"}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void runPose("capture_pose", "standing")}
                className="cohere-btn-primary px-4 py-2 text-xs disabled:opacity-50"
              >
                {busy === "capture_pose:standing" ? "…" : "บันทึกท่ายืนปกติ"}
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void runPose("capture_pose", "sitting")}
                className="cohere-btn-primary px-4 py-2 text-xs disabled:opacity-50"
              >
                {busy === "capture_pose:sitting" ? "…" : "บันทึกท่านั่งปกติ"}
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || !mapping?.pose_profiles?.standing}
                onClick={() => void runPose("activate_pose", "standing")}
                className="cohere-btn-pill-outline text-xs disabled:opacity-50"
              >
                ใช้ท่ายืน
              </button>
              <button
                type="button"
                disabled={Boolean(busy) || !mapping?.pose_profiles?.sitting}
                onClick={() => void runPose("activate_pose", "sitting")}
                className="cohere-btn-pill-outline text-xs disabled:opacity-50"
              >
                ใช้ท่านั่ง
              </button>
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="mx-auto max-w-2xl space-y-3 text-sm text-cohere-body-muted">
            <p className="text-cohere-ink">Setup เสร็จ</p>
            <p>
              confidence {mapping ? `${Math.round(mapping.confidence * 100)}%` : "—"} ·{" "}
              <span className="font-mono-label">sensor_map.json</span> อัปเดตแล้ว
            </p>
          </div>
        )}

        {message && (
          <p className="mx-auto mt-5 max-w-5xl rounded-cohere-sm bg-cohere-pale-green px-4 py-2.5 text-xs text-cohere-ink">
            {message}
          </p>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-cohere-hairline px-5 py-4 sm:px-8">
        <div className="text-[11px] text-cohere-muted">
          {phase === "intro" && "ยังไม่เซฟ"}
          {phase === "guided" &&
            (step === "neutral"
              ? "กดถัดไปเพื่อล็อก baseline ขั้น 1"
              : step && LOCK_ON_ADVANCE.has(step)
                ? `กดถัดไปจะล็อก top ${TOP_N} ช่องที่ยังไม่ล็อก`
                : step
                  ? CALIBRATION_STEP_SAVE_HINTS[step]
                  : "")}
          {phase === "review" && "แก้แมปแล้วกดบันทึก หรือไปขั้นท่ายืน/นั่ง"}
          {phase === "poses" && "บันทึกท่าจะเขียน pose_profiles"}
          {phase === "done" && "ปิดได้เมื่อพร้อม"}
        </div>
        <div className="flex flex-wrap gap-2">
          {phase === "intro" && (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void startGuided()}
              className="cohere-btn-primary px-5 py-2 text-xs disabled:opacity-50"
            >
              {busy === "start" ? "…" : "เริ่ม Setup"}
            </button>
          )}
          {phase === "guided" && (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void nextGuided()}
              className="cohere-btn-primary px-5 py-2 text-xs disabled:opacity-50"
            >
              {busy === "next" ? "…" : "ขั้นถัดไป"}
            </button>
          )}
          {phase === "review" && (
            <>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void startGuided()}
                className="cohere-btn-pill-outline text-xs disabled:opacity-50"
              >
                เริ่ม guided ใหม่
              </button>
              <button
                type="button"
                onClick={() => setPhase("poses")}
                className="cohere-btn-primary px-5 py-2 text-xs"
              >
                ถัดไป · ท่ายืน/นั่ง
              </button>
            </>
          )}
          {phase === "poses" && (
            <>
              <button
                type="button"
                onClick={() => setPhase("review")}
                className="cohere-btn-pill-outline text-xs"
              >
                กลับแก้แมป
              </button>
              <button
                type="button"
                onClick={() => setPhase("done")}
                className="cohere-btn-primary px-5 py-2 text-xs"
              >
                เสร็จสิ้น
              </button>
            </>
          )}
          {phase === "done" && (
            <button type="button" onClick={onClose} className="cohere-btn-primary px-5 py-2 text-xs">
              ปิด
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
