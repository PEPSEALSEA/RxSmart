"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postSensorMappingAction } from "@/lib/local-bridge";
import type { SensorChannelReading } from "@/lib/sensor-mapping";
import {
  CALIBRATION_STEP_LABELS,
  CALIBRATION_STEP_SAVE_HINTS,
  ChannelMap,
  parseChannelMap,
  POSE_PROFILE_LABELS,
  saveStoredChannelMap,
  SensorMappingState,
} from "@/lib/sensor-mapping";
import { POSE_KEYS, POSE_LABELS, PoseKey } from "@/lib/pose";

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

/** Real motion for forearm/leg steps is ~10–20°; ignore smaller jitter. */
const ACTIVE_DELTA_DEG = 10;
/** Bar fills fully around a solid bilateral move (~20°). */
const BAR_FULL_SCALE_DEG = 20;
/** Bilateral steps (ทั้งสองข้าง) ไฮไลต์ top-2 */
const TOP_N = 2;

function ChannelActivityBars({
  degrees,
  baseline,
  map,
  topN = TOP_N,
}: {
  degrees: number[];
  baseline: number[] | null;
  map: ChannelMap;
  topN?: number;
}) {
  const [peakDeltas, setPeakDeltas] = useState(() => Array.from({ length: 8 }, () => 0));
  const baselineKey = baseline?.join(",") ?? "none";

  useEffect(() => {
    setPeakDeltas(Array.from({ length: 8 }, () => 0));
  }, [baselineKey]);

  useEffect(() => {
    const instant = degrees.map((d, i) => Math.abs(d - (baseline?.[i] ?? d)));
    setPeakDeltas((prev) =>
      prev.map((peak, i) => {
        const now = instant[i] ?? 0;
        // Hold peaks; decay slowly so small jitter doesn't refill the bar
        if (now >= peak) return now;
        return Math.max(0, peak - 0.8);
      }),
    );
  }, [degrees, baseline]);

  const ranked = [...peakDeltas]
    .map((d, i) => ({ i, d }))
    .sort((a, b) => b.d - a.d);
  const topSet = new Set(
    ranked
      .filter((r) => r.d >= ACTIVE_DELTA_DEG)
      .slice(0, topN)
      .map((r) => r.i),
  );

  return (
    <div className="space-y-2">
      <p className="cohere-mono-label text-[10px]">
        Live CH0–CH7 · ไฮไลต์ top {topN} ที่ Δ≥{ACTIVE_DELTA_DEG}° (ขยับจริง ~{ACTIVE_DELTA_DEG}–
        {BAR_FULL_SCALE_DEG}°)
      </p>
      {degrees.map((deg, ch) => {
        const delta = peakDeltas[ch] ?? 0;
        const isTop = topSet.has(ch);
        const active = delta >= ACTIVE_DELTA_DEG;
        const width = Math.min(100, (delta / BAR_FULL_SCALE_DEG) * 100);
        const label = POSE_LABELS[map[ch]] ?? map[ch] ?? "—";
        return (
          <div
            key={ch}
            className={`rounded-cohere-sm border px-3 py-2 ${
              isTop
                ? "border-cohere-primary bg-cohere-pale-green"
                : active
                  ? "border-cohere-hairline bg-cohere-primary/5"
                  : "border-cohere-hairline bg-white"
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-mono-label text-cohere-ink">
                CH{ch}
                {isTop ? " · top mover" : active ? " · กำลังขยับ" : ""}
              </span>
              <span className="text-cohere-body-muted">
                {deg.toFixed(1)}° · Δ{delta.toFixed(1)}°
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-cohere-muted">{label}</p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-100">
              <div
                className={`h-full rounded-full transition-[width] duration-150 ${
                  isTop ? "bg-cohere-primary" : active ? "bg-neutral-500" : "bg-neutral-300"
                }`}
                style={{ width: `${width}%` }}
              />
            </div>
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
  const [baseline, setBaseline] = useState<number[] | null>(null);
  const stepEnteredAt = useRef(0);

  const degrees = useMemo(
    () => degreesFromSources(sensors, channelDegrees ?? mapping?.channel_degrees),
    [sensors, channelDegrees, mapping?.channel_degrees],
  );

  const step = mapping?.calibration_step && mapping.calibration_step !== "idle"
    ? mapping.calibration_step
    : null;

  const stepIndex = step ? GUIDED_ORDER.indexOf(step as (typeof GUIDED_ORDER)[number]) : -1;

  useEffect(() => {
    if (!open) return;
    setPhase("intro");
    setMessage("");
    setBusy("");
    setBaseline(null);
    setEditMap(parseChannelMap(mapping?.channel_map));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mapping?.channel_map) {
      setEditMap(parseChannelMap(mapping.channel_map));
    }
  }, [mapping?.channel_map]);

  useEffect(() => {
    if (phase !== "guided" || !step) return;
    setBaseline([...degrees]);
    stepEnteredAt.current = Date.now();
  }, [phase, step]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const data = await postSensorMappingAction(bridgeUrl, "calibrate_next");
      applyMappingResult(data);
      if (data.step === "complete") {
        setPhase("review");
        setMessage("บันทึก channel_map + pose_defaults ลง sensor_map.json แล้ว — ตรวจแมปด้านล่าง");
      } else {
        const label = CALIBRATION_STEP_LABELS[data.step as string] ?? String(data.step);
        const idx = GUIDED_ORDER.indexOf(data.step as (typeof GUIDED_ORDER)[number]);
        setMessage(`ขั้น ${idx + 1}/${GUIDED_ORDER.length}: ${label}`);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="ปิด"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sensor-setup-title"
        className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-cohere-hairline bg-white shadow-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-cohere-hairline px-5 py-4">
          <div>
            <p className="cohere-mono-label text-[11px]">IMU · Local Python</p>
            <h2 id="sensor-setup-title" className="mt-1 text-lg text-cohere-ink">
              Setup Wizard
            </h2>
            <p className="mt-1 text-xs text-cohere-muted">
              บันทึกลงไฟล์ <span className="font-mono-label">rxsmart-local/sensor_map.json</span>{" "}
              บนเครื่องนี้ — ไม่ผ่าน Cloudflare
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {phase === "intro" && (
            <div className="space-y-4 text-sm text-cohere-body-muted">
              <p>
                Wizard นี้จับว่า <strong className="font-medium text-cohere-ink">board CH ไหน</strong>{" "}
                คือแขน/ขาข้อไหน โดยดูว่าตอนคุณขยับ ส่วนไหนของร่างกาย CH ไหนเปลี่ยนมุมมากสุด
              </p>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong className="font-medium text-cohere-ink">channel_map</strong> — CH0–7 →
                  ข้อต่อ (แก้เคสยกแขนแล้วขาตาม)
                </li>
                <li>
                  <strong className="font-medium text-cohere-ink">pose_defaults</strong> — มุม
                  baseline ท่ายืนหลัง setup
                </li>
                <li>
                  <strong className="font-medium text-cohere-ink">pose_profiles</strong> — ท่ายืน/นั่ง
                  ที่บันทึกทีหลัง
                </li>
              </ul>
              <p className="rounded-cohere-sm bg-cohere-primary/5 px-3 py-2 text-xs">
                บอร์ดส่งมุมแกนเดียวต่อ CH — ยังแยก “ยกไปข้างหน้า vs ข้างๆ” ใน firmware ไม่ได้
                (plane ของขาใน 3D ถูกเดาจากท่ายืน/นั่ง)
              </p>
              <p className="text-xs text-cohere-muted">
                ขยับทั้งสองข้างตามคำสั่ง · ดูแถบ CH ว่าตัวไหนกระพริบ · ถ้าแมปผิดแก้ในขั้น Review ได้
              </p>
            </div>
          )}

          {phase === "guided" && (
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-3">
                <p className="cohere-mono-label text-[11px]">
                  ขั้น {Math.max(1, stepIndex + 1)}/{GUIDED_ORDER.length}
                </p>
                <p className="text-base text-cohere-ink">
                  {step
                    ? CALIBRATION_STEP_LABELS[step] ?? step
                    : "กำลังเริ่ม…"}
                </p>
                <p className="text-xs text-cohere-muted">
                  {step
                    ? CALIBRATION_STEP_SAVE_HINTS[step] ?? "กำลังเก็บตัวอย่างในหน่วยความจำ"
                    : ""}
                </p>
                <p className="rounded-cohere-sm border border-dashed border-cohere-hairline px-3 py-2 text-xs text-cohere-body-muted">
                  ทำตามคำสั่งประมาณ 3–5 วินาที แล้วกดขั้นถัดไป — ดูขวาว่าระบบเห็น CH ไหนขยับ
                </p>
              </div>
              <ChannelActivityBars degrees={degrees} baseline={baseline} map={mapForBars} />
            </div>
          )}

          {phase === "review" && (
            <div className="space-y-4">
              <div>
                <p className="text-sm text-cohere-ink">ตรวจ / แก้แมป CH → ข้อต่อ</p>
                <p className="mt-1 text-xs text-cohere-muted">
                  ถ้ายกแขนแล้วขาตาม ให้เปลี่ยน dropdown ให้ถูก แล้วกดบันทึกแมป · หรือลอง Verify
                  โดยยกแขนซ้ายแล้วดู CH ที่ไฮไลต์
                </p>
                <p className="mt-1 text-xs text-cohere-muted">
                  กดบันทึกจะเขียน <span className="font-mono-label">channel_map</span> ทับใน{" "}
                  <span className="font-mono-label">sensor_map.json</span>
                </p>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
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
                    Verify — ยกแขน/ขาทีละข้าง แล้วดู CH ที่ขยับ
                  </p>
                  <ChannelActivityBars
                    degrees={degrees}
                    baseline={baseline ?? degrees}
                    map={editMap}
                  />
                  <button
                    type="button"
                    className="cohere-btn-pill-outline mt-2 text-xs"
                    onClick={() => setBaseline([...degrees])}
                  >
                    ตั้ง baseline ใหม่ (ยืนนิ่งแล้วกด)
                  </button>
                </div>
              </div>
            </div>
          )}

          {phase === "poses" && (
            <div className="space-y-4 text-sm text-cohere-body-muted">
              <p>
                บันทึกท่ายืน/นั่งปกติ → เขียน{" "}
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
            <div className="space-y-3 text-sm text-cohere-body-muted">
              <p className="text-cohere-ink">Setup เสร็จ</p>
              <p>
                confidence{" "}
                {mapping ? `${Math.round(mapping.confidence * 100)}%` : "—"} · ไฟล์{" "}
                <span className="font-mono-label">sensor_map.json</span> อัปเดตแล้ว
              </p>
              <p className="text-xs">
                ลองยกแขนข้างเดียวใน 3D — ถ้าขายังตาม กลับมาแก้แมปใน Setup Wizard → Review
              </p>
            </div>
          )}

          {message && (
            <p className="mt-4 rounded-cohere-sm bg-cohere-pale-green px-4 py-2.5 text-xs text-cohere-ink">
              {message}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-cohere-hairline px-5 py-4">
          <div className="text-[11px] text-cohere-muted">
            {phase === "intro" && "ยังไม่เซฟ"}
            {phase === "guided" && (step ? CALIBRATION_STEP_SAVE_HINTS[step] : "")}
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
    </div>
  );
}
