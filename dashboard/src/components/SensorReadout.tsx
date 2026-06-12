"use client";

import { UPPER_JOINT_LIMITS, LOWER_JOINT_LIMITS } from "@/lib/biomechanics";
import {
  LOWER_KEYS,
  LOWER_SENSOR_CHANNEL,
  POSE_LABELS,
  UPPER_KEYS,
  UPPER_SENSOR_CHANNEL,
  planeLabel,
} from "@/lib/pose";
import { JointFeedback, LowerJointFeedback, UpperJointFeedback } from "@/lib/pose-physics";
import { PoseKey } from "@/lib/pose";

interface SensorReadoutProps {
  jointFeedback: Record<PoseKey, JointFeedback>;
}

function isUpperFb(fb: JointFeedback): fb is UpperJointFeedback {
  return "plane" in fb;
}

function speedColor(speed: number, max: number, idealMin: number, idealMax: number, active: boolean): string {
  if (!active) return "text-slate-400";
  if (speed > max * 0.85) return "text-rose-500";
  if (speed >= idealMin && speed <= idealMax) return "text-emerald-600";
  if (speed < idealMin * 0.4 && speed > 0.5) return "text-amber-500";
  return "text-sky-600";
}

export default function SensorReadout({ jointFeedback }: SensorReadoutProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {UPPER_KEYS.map((key) => {
        const fb = jointFeedback[key];
        if (!isUpperFb(fb)) return null;
        const lim = UPPER_JOINT_LIMITS[key];
        const speed = Math.hypot(fb.vElevation, fb.vPlane);
        const elevPct = (fb.elevation / lim.elevation.max) * 100;

        return (
          <div
            key={key}
            className={`rounded-xl border p-2.5 ${
              fb.isActive ? "border-cyan-200 bg-cyan-50/60 shadow-sm" : "border-sky-100 bg-white/70"
            }`}
          >
            <div className="flex justify-between">
              <span className="text-[10px] text-slate-500">Ch{UPPER_SENSOR_CHANNEL[key]} · proximal</span>
              {fb.isActive && <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />}
            </div>
            <p className="mt-0.5 text-[11px] font-medium text-slate-700">{POSE_LABELS[key].split(" (")[0]}</p>
            <p className="mt-1 font-mono text-sm font-bold text-slate-800">
              ↑ {fb.elevation.toFixed(0)}°
              <span className="mx-1 text-slate-300">|</span>
              ↻ {fb.plane.toFixed(0)}°
            </p>
            <p className="text-[10px] text-sky-600">{planeLabel(fb.plane)}</p>
            <p className={`font-mono text-[10px] ${speedColor(speed, lim.plane.maxVelocity, lim.elevation.idealVelocityMin, lim.plane.idealVelocityMax, fb.isActive)}`}>
              {speed.toFixed(1)}°/s รวม
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sky-100">
              <div
                className={`h-full rounded-full ${fb.angleOk && fb.isActive ? "bg-emerald-400" : "bg-cyan-400"}`}
                style={{ width: `${Math.min(100, elevPct)}%` }}
              />
            </div>
          </div>
        );
      })}

      {LOWER_KEYS.map((key) => {
        const fb = jointFeedback[key] as LowerJointFeedback;
        const lim = LOWER_JOINT_LIMITS[key].bend;
        const pct = (fb.bend / lim.max) * 100;

        return (
          <div
            key={key}
            className={`rounded-xl border p-2.5 ${
              fb.isActive ? "border-cyan-200 bg-cyan-50/60 shadow-sm" : "border-sky-100 bg-white/70"
            }`}
          >
            <div className="flex justify-between">
              <span className="text-[10px] text-slate-500">Ch{LOWER_SENSOR_CHANNEL[key]} · distal</span>
              {fb.isActive && <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />}
            </div>
            <p className="mt-0.5 text-[11px] font-medium text-slate-700">{POSE_LABELS[key].split(" (")[0]}</p>
            <p className="mt-1 font-mono text-lg font-bold text-slate-800">งอ {fb.bend.toFixed(0)}°</p>
            <p className={`font-mono text-[10px] ${speedColor(Math.abs(fb.vBend), lim.maxVelocity, lim.idealVelocityMin, lim.idealVelocityMax, fb.isActive)}`}>
              {fb.vBend >= 0 ? "+" : ""}
              {fb.vBend.toFixed(1)}°/s
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sky-100">
              <div
                className={`h-full rounded-full ${fb.angleOk && fb.isActive ? "bg-emerald-400" : "bg-sky-300"}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
