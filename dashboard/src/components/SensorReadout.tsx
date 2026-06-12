"use client";

import { JOINT_LIMITS } from "@/lib/biomechanics";
import { POSE_KEYS, POSE_LABELS, SENSOR_CHANNELS } from "@/lib/pose";
import { JointFeedback } from "@/lib/pose-physics";

interface SensorReadoutProps {
  jointFeedback: Record<import("@/lib/pose").PoseKey, JointFeedback>;
}

function velocityColor(speed: number, key: import("@/lib/pose").PoseKey, isActive: boolean): string {
  if (!isActive) return "text-slate-400";
  const lim = JOINT_LIMITS[key];
  const abs = Math.abs(speed);
  if (abs > lim.maxVelocity * 0.85) return "text-rose-500";
  if (abs >= lim.idealVelocityMin && abs <= lim.idealVelocityMax) return "text-emerald-600";
  if (abs < lim.idealVelocityMin * 0.4 && abs > 0.5) return "text-amber-500";
  return "text-sky-600";
}

export default function SensorReadout({ jointFeedback }: SensorReadoutProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {POSE_KEYS.map((key) => {
        const fb = jointFeedback[key];
        const lim = JOINT_LIMITS[key];
        const romPct = ((fb.angle - lim.min) / (lim.max - lim.min)) * 100;
        const targetPct = ((fb.target - lim.min) / (lim.max - lim.min)) * 100;

        return (
          <div
            key={key}
            className={`rounded-xl border p-2.5 transition ${
              fb.isActive
                ? "border-cyan-200 bg-cyan-50/60 shadow-sm"
                : "border-sky-100 bg-white/70"
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[10px] font-medium leading-tight text-slate-500">
                Ch{SENSOR_CHANNELS[key]}
              </span>
              {fb.isActive && (
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
              )}
            </div>
            <p className="mt-0.5 text-[11px] font-medium text-slate-700 leading-tight">
              {POSE_LABELS[key].split(" (")[0]}
            </p>
            <p className="mt-1 font-mono text-lg font-bold text-slate-800">
              {fb.angle.toFixed(0)}°
            </p>
            <p className={`font-mono text-[10px] ${velocityColor(fb.velocity, key, fb.isActive)}`}>
              {fb.velocity >= 0 ? "+" : ""}
              {fb.velocity.toFixed(1)}°/s
            </p>
            <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-sky-100">
              <div
                className="absolute top-0 h-full w-0.5 bg-sky-400/60"
                style={{ left: `${targetPct}%` }}
              />
              <div
                className={`h-full rounded-full transition-all ${
                  fb.angleOk && fb.isActive ? "bg-emerald-400" : fb.isActive ? "bg-cyan-400" : "bg-sky-300"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, romPct))}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
