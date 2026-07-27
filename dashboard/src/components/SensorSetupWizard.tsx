"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postSensorMappingAction } from "@/lib/local-bridge";
import type { SensorChannelReading } from "@/lib/sensor-mapping";
import { POSE_KEYS, POSE_LABELS, PoseKey, DEFAULT_CHANNEL_TO_POSE, CENTER_CHANNEL, CENTER_KEY, LIMB_CHANNEL_COUNT, SENSOR_COUNT, MAPPING_LABELS, isPoseKey } from "@/lib/pose";
import {
  CALIBRATION_STEP_LABELS,
  CALIBRATION_STEP_SAVE_HINTS,
  ChannelMap,
  channelMapToRecord,
  ensureCenterInMap,
  parseChannelMap,
  POSE_PROFILE_LABELS,
  saveStoredChannelMap,
  SensorMappingState,
  swapArmSides,
  swapLegSides,
  UNILATERAL_STEP_TO_POSE,
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
  "l_elbow",
  "l_shoulder",
  "r_elbow",
  "r_shoulder",
  "l_knee",
  "l_hip",
  "r_knee",
  "r_hip",
  "standing_hold",
] as const;

type GuidedStep = (typeof GUIDED_ORDER)[number];

type LockedInfo = { step: string; label: string; poseKey?: PoseKey };

const LOCK_ON_ADVANCE = new Set<string>(Object.keys(UNILATERAL_STEP_TO_POSE));

const LOCK_LABELS: Record<string, string> = {
  l_elbow: "ปลายแขนซ้าย / ศอก",
  l_shoulder: "ต้นแขนซ้าย / ไหล่",
  r_elbow: "ปลายแขนขวา / ศอก",
  r_shoulder: "ต้นแขนขวา / ไหล่",
  l_knee: "ปลายขาซ้าย / เข่า",
  l_hip: "ต้นขาซ้าย",
  r_knee: "ปลายขาขวา / เข่า",
  r_hip: "ต้นขาขวา",
};

function buildChannelMapFromLocks(locked: Record<number, LockedInfo>): ChannelMap | null {
  const map: ChannelMap = { ...DEFAULT_CHANNEL_TO_POSE };
  const usedKeys = new Set<PoseKey>();

  for (const [chStr, info] of Object.entries(locked)) {
    const ch = Number(chStr);
    if (ch === CENTER_CHANNEL) continue;
    const poseKey = info.poseKey ?? UNILATERAL_STEP_TO_POSE[info.step];
    if (!poseKey || !isPoseKey(poseKey)) continue;
    map[ch] = poseKey;
    usedKeys.add(poseKey);
  }

  if (usedKeys.size !== LIMB_CHANNEL_COUNT) return null;
  return ensureCenterInMap(map);
}

const ACTIVE_DELTA_DEG = 6;
const BAR_FULL_SCALE_DEG = 12;
const TOP_N = 1;

