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
  if (!active) return "text-cohere-muted";
  if (speed > max * 0.85) return "text-cohere-error";
  if (speed >= idealMin && speed <= idealMax) return "text-cohere-deep-green";
  if (speed < idealMin * 0.4 && speed > 0.5) return "text-cohere-coral";
  return "text-cohere-body-muted";
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
        className={`group rounded-cohere-sm border p-3 transition-all duration-300 ${
          active
            ? "border-cohere-primary/20 bg-cohere-canvas"
            : "border-cohere-hairline bg-cohere-soft-stone/60 hover:border-cohere-slate/40"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="cohere-mono-label text-[10px]">
              Ch{channel} · {role}
            </p>
            <p className="mt-1 text-xs font-medium text-cohere-ink">{label}</p>
          </div>
          {active && (
            <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-cohere-primary animate-pulse-soft" />
          )}
        </div>

        <p className="mt-2 font-mono-label text-base font-medium tabular-nums text-cohere-ink">{primary}</p>
        {secondary && <p className="mt-0.5 text-[10px] text-cohere-body-muted">{secondary}</p>}

        <p className={`mt-1.5 font-mono-label text-[10px] tabular-nums ${speedClass}`}>{speed}</p>

        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-cohere-hairline/60">
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
            progressTone={fb.angleOk && fb.isActive ? "bg-cohere-deep-green" : "bg-cohere-muted"}
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
            progressTone={fb.angleOk && fb.isActive ? "bg-cohere-deep-green" : "bg-cohere-slate"}
          />
        );
      })}
    </div>
  );
}
