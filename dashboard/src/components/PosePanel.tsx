"use client";

import {
  NEUTRAL_POSE,
  POSE_KEYS,
  POSE_LABELS,
  POSE_PRESETS,
  PoseAngles,
  PoseKey,
  SENSOR_CHANNELS,
  guessExercise,
} from "@/lib/pose";

interface PosePanelProps {
  pose: PoseAngles;
  onChange: (pose: PoseAngles) => void;
  onReset: () => void;
  demoPlaying: boolean;
  onToggleDemo: () => void;
}

export default function PosePanel({
  pose,
  onChange,
  onReset,
  demoPlaying,
  onToggleDemo,
}: PosePanelProps) {
  const exercise = guessExercise(pose);

  const updateJoint = (key: PoseKey, value: number) => {
    onChange({ ...pose, [key]: value });
  };

  const applyPreset = (presetPose: PoseAngles) => {
    onChange({ ...presetPose });
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="rounded-2xl border border-sky-100 bg-gradient-to-br from-white to-sky-50/60 p-5">
        <p className="text-xs font-medium uppercase tracking-wider text-sky-500">ท่าปัจจุบัน</p>
        <p className="mt-2 text-xl font-semibold text-slate-800">{exercise}</p>
        <p className="mt-1 text-sm text-slate-400">Mock data — จะเชื่อม MPU6050 ภายหลัง</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {POSE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => applyPreset(preset.pose)}
            title={preset.description}
            className="rounded-xl border border-sky-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onReset}
          className="flex-1 rounded-xl border border-sky-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-sky-50"
        >
          รีเซ็ตท่า
        </button>
        <button
          type="button"
          onClick={onToggleDemo}
          className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
            demoPlaying
              ? "bg-sky-500 text-white shadow-sm shadow-sky-200"
              : "border border-sky-200 bg-white text-sky-600 hover:bg-sky-50"
          }`}
        >
          {demoPlaying ? "หยุด Demo" : "เล่น Demo"}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {POSE_KEYS.map((key) => (
          <div key={key} className="rounded-xl border border-sky-100 bg-white/80 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <label htmlFor={key} className="text-sm font-medium text-slate-700">
                {POSE_LABELS[key]}
              </label>
              <span className="shrink-0 rounded-lg bg-sky-50 px-2 py-0.5 font-mono text-xs text-sky-600">
                Ch{SENSOR_CHANNELS[key]} · {Math.round(pose[key])}°
              </span>
            </div>
            <input
              id={key}
              type="range"
              min={0}
              max={180}
              step={1}
              value={pose[key]}
              onChange={(e) => updateJoint(key, Number(e.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-sky-100 accent-sky-500"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export { NEUTRAL_POSE };