function degreesFromSources(
  sensors: SensorChannelReading[] | null | undefined,
  channelDegrees: number[] | null | undefined,
): number[] {
  const out = Array.from({ length: SENSOR_COUNT }, () => 0);
  if (channelDegrees && channelDegrees.length >= LIMB_CHANNEL_COUNT) {
    for (let i = 0; i < SENSOR_COUNT; i++) out[i] = channelDegrees[i] ?? 0;
    return out;
  }
  if (sensors?.length) {
    for (const s of sensors) {
      const ch = typeof s.channel === "number" ? s.channel : -1;
      if (ch < 0 || ch >= SENSOR_COUNT) continue;
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
    .filter((r) => r.i < LIMB_CHANNEL_COUNT && !locked[r.i] && r.d >= ACTIVE_DELTA_DEG)
    .sort((a, b) => b.d - a.d)
    .slice(0, topN)
    .map((r) => r.i);
}

function centerLocked(): Record<number, LockedInfo> {
  return {
    [CENTER_CHANNEL]: { step: "center", label: "ลำตัว / center (MPU #9)" },
  };
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
        Live CH0–CH8 · top {TOP_N} จากช่องแขนขาที่ยังไม่ล็อก (Δ≥{ACTIVE_DELTA_DEG}°) · ขยับทีละข้าง ·
        CH8 = center (อ้างอิงลำตัว) · ล็อกแล้ว = ใช้ไปแล้ว
      </p>
      {degrees.map((deg, ch) => {
        const lock = locked[ch];
        const isCenter = ch === CENTER_CHANNEL;
        const delta = peakDeltas[ch] ?? 0;
        const isTop = !lock && topSet.has(ch);
        const active = (!lock || isCenter) && delta >= ACTIVE_DELTA_DEG;
        const width = lock && !isCenter ? 0 : Math.min(100, (delta / BAR_FULL_SCALE_DEG) * 100);
        const mapped = map[ch];
        const label =
          mapped === CENTER_KEY
            ? MAPPING_LABELS.center
            : mapped && isPoseKey(mapped)
              ? POSE_LABELS[mapped]
              : mapped ?? "—";

        return (
          <div
            key={ch}
            className={`rounded-cohere-sm border px-3 py-2.5 ${
              isCenter
                ? active
                  ? "border-cohere-primary/40 bg-cohere-pale-green/40"
                  : "border-neutral-300 bg-neutral-100/80"
                : lock
                  ? "border-neutral-300 bg-neutral-200/90 opacity-90"
                  : isTop
                    ? "border-cohere-primary bg-cohere-pale-green"
                    : active
                      ? "border-cohere-hairline bg-cohere-primary/5"
                      : "border-cohere-hairline bg-white"
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className={`font-mono-label ${lock && !isCenter ? "text-neutral-500" : "text-cohere-ink"}`}>
                CH{ch}
                {isCenter
                  ? active
                    ? " · center · ขยับ"
                    : " · center"
                  : lock
                    ? " · LOCKED"
                    : isTop
                      ? " · top mover"
                      : active
                        ? " · กำลังขยับ"
                        : ""}
              </span>
              <span className={lock && !isCenter ? "text-neutral-500" : "text-cohere-body-muted"}>
                {lock && !isCenter
                  ? lock.label
                  : `${deg.toFixed(1)}° · Δ${delta.toFixed(1)}°`}
              </span>
            </div>
            <p className={`mt-0.5 truncate text-[11px] ${lock && !isCenter ? "text-neutral-500" : "text-cohere-muted"}`}>
              {isCenter
                ? "อ้างอิงลำตัว · ใช้คำนวณมุมแขนขา + เอนตัวในเกม"
                : lock
                  ? `ล็อกจากขั้น: ${lock.label}`
                  : label}
            </p>
            {(!lock || isCenter) && (
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                <div
                  className={`h-full rounded-full transition-[width] duration-150 ${
                    isCenter
                      ? active
                        ? "bg-cohere-primary"
                        : "bg-neutral-400"
                      : isTop
                        ? "bg-cohere-primary"
                        : active
                          ? "bg-neutral-500"
                          : "bg-neutral-300"
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
  const [peakDeltas, setPeakDeltas] = useState(() => Array.from({ length: SENSOR_COUNT }, () => 0));
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
    setLocked(centerLocked());
    setPeakDeltas(Array.from({ length: SENSOR_COUNT }, () => 0));
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

  // Peak-hold vs neutral baseline; locked limb channels stay at 0 for ranking (guided only)
  useEffect(() => {
    if (phase !== "guided" && phase !== "review") return;
    const base = neutralBaseline;
    if (!base) return;

    const instant = degrees.map((d, i) => Math.abs(d - (base[i] ?? d)));
    setPeakDeltas((prev) =>
      prev.map((peak, i) => {
        if (phase === "guided" && i !== CENTER_CHANNEL && lockedRef.current[i]) return 0;
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
    setPeakDeltas(Array.from({ length: SENSOR_COUNT }, () => 0));
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

  const sensorAliveCount = useMemo(() => {
    if (sensors && sensors.length > 0) {
      const chs = new Set<number>();
      for (let i = 0; i < sensors.length; i++) {
        const s = sensors[i];
        const ch = typeof s.channel === "number" ? s.channel : i;
        if (ch >= 0 && ch < SENSOR_COUNT) chs.add(ch);
      }
      return chs.size;
    }
    if (channelDegrees && channelDegrees.length >= LIMB_CHANNEL_COUNT) {
      return Math.min(SENSOR_COUNT, channelDegrees.length);
    }
    if (mapping?.channel_degrees && mapping.channel_degrees.length >= LIMB_CHANNEL_COUNT) {
      return Math.min(SENSOR_COUNT, mapping.channel_degrees.length);
    }
    return 0;
  }, [sensors, channelDegrees, mapping?.channel_degrees]);

  const centerAlive = degrees.length > CENTER_CHANNEL;

  const retryCurrentStep = () => {
    setPeakDeltas(Array.from({ length: SENSOR_COUNT }, () => 0));
    setMessage("รีเซ็ต Δ ของขั้นนี้แล้ว — ขยับใหม่ให้ชัด แล้วกดขั้นถัดไป");
  };

  const startGuided = async () => {
    setBusy("start");
    setMessage("");
    if (sensorAliveCount < SENSOR_COUNT) {
      setMessage(
        `ยังไม่ครบ ${SENSOR_COUNT} เซ็นเซอร์ (เห็น ${sensorAliveCount}) — ปิด Serial Monitor · restart main.py · รอ board calibrate ~3 วิ`,
      );
      setBusy("");
      return;
    }
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

      if (current === "neutral") {
        if (!centerAlive) {
          setMessage("ยังไม่เห็น CH8 (center) — ตรวจ mux 0x71 / รอสัญญาณครบ 9 ช่อง");
          setBusy("");
          return;
        }
        setNeutralBaseline([...degrees]);
        setPeakDeltas(Array.from({ length: SENSOR_COUNT }, () => 0));
      }

      if (current && LOCK_ON_ADVANCE.has(current)) {
        const poseKey = UNILATERAL_STEP_TO_POSE[current];
        const free = Array.from({ length: LIMB_CHANNEL_COUNT }, (_, i) => i).filter(
          (i) => !lockedRef.current[i],
        );
        let picks = pickTopFree(peakRef.current, lockedRef.current);

        if (current === "r_hip" && free.length === 1 && picks.length === 0) {
          picks = free;
        }

        if (picks.length < 1) {
          setMessage(
            `ยังไม่พอ — ขยับเฉพาะข้างที่ระบุให้ Δ≥${ACTIVE_DELTA_DEG}° บนช่องที่ยังไม่ล็อก (เหลือ ${free.length} ช่อง) หรือกดทำซ้ำขั้นนี้`,
          );
          setBusy("");
          return;
        }

        const ch = picks[0];
        const nextLocked: Record<number, LockedInfo> = {
          ...centerLocked(),
          ...lockedRef.current,
          [ch]: {
            step: current,
            label: LOCK_LABELS[current] ?? current,
            poseKey,
          },
        };
        setLocked(nextLocked);
        lockedRef.current = nextLocked;
        setMessage(
          `ล็อก CH${ch} → ${poseKey ? (isPoseKey(poseKey) ? POSE_LABELS[poseKey] : poseKey) : current}`,
        );
      }

      const data = await postSensorMappingAction(bridgeUrl, "calibrate_next");
      applyMappingResult(data);

      if (current === "r_hip") {
        const built = buildChannelMapFromLocks(lockedRef.current);
        if (built) {
          const setData = await postSensorMappingAction(bridgeUrl, "set", {
            channelMap: channelMapToRecord(built),
          });
          applyMappingResult(setData);
          setEditMap(built);
          saveStoredChannelMap(built);
        } else {
          setMessage((prev) => `${prev} · แมปยังไม่ครบ 8 แขนขา — ตรวจในหน้า review`);
        }
      }

      if (data.step === "complete") {
        setPhase("review");
        setMessage("บันทึก channel_map + pose_defaults ลง sensor_map.json แล้ว — ตรวจแมป / สลับซ้ายขวาได้ด้านล่าง");
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

  const applySideSwap = async (kind: "arms" | "legs") => {
    setBusy(`swap:${kind}`);
    setMessage("");
    try {
      const next = kind === "arms" ? swapArmSides(editMap) : swapLegSides(editMap);
      setEditMap(next);
      const data = await postSensorMappingAction(bridgeUrl, "set", {
        channelMap: channelMapToRecord(next),
      });
      applyMappingResult(data);
      saveStoredChannelMap(next);
      setMessage(kind === "arms" ? "สลับแมปแขนซ้าย ↔ ขวาแล้ว" : "สลับแมปขาซ้าย ↔ ขวาแล้ว");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "สลับข้างไม่สำเร็จ");
    } finally {
      setBusy("");
    }
  };

  const saveManualMap = async () => {
    setBusy("set");
    setMessage("");
    try {
      const channelMap: Record<string, string> = channelMapToRecord(editMap);
      const limbValues = Object.entries(channelMap)
        .filter(([ch]) => Number(ch) < LIMB_CHANNEL_COUNT)
        .map(([, v]) => v);
      const used = new Set(limbValues);
      if (used.size !== LIMB_CHANNEL_COUNT || channelMap[String(CENTER_CHANNEL)] !== CENTER_KEY) {
        setMessage("แต่ละข้อต่อต้องได้คนละ CH (CH0–7) และ CH8 ต้องเป็น center");
        return;
      }
      const data = await postSensorMappingAction(bridgeUrl, "set", { channelMap });
      applyMappingResult(data);
      setMessage("บันทึก channel_map (9 CH รวม center) ลง sensor_map.json แล้ว");
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
  const lockedLimbCount = Object.keys(locked).filter((ch) => Number(ch) < LIMB_CHANNEL_COUNT).length;
  const freeCount = LIMB_CHANNEL_COUNT - lockedLimbCount;

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
            บันทึก <span className="font-mono-label">rxsmart-local/sensor_map.json</span> ·
            ขยับทีละข้างทีละข้อ · CH8 = center อ้างอิงมุม + เอนตัว
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
              จับว่า board CH ไหนคือแขน/ขา โดยขยับ<strong>ทีละข้าง ทีละข้อ</strong> — คำสั่งซ้าย/ขวาคือ
              ground truth ไม่เดาจากมุม
            </p>
            <p className="rounded-cohere-sm border border-cohere-hairline bg-white px-3 py-2 text-xs">
              Preflight: ปิด Arduino Serial Monitor · รัน main.py · ยืนนิ่งตอน board calibrate ~3 วิ ·
              ตอนนี้เห็นเซ็นเซอร์ {sensorAliveCount}/{SENSOR_COUNT}
              {centerAlive ? " · CH8 ok" : " · ยังไม่เห็น CH8"}
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>ขั้น 1: ยืนนิ่ง (baseline + ตรวจ CH8)</li>
              <li>ขั้น 2–5: ศอกซ้าย → ไหล่ซ้าย → ศอกขวา → ไหล่ขวา (ล็อก top 1 ต่อขั้น)</li>
              <li>ขั้น 6–9: เข่าซ้าย → ต้นขาซ้าย → เข่าขวา → ต้นขาขวา</li>
              <li>ขั้น 10: ยืนห้อยแขนนิ่ง → บันทึก pose_defaults</li>
              <li>หน้า review: ตรวจแมป / สลับแขนหรือขาทั้งข้างถ้าหุ่นกลับด้าน</li>
            </ul>
            <p className="rounded-cohere-sm bg-cohere-primary/5 px-3 py-2 text-xs">
              ขยับเฉพาะข้างที่ระบุ · ข้างอื่นนิ่ง · บล็อกสีเทา = LOCKED แล้วจะไม่เลือกซ้ำ
            </p>
          </div>
        )}

        {phase === "guided" && (
          <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-2">
            <div className="space-y-3">
              <p className="cohere-mono-label text-[11px]">
                ขั้น {Math.max(1, stepIndex + 1)}/{GUIDED_ORDER.length}
                {lockedLimbCount > 0 ? ` · ล็อกแล้ว ${lockedLimbCount} · เหลือ ${freeCount}` : ""}
              </p>
              <p className="text-lg text-cohere-ink">
                {step ? CALIBRATION_STEP_LABELS[step] ?? step : "กำลังเริ่ม…"}
              </p>
              <p className="text-xs text-cohere-muted">
                {step === "neutral"
                  ? "ยืนนิ่ง — ค่านี้จะเป็น baseline ให้ขั้นถัดไป · ตรวจ CH8"
                  : step === "standing_hold"
                    ? "ยืนห้อยแขนนิ่ง 2–3 วินาที แล้วกดถัดไปเพื่อบันทึก pose_defaults"
                    : neutralBaseline
                      ? "ขยับเฉพาะข้างที่ระบุ · ข้างอื่นนิ่ง · เทียบ baseline ขั้น 1"
                      : "รอ baseline จากขั้น 1"}
              </p>
              <p className="text-xs text-cohere-muted">
                {step
                  ? CALIBRATION_STEP_SAVE_HINTS[step] ?? "กำลังเก็บตัวอย่างในหน่วยความจำ"
                  : ""}
              </p>
              {step && LOCK_ON_ADVANCE.has(step) && (
                <p className="rounded-cohere-sm border border-dashed border-cohere-hairline px-3 py-2 text-xs text-cohere-body-muted">
                  ให้ Δ ≥ {ACTIVE_DELTA_DEG}° บนช่องที่ยังไม่ล็อก แล้วกดขั้นถัดไป — ระบบล็อก top{" "}
                  {TOP_N} ของขั้นนี้
                  {topCandidates.length > 0
                    ? ` · candidate: CH${topCandidates[0]}`
                    : " · ยังไม่เห็น candidate"}
                </p>
              )}
              {lockedLimbCount > 0 && (
                <div className="rounded-cohere-sm bg-neutral-100 px-3 py-2 text-xs text-neutral-600">
                  ล็อกแล้ว:{" "}
                  {Object.entries(locked)
                    .filter(([ch]) => Number(ch) !== CENTER_CHANNEL)
                    .map(([ch, info]) => `CH${ch} (${info.label})`)
                    .join(" · ")}
                </div>
              )}
              {step && step !== "neutral" && (
                <button
                  type="button"
                  className="cohere-btn-pill-outline text-xs"
                  onClick={retryCurrentStep}
                >
                  ทำซ้ำขั้นนี้ (รีเซ็ต Δ)
                </button>
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
                ถ้ายกแขนซ้ายแล้วหุ่นยกขวา ให้กดสลับแขน · หรือแก้ dropdown รายช่องแล้วบันทึก
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void applySideSwap("arms")}
                className="cohere-btn-pill-outline text-xs disabled:opacity-50"
              >
                {busy === "swap:arms" ? "…" : "สลับแขนซ้าย ↔ ขวา"}
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void applySideSwap("legs")}
                className="cohere-btn-pill-outline text-xs disabled:opacity-50"
              >
                {busy === "swap:legs" ? "…" : "สลับขาซ้าย ↔ ขวา"}
              </button>
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-2">
                {Array.from({ length: SENSOR_COUNT }, (_, ch) => (
                  <label key={ch} className="flex items-center gap-2 text-xs">
                    <span className="w-10 font-mono-label text-cohere-ink">CH{ch}</span>
                    {ch === CENTER_CHANNEL ? (
                      <span className="cohere-input flex-1 py-1.5 text-xs text-cohere-muted">
                        {MAPPING_LABELS.center}
                      </span>
                    ) : (
                      <select
                        className="cohere-input flex-1 py-1.5 text-xs"
                        value={editMap[ch]}
                        onChange={(e) =>
                          setEditMap((prev) =>
                            ensureCenterInMap({
                              ...prev,
                              [ch]: e.target.value as PoseKey,
                            }),
                          )
                        }
                      >
                        {POSE_KEYS.map((key) => (
                          <option key={key} value={key}>
                            {POSE_LABELS[key]}
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                ))}
                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => void saveManualMap()}
                    className="cohere-btn-primary px-4 py-2 text-xs disabled:opacity-50"
                  >
                    {busy === "set" ? "…" : "บันทึกแมป → sensor_map.json"}
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
                  Verify live Δ — เทียบ baseline (หรือตั้งใหม่) · ขยับทีละข้างเพื่อเช็กแมป
                </p>
                <ChannelActivityBars
                  degrees={degrees}
                  baseline={neutralBaseline}
                  map={editMap}
                  locked={centerLocked()}
                  peakDeltas={peakDeltas}
                  topCandidates={pickTopFree(peakDeltas, centerLocked())}
                />
                <button
                  type="button"
                  className="cohere-btn-pill-outline mt-2 text-xs"
                  onClick={() => {
                    setNeutralBaseline([...degrees]);
                    setPeakDeltas(Array.from({ length: SENSOR_COUNT }, () => 0));
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
              {" "}— ยืน/นั่งนิ่งก่อนกด (ใช้เป็น neutral สำหรับ Δ ในเกม)
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
          {phase === "review" && "แก้แมป / สลับข้าง แล้วกดบันทึก หรือไปขั้นท่ายืน/นั่ง"}
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
