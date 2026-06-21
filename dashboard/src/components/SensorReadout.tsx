"use client";

import FadeIn from "@/components/ui/FadeIn";
import { UPPER_JOINT_LIMITS, LOWER_JOINT_LIMITS } from "@/lib/biomechanics";
import {
  LOWER_KEYS,
  LOWER_SENSOR_CHANNEL,
  POSE_LABELS,
  UPPER_KEYS,
  UPPER_SENSOR_CHANNEL,
  planeLabel,
  PoseKey,
} from "@/lib/pose";
import { JointFeedback, LowerJointFeedback, UpperJointFeedback } from "@/lib/pose-physics";

interface SensorReadoutProps {
  jointFeedback: Record<PoseKey, JointFeedback>;
}

function isUpperFb(fb: JointFeedback): fb is UpperJointFeedback {
  return "plane" in fb;
}

function speedTone(
  speed: number,
  max: number,
  idealMin: number,
  idealMax: number,
  active: boolean,
): string {
  if (!active) return "text-neutral-300";
  if (speed > max * 0.85) return "text-red-500";
  if (speed >= idealMin && speed <= idealMax) return "text-emerald-600";
  if (speed < idealMin * 0.4 && speed > 0.5) return "text-amber-600";
  return "text-neutral-600";
}

function SensorCard({
  delay,
  channel,
  role,
  label,
  active,
  primary,
  secondary,
  speed,
  speedClass,
  progress,
  progressTone,
}: {
  delay: number;
  channel: number;
  role: string;
  label: string;
  active: boolean;
  primary: string;
  secondary?: string;
  speed: string;
  speedClass: string;
  progress: number;
  progressTone: string;
}) {
  return (
    <FadeIn delay={delay}>
      <div
        className={`group rounded-2xl border p-3 transition-all duration-300 ${
          active
            ? "border-neutral-900/15 bg-white shadow-sm ring-1 ring-neutral-900/5"
            : "border-neutral-200/80 bg-neutral-50/40 hover:border-neutral-300/80"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">
              Ch{channel} · {role}
            </p>
            <p className="mt-1 text-xs font-medium text-neutral-700">{label}</p>
          </div>
          {active && (
            <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-neutral-900 animate-pulse-soft" />
          )}
        </div>

        <p className="mt-2 font-mono text-base font-semibold tabular-nums text-neutral-900">{primary}</p>
        {secondary && <p className="mt-0.5 text-[10px] text-neutral-500">{secondary}</p>}

        <p className={`mt-1.5 font-mono text-[10px] tabular-nums ${speedClass}`}>{speed}</p>

        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-neutral-100">
          <div
            className={`h-full rounded-full transition-all duration-500 ease-out ${progressTone}`}
            style={{ width: `${Math.min(100, progress)}%` }}
          />
        </div>
      </div>
    </FadeIn>
  );
}

export default function SensorReadout({ jointFeedback }: SensorReadoutProps) {
  let delay = 0;
  const step = 40;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-4">
      {UPPER_KEYS.map((key) => {
        const fb = jointFeedback[key];
        if (!isUpperFb(fb)) return null;
        const lim = UPPER_JOINT_LIMITS[key];
        const speed = Math.hypot(fb.vElevation, fb.vPlane);
        const elevPct = (fb.elevation / lim.elevation.max) * 100;
        const currentDelay = delay;
        delay += step;

        return (
          <SensorCard
            key={key}
            delay={currentDelay}
            channel={UPPER_SENSOR_CHANNEL[key]}
            role="proximal"
            label={POSE_LABELS[key].split(" (")[0]}
            active={fb.isActive}
            primary={`↑${fb.elevation.toFixed(0)}° · ↻${fb.plane.toFixed(0)}°`}
            secondary={planeLabel(fb.plane)}
            speed={`${speed.toFixed(1)}°/s`}
            speedClass={speedTone(
              speed,
              lim.plane.maxVelocity,
              lim.elevation.idealVelocityMin,
              lim.plane.idealVelocityMax,
              fb.isActive,
            )}
            progress={elevPct}
            progressTone={fb.angleOk && fb.isActive ? "bg-emerald-500" : "bg-neutral-400"}
          />
        );
      })}

      {LOWER_KEYS.map((key) => {
        const fb = jointFeedback[key] as LowerJointFeedback;
        const lim = LOWER_JOINT_LIMITS[key].bend;
        const pct = (fb.bend / lim.max) * 100;
        const currentDelay = delay;
        delay += step;

        return (
          <SensorCard
            key={key}
            delay={currentDelay}
            channel={LOWER_SENSOR_CHANNEL[key]}
            role="distal"
            label={POSE_LABELS[key].split(" (")[0]}
            active={fb.isActive}
            primary={`งอ ${fb.bend.toFixed(0)}°`}
            speed={`${fb.vBend >= 0 ? "+" : ""}${fb.vBend.toFixed(1)}°/s`}
            speedClass={speedTone(
              Math.abs(fb.vBend),
              lim.maxVelocity,
              lim.idealVelocityMin,
              lim.idealVelocityMax,
              fb.isActive,
            )}
            progress={pct}
            progressTone={fb.angleOk && fb.isActive ? "bg-emerald-500" : "bg-neutral-500"}
          />
        );
      })}
    </div>
  );
}
