"use client";

import { useCallback, useEffect, useState } from "react";
import FadeIn from "@/components/ui/FadeIn";
import {
  bridgeFrameUrl,
  fetchBridgeState,
  loadBridgeUrl,
  LocalBridgeMode,
  LocalBridgeState,
  mapLocalJointsToFrame,
  pingBridge,
  saveBridgeUrl,
  setBridgeMode,
} from "@/lib/local-bridge";
import { SensorFrame } from "@/lib/pose-physics";

interface LocalBridgePanelProps {
  onConnectChange: (connected: boolean) => void;
  onFrameUpdate: (frame: SensorFrame) => void;
  onStateUpdate: (state: LocalBridgeState | null) => void;
}

const MODES: { id: LocalBridgeMode; label: string }[] = [
  { id: "CAMERA_ONLY", label: "Camera" },
  { id: "IOT_ONLY", label: "IMU" },
  { id: "FUSION", label: "Fusion" },
];

export default function LocalBridgePanel({
  onConnectChange,
  onFrameUpdate,
  onStateUpdate,
}: LocalBridgePanelProps) {
  const [bridgeUrl, setBridgeUrl] = useState(loadBridgeUrl);
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [polling, setPolling] = useState(false);
  const [state, setState] = useState<LocalBridgeState | null>(null);
  const [frameTick, setFrameTick] = useState(0);
  const [error, setError] = useState("");

  const connect = useCallback(async () => {
    setChecking(true);
    setError("");
    saveBridgeUrl(bridgeUrl);
    const ok = await pingBridge(bridgeUrl);
    setChecking(false);
    setConnected(ok);
    onConnectChange(ok);
    if (!ok) {
      setError("เชื่อมต่อไม่ได้ — รัน python main.py ใน rxsmart-local ก่อน");
      onStateUpdate(null);
      return;
    }
    setPolling(true);
  }, [bridgeUrl, onConnectChange, onStateUpdate]);

  useEffect(() => {
    if (!polling || !connected) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const next = await fetchBridgeState(bridgeUrl);
        if (cancelled) return;
        setState(next);
        onStateUpdate(next);
        onFrameUpdate(
          mapLocalJointsToFrame(next.joints),
        );
        setFrameTick(Date.now());
        setError("");
      } catch (err) {
        if (cancelled) return;
        setConnected(false);
        setPolling(false);
        onConnectChange(false);
        setError(err instanceof Error ? err.message : "การเชื่อมต่อขาด");
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 400);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [polling, connected, bridgeUrl, onConnectChange, onFrameUpdate, onStateUpdate]);

  const handleMode = async (mode: LocalBridgeMode) => {
    try {
      await setBridgeMode(bridgeUrl, mode);
      const next = await fetchBridgeState(bridgeUrl);
      setState(next);
      onStateUpdate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "สลับโหมดไม่สำเร็จ");
    }
  };

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex-1">
              <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
                Local Bridge — เชื่อม Web กับ Python บนเครื่องนี้
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  value={bridgeUrl}
                  onChange={(e) => setBridgeUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8766"
                  className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 font-mono text-sm outline-none focus:border-neutral-400 sm:max-w-md"
                />
                <button
                  type="button"
                  onClick={() => void connect()}
                  disabled={checking}
                  className="rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50"
                >
                  {checking ? "กำลังเชื่อม…" : connected ? "เชื่อมต่อแล้ว" : "เชื่อมต่อเครื่องนี้"}
                </button>
              </div>
              <p className="mt-2 text-xs text-neutral-400">
                GitHub Pages เรียก <code className="rounded bg-neutral-100 px-1">127.0.0.1:8766</code> ได้
                เมื่อเปิดเว็บและรัน Python บน PC เครื่องเดียวกัน
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  connected ? "bg-emerald-500 animate-pulse-soft" : "bg-neutral-300"
                }`}
              />
              <span className="text-xs font-medium text-neutral-500">
                {connected ? "Bridge online" : "รอ Python bridge"}
              </span>
            </div>
          </div>

          {error && (
            <p className="mt-3 animate-fade-in-only rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          )}

          {!connected && (
            <ol className="mt-4 space-y-1.5 border-t border-neutral-100 pt-4 text-sm text-neutral-600">
              <li>1. <code className="text-xs">cd rxsmart-local</code></li>
              <li>2. <code className="text-xs">pip install -r requirements.txt</code></li>
              <li>3. <code className="text-xs">python main.py</code></li>
              <li>4. กด &quot;เชื่อมต่อเครื่องนี้&quot; ด้านบน</li>
            </ol>
          )}
        </div>
      </FadeIn>

      {connected && state && (
        <FadeIn delay={80} className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => void handleMode(mode.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  state.mode === mode.id
                    ? "bg-neutral-900 text-white"
                    : "border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50"
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {[
              { label: "FPS", value: `${state.camera_fps}` },
              { label: "Latency", value: `${state.camera_latency_ms} ms` },
              { label: "Confidence", value: state.joints ? `${Math.round(state.joints.confidence * 100)}%` : "—" },
              { label: "Camera", value: state.camera_status },
              { label: "IoT", value: state.iot_status },
              { label: "Source", value: state.joints?.source ?? "—" },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-xl border border-neutral-200 bg-white px-3 py-2.5"
              >
                <p className="text-[10px] uppercase tracking-wider text-neutral-400">{item.label}</p>
                <p className="mt-0.5 font-mono text-sm font-semibold text-neutral-900">{item.value}</p>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-950 shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={bridgeFrameUrl(bridgeUrl, frameTick)}
              alt="Camera feed from local Python bridge"
              className="aspect-video w-full object-contain animate-fade-in-only"
            />
          </div>
        </FadeIn>
      )}
    </div>
  );
}
