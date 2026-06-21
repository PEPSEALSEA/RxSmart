"use client";

import { FormEvent } from "react";
import { Device, formatLastSeen, isDeviceOnline } from "@/lib/devices";
import { REHAB_EXERCISES } from "@/lib/rehab-exercises";

interface AdminDeviceModalProps {
  device: Device;
  currentTime: number;
  wifiSsid: string;
  wifiPassword: string;
  exerciseId: string;
  repTarget: number;
  actionLoading: string;
  actionMessage: string;
  actionError: string;
  onClose: () => void;
  onWifiSsidChange: (value: string) => void;
  onWifiPasswordChange: (value: string) => void;
  onExerciseIdChange: (value: string) => void;
  onRepTargetChange: (value: number) => void;
  onSubmitWifi: (event: FormEvent<HTMLFormElement>) => void;
  onRefreshStatus: () => void;
  onQueueCommand: (
    command: "SET_WIFI" | "CLEAR_WIFI" | "START_SESSION" | "END_SESSION" | "RECALIBRATE",
    body?: Record<string, string | number>,
  ) => void;
  onRemove: () => void;
}

export default function AdminDeviceModal({
  device,
  currentTime,
  wifiSsid,
  wifiPassword,
  exerciseId,
  repTarget,
  actionLoading,
  actionMessage,
  actionError,
  onClose,
  onWifiSsidChange,
  onWifiPasswordChange,
  onExerciseIdChange,
  onRepTargetChange,
  onSubmitWifi,
  onRefreshStatus,
  onQueueCommand,
  onRemove,
}: AdminDeviceModalProps) {
  const online = isDeviceOnline(device.last_online, currentTime);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4 backdrop-blur-sm animate-fade-in-only">
      <section className="animate-scale-in max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">ควบคุมบอร์ด</p>
            <h2 className="mt-1 text-lg font-semibold text-neutral-900">{device.device_id}</h2>
            <p className="mt-1 text-xs text-neutral-500">{formatLastSeen(device.last_online)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            ปิด
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">สถานะ</p>
            <p className={`mt-1 text-sm font-semibold ${online ? "text-emerald-600" : "text-neutral-400"}`}>
              {online ? "ออนไลน์" : "ออฟไลน์"}
            </p>
          </div>
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">WiFi ปัจจุบัน</p>
            <p className="mt-1 truncate text-sm text-neutral-800">{device.wifi_ssid}</p>
          </div>
        </div>

        <form onSubmit={onSubmitWifi} className="mt-6 space-y-3">
          <div>
            <label className="text-xs font-medium text-neutral-600" htmlFor="admin-wifi-ssid">
              WiFi SSID ใหม่
            </label>
            <input
              id="admin-wifi-ssid"
              value={wifiSsid}
              onChange={(event) => onWifiSsidChange(event.target.value)}
              required
              className="mt-1.5 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-neutral-400"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-neutral-600" htmlFor="admin-wifi-password">
              รหัสผ่าน (ว่าง = เปิด)
            </label>
            <input
              id="admin-wifi-password"
              value={wifiPassword}
              onChange={(event) => onWifiPasswordChange(event.target.value)}
              type="password"
              className="mt-1.5 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-neutral-400"
            />
          </div>
          <button
            type="submit"
            disabled={actionLoading === "SET_WIFI"}
            className="w-full rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
          >
            {actionLoading === "SET_WIFI" ? "กำลังส่ง…" : "บันทึก WiFi ไปบอร์ด"}
          </button>
        </form>

        <div className="mt-6 rounded-xl border border-neutral-200 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">Session บน ESP32</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs text-neutral-500">โปรแกรมฝึก (exercise_id)</label>
              <select
                value={exerciseId}
                onChange={(event) => onExerciseIdChange(event.target.value)}
                className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm"
              >
                <option value="general">general (default)</option>
                {REHAB_EXERCISES.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-neutral-500">Rep target</label>
              <input
                type="number"
                min={1}
                max={99}
                value={repTarget}
                onChange={(event) => onRepTargetChange(Number(event.target.value) || 10)}
                className="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => onQueueCommand("START_SESSION", { exercise_id: exerciseId, rep_target: repTarget })}
              disabled={actionLoading === "START_SESSION"}
              className="rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {actionLoading === "START_SESSION" ? "…" : "Start Session"}
            </button>
            <button
              type="button"
              onClick={() => onQueueCommand("END_SESSION")}
              disabled={actionLoading === "END_SESSION"}
              className="rounded-xl bg-neutral-900 px-3 py-2.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {actionLoading === "END_SESSION" ? "…" : "End Session"}
            </button>
            <button
              type="button"
              onClick={() => onQueueCommand("RECALIBRATE")}
              disabled={actionLoading === "RECALIBRATE"}
              className="rounded-xl border border-neutral-200 px-3 py-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {actionLoading === "RECALIBRATE" ? "…" : "Recalibrate"}
            </button>
            <button
              type="button"
              onClick={onRefreshStatus}
              className="rounded-xl border border-neutral-200 px-3 py-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Refresh Status
            </button>
            <button
              type="button"
              onClick={() => onQueueCommand("CLEAR_WIFI")}
              disabled={actionLoading === "CLEAR_WIFI"}
              className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              {actionLoading === "CLEAR_WIFI" ? "…" : "Clear WiFi"}
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={actionLoading === "REMOVE"}
              className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              {actionLoading === "REMOVE" ? "…" : "Remove Board"}
            </button>
          </div>
        </div>

        {actionMessage && (
          <p className="mt-4 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{actionMessage}</p>
        )}
        {actionError && (
          <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{actionError}</p>
        )}
      </section>
    </div>
  );
}
