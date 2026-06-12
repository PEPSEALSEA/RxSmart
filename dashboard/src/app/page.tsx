"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import PosePanel, { NEUTRAL_POSE } from "@/components/PosePanel";
import { Device, formatLastSeen, getApiUrl, getErrorMessage, isDeviceOnline } from "@/lib/devices";
import { POSE_PRESETS, PoseAngles, lerpPose } from "@/lib/pose";

const PoseViewer = dynamic(() => import("@/components/PoseViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[340px] items-center justify-center rounded-2xl border border-sky-100 bg-sky-50">
      <div className="h-9 w-9 animate-spin rounded-full border-2 border-sky-200 border-t-sky-500" />
    </div>
  ),
});

const DEMO_PRESETS = POSE_PRESETS.filter((p) => p.id !== "stand");

export default function UserHome() {
  const [pose, setPose] = useState<PoseAngles>({ ...NEUTRAL_POSE });
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);

  const demoFrameRef = useRef<number | null>(null);
  const demoStartRef = useRef(0);

  const apiUrl = getApiUrl();

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError("");
    setCurrentTime(Date.now());
    try {
      const res = await fetch(`${apiUrl}/api/devices`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "โหลดข้อมูลไม่สำเร็จ");
      setDevices(data.devices || []);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    const initialLoad = setTimeout(() => {
      void fetchDevices();
    }, 0);
    const interval = setInterval(() => {
      void fetchDevices();
    }, 30000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [fetchDevices]);

  useEffect(() => {
    if (!demoPlaying) {
      if (demoFrameRef.current !== null) {
        cancelAnimationFrame(demoFrameRef.current);
        demoFrameRef.current = null;
      }
      return;
    }

    const segmentMs = 2200;
    const holdMs = 600;

    const tick = (now: number) => {
      if (!demoStartRef.current) demoStartRef.current = now;
      const elapsed = now - demoStartRef.current;
      const cycleLen = DEMO_PRESETS.length * (segmentMs + holdMs);
      const cyclePos = elapsed % cycleLen;
      const segmentIndex = Math.floor(cyclePos / (segmentMs + holdMs));
      const segmentElapsed = cyclePos % (segmentMs + holdMs);

      const from = segmentIndex === 0 ? NEUTRAL_POSE : DEMO_PRESETS[segmentIndex - 1].pose;
      const to = DEMO_PRESETS[segmentIndex].pose;

      if (segmentElapsed < segmentMs) {
        const t = segmentElapsed / segmentMs;
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        setPose(lerpPose(from, to, eased));
      } else {
        setPose({ ...to });
      }

      demoFrameRef.current = requestAnimationFrame(tick);
    };

    demoStartRef.current = 0;
    demoFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (demoFrameRef.current !== null) {
        cancelAnimationFrame(demoFrameRef.current);
      }
    };
  }, [demoPlaying]);

  const onlineCount = devices.filter((device) => isDeviceOnline(device.last_online, currentTime)).length;

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-50 via-blue-50/80 to-sky-100 text-slate-700">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-16 h-72 w-72 rounded-full bg-sky-200/50 blur-3xl" />
        <div className="absolute top-1/3 -left-20 h-64 w-64 rounded-full bg-blue-200/40 blur-3xl" />
        <div className="absolute bottom-0 right-1/4 h-80 w-80 rounded-full bg-cyan-100/60 blur-3xl" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-12">
        <header className="mb-8 text-center sm:mb-10">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-sky-200/80 bg-white/70 px-4 py-1.5 text-sm text-sky-600 shadow-sm backdrop-blur-sm">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
            RxSmart · กายภาพบำบัด
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-800 sm:text-4xl">
            ดูท่าทาง
            <span className="block text-sky-500 sm:ml-2 sm:inline">แบบเรียลไทม์</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-500">
            ระบบแสดงท่าที่คุณกำลังทำจาก sensor 8 จุดบนแขนและขา — ตอนนี้ใช้ mock data ทดสอบก่อนเชื่อมบอร์ด
          </p>
        </header>

        <section className="mb-8 grid gap-6 lg:grid-cols-5 lg:gap-8">
          <div className="lg:col-span-3">
            <div className="rounded-3xl border border-white/80 bg-white/80 p-4 shadow-lg shadow-sky-100/80 backdrop-blur-sm sm:p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-800">ตัวอย่างท่า 3D</h2>
                <p className="text-xs text-slate-400">ลากเพื่อหมุน · scroll เพื่อซูม</p>
              </div>
              <div className="h-[min(52vh,420px)]">
                <PoseViewer pose={pose} />
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="h-[min(52vh,420px)] rounded-3xl border border-white/80 bg-white/80 p-4 shadow-lg shadow-sky-100/80 backdrop-blur-sm sm:p-5">
              <PosePanel
                pose={pose}
                onChange={setPose}
                onReset={() => {
                  setDemoPlaying(false);
                  setPose({ ...NEUTRAL_POSE });
                }}
                demoPlaying={demoPlaying}
                onToggleDemo={() => setDemoPlaying((v) => !v)}
              />
            </div>
          </div>
        </section>

        <section className="mb-8 rounded-3xl border border-white/80 bg-white/80 p-6 shadow-lg shadow-sky-100/80 backdrop-blur-sm sm:p-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-800">อุปกรณ์</h2>
              <p className="mt-1 text-sm text-slate-400">
                ออนไลน์ {onlineCount} / {devices.length} เครื่อง
              </p>
            </div>
            <button
              onClick={fetchDevices}
              disabled={loading}
              className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-600 transition hover:bg-sky-100 disabled:opacity-60"
            >
              {loading ? "กำลังโหลด..." : "รีเฟรช"}
            </button>
          </div>

          {loading && devices.length === 0 ? (
            <div className="flex h-24 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-sky-200 border-t-sky-500" />
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              {error}
            </div>
          ) : devices.length === 0 ? (
            <p className="text-center text-sm text-slate-400 py-6">
              ยังไม่มีบอร์ดเชื่อมต่อ — จะแสดงสถานะเมื่อ ESP32 ออนไลน์
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {devices.map((device) => {
                const online = isDeviceOnline(device.last_online, currentTime);
                return (
                  <article
                    key={device.device_id}
                    className="rounded-2xl border border-sky-100 bg-sky-50/30 px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-mono text-xs text-slate-600">{device.device_id}</p>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                          online ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {online ? "ออนไลน์" : "ออฟไลน์"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      {formatLastSeen(device.last_online)}
                    </p>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <footer className="flex flex-col items-center gap-3 border-t border-sky-100 pt-8 text-center sm:flex-row sm:justify-between sm:text-left">
          <p className="text-sm text-slate-400">RxSmart — กายภาพบำบัดด้วย IoT</p>
          <Link
            href="/admin"
            className="text-sm text-slate-400 transition hover:text-sky-500"
          >
            เข้าสู่ระบบผู้ดูแล →
          </Link>
        </footer>
      </div>
    </main>
  );
}
