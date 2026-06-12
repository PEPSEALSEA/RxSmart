"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Device, formatLastSeen, getApiUrl, getErrorMessage, isDeviceOnline } from "@/lib/devices";

const setupSteps = [
  {
    step: "1",
    title: "เปิดบอร์ด",
    description: "เสียบไฟหรือกดปุ่มรีเซ็ต บอร์ดจะสร้าง WiFi ชื่อ RxSmart-Setup",
  },
  {
    step: "2",
    title: "เชื่อมต่อ WiFi",
    description: "ใช้มือถือหรือคอมพิวเตอร์เชื่อมต่อกับ RxSmart-Setup",
  },
  {
    step: "3",
    title: "ตั้งค่า WiFi บ้าน",
    description: "หน้าตั้งค่าจะเปิดอัตโนมัติ กรอกชื่อและรหัส WiFi ที่ต้องการใช้",
  },
  {
    step: "4",
    title: "พร้อมใช้งาน",
    description: "บอร์ดจะเชื่อมต่ออินเทอร์เน็ตและส่งข้อมูลมายังระบบโดยอัตโนมัติ",
  },
];

export default function UserHome() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);

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

  const onlineCount = devices.filter((device) => isDeviceOnline(device.last_online, currentTime)).length;

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-50 via-blue-50/80 to-sky-100 text-slate-700">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -right-16 h-72 w-72 rounded-full bg-sky-200/50 blur-3xl" />
        <div className="absolute top-1/3 -left-20 h-64 w-64 rounded-full bg-blue-200/40 blur-3xl" />
        <div className="absolute bottom-0 right-1/4 h-80 w-80 rounded-full bg-cyan-100/60 blur-3xl" />
      </div>

      <div className="relative z-10 mx-auto max-w-5xl px-5 py-8 sm:px-6 sm:py-12">
        <header className="mb-10 text-center sm:mb-14">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-sky-200/80 bg-white/70 px-4 py-1.5 text-sm text-sky-600 shadow-sm backdrop-blur-sm">
            <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
            RxSmart
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-800 sm:text-4xl">
            ระบบดูแลอุปกรณ์
            <span className="block text-sky-500 sm:inline sm:ml-2">ของคุณ</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-slate-500">
            ตรวจสอบสถานะบอร์ดได้ง่ายๆ ในที่เดียว สบายตา ใช้งานสะดวก
          </p>
        </header>

        <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div className="col-span-2 rounded-3xl border border-white/80 bg-white/75 p-6 shadow-lg shadow-sky-100/80 backdrop-blur-sm sm:col-span-1">
            <p className="text-sm font-medium text-slate-400">อุปกรณ์ทั้งหมด</p>
            <p className="mt-2 text-4xl font-bold text-slate-800">{devices.length}</p>
          </div>
          <div className="rounded-3xl border border-white/80 bg-white/75 p-6 shadow-lg shadow-sky-100/80 backdrop-blur-sm">
            <p className="text-sm font-medium text-slate-400">ออนไลน์</p>
            <p className="mt-2 text-4xl font-bold text-emerald-500">{onlineCount}</p>
          </div>
          <div className="rounded-3xl border border-white/80 bg-white/75 p-6 shadow-lg shadow-sky-100/80 backdrop-blur-sm">
            <p className="text-sm font-medium text-slate-400">ออฟไลน์</p>
            <p className="mt-2 text-4xl font-bold text-slate-400">{devices.length - onlineCount}</p>
          </div>
        </section>

        <section className="mb-8 rounded-3xl border border-white/80 bg-white/80 p-6 shadow-lg shadow-sky-100/80 backdrop-blur-sm sm:p-8">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-800">อุปกรณ์ของฉัน</h2>
              <p className="mt-1 text-sm text-slate-400">อัปเดตอัตโนมัติทุก 30 วินาที</p>
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
            <div className="flex h-40 items-center justify-center">
              <div className="h-9 w-9 animate-spin rounded-full border-2 border-sky-200 border-t-sky-500" />
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              {error}
            </div>
          ) : devices.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-sky-200 bg-sky-50/50 px-6 py-12 text-center">
              <p className="text-lg font-medium text-slate-600">ยังไม่มีอุปกรณ์</p>
              <p className="mt-2 text-sm text-slate-400">ตั้งค่าบอร์ดตามขั้นตอนด้านล่างเพื่อเริ่มใช้งาน</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {devices.map((device) => {
                const online = isDeviceOnline(device.last_online, currentTime);
                return (
                  <article
                    key={device.device_id}
                    className="rounded-2xl border border-sky-100 bg-gradient-to-br from-white to-sky-50/50 p-5 shadow-sm transition hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-medium text-slate-700">
                          {device.device_id}
                        </p>
                        <p className="mt-1 text-sm text-slate-400">
                          WiFi: <span className="text-slate-600">{device.wifi_ssid}</span>
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                          online
                            ? "bg-emerald-100 text-emerald-600"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {online ? "ออนไลน์" : "ออฟไลน์"}
                      </span>
                    </div>
                    <p className="mt-4 text-xs text-slate-400">
                      อัปเดตล่าสุด {formatLastSeen(device.last_online)}
                    </p>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="mb-10 rounded-3xl border border-white/80 bg-white/80 p-6 shadow-lg shadow-sky-100/80 backdrop-blur-sm sm:p-8">
          <h2 className="text-xl font-semibold text-slate-800">วิธีตั้งค่าบอร์ดครั้งแรก</h2>
          <p className="mt-2 text-sm text-slate-400">ทำตาม 4 ขั้นตอนนี้เพื่อเชื่อมต่อบอร์ดเข้ากับ WiFi บ้าน</p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {setupSteps.map((item) => (
              <div
                key={item.step}
                className="flex gap-4 rounded-2xl border border-sky-100 bg-sky-50/40 p-5"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-400 text-sm font-bold text-white shadow-sm shadow-sky-200">
                  {item.step}
                </span>
                <div>
                  <h3 className="font-semibold text-slate-700">{item.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-500">{item.description}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-sky-100 bg-gradient-to-r from-sky-50 to-blue-50 px-5 py-4">
            <p className="text-sm text-slate-600">
              <span className="font-medium text-sky-600">เคล็ดลับ:</span>{" "}
              หากหน้าตั้งค่าไม่เปิดอัตโนมัติ ให้เปิดเบราว์เซอร์แล้วไปที่{" "}
              <span className="font-mono text-sky-600">http://setup.local</span>{" "}
              หรือ <span className="font-mono text-sky-600">192.168.4.1</span>
            </p>
          </div>
        </section>

        <footer className="flex flex-col items-center gap-3 border-t border-sky-100 pt-8 text-center sm:flex-row sm:justify-between sm:text-left">
          <p className="text-sm text-slate-400">RxSmart — ดูแลอุปกรณ์ IoT อย่างง่ายดาย</p>
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
