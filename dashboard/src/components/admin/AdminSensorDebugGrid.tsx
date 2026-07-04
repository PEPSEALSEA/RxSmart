"use client";

import FadeIn from "@/components/ui/FadeIn";
import {
  FIRMWARE_SENSOR_TO_POSE,
  DEFAULT_CHANNEL_TO_POSE,
  LOWER_KEYS,
  POSE_LABELS,
  PoseKey,
  UPPER_KEYS,
} from "@/lib/pose";

export type RawSensor = {
  key?: string;
  pin?: number;
  raw?: number;
  zero_offset?: number;
  calibrated?: number;
  timestamp_ms?: number;
};

interface AdminSensorDebugGridProps {
  sensors?: RawSensor[];
}

const CHANNEL_TO_POSE: Record<number, PoseKey> = { ...DEFAULT_CHANNEL_TO_POSE };

function toAngle(calibrated: number | undefined): string {
  if (typeof calibrated !== "number" || Number.isNaN(calibrated)) return "—";
  return `${Math.max(0, Math.min(180, Math.abs(calibrated) * (180 / 4095))).toFixed(1)}°`;
}

function findSensorForChannel(sensors: RawSensor[] | undefined, channel: number): RawSensor | undefined {
  if (!sensors?.length) return undefined;

  const byIndex = sensors[channel];
  if (byIndex?.key) return byIndex;

  const expectedPose = CHANNEL_TO_POSE[channel];
  if (!expectedPose) return undefined;

  return sensors.find((sensor) => {
    if (!sensor.key) return false;
    return FIRMWARE_SENSOR_TO_POSE[sensor.key] === expectedPose;
  });
}

export default function AdminSensorDebugGrid({ sensors }: AdminSensorDebugGridProps) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, channel) => {
        const sensor = findSensorForChannel(sensors, channel);
        const poseKey = CHANNEL_TO_POSE[channel];
        const hasData = Boolean(sensor?.key);

        return (
          <FadeIn key={channel} delay={channel * 30}>
            <div
              className={`rounded-xl border p-3 transition-all duration-300 ${
                hasData
                  ? "border-neutral-900/10 bg-white shadow-sm ring-1 ring-neutral-900/5"
                  : "border-dashed border-neutral-200 bg-neutral-50/60"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                  CH{channel}
                </p>
                {hasData && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-soft" />
                )}
              </div>

              <p className="mt-1 text-xs font-medium text-neutral-800">
                {POSE_LABELS[poseKey].split(" (")[0]}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-neutral-400">{sensor?.key || "empty"}</p>

              <dl className="mt-2 space-y-1 font-mono text-[10px] tabular-nums text-neutral-600">
                <div className="flex justify-between gap-2">
                  <dt className="text-neutral-400">raw</dt>
                  <dd>{sensor?.raw ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-neutral-400">zero</dt>
                  <dd>{sensor?.zero_offset ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-neutral-400">cal</dt>
                  <dd>{sensor?.calibrated ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-2 border-t border-neutral-100 pt-1">
                  <dt className="text-neutral-400">angle</dt>
                  <dd className="font-semibold text-neutral-900">{toAngle(sensor?.calibrated)}</dd>
                </div>
              </dl>
            </div>
          </FadeIn>
        );
      })}
    </div>
  );
}
