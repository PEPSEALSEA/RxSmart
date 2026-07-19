"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FadeIn from "@/components/ui/FadeIn";
import {
  bridgeFrameUrl,
  fetchBridgeState,
  loadBridgeUrl,
  LocalBridgeMode,
  LocalBridgeState,
  mapLocalJointsToFrame,
  pingBridge,
  postSensorMappingAction,
  saveBridgeUrl,
  setBridgeMode,
  setBridgeSkeletonDebug,
} from "@/lib/local-bridge";
import { SensorFrame } from "@/lib/pose-physics";
import {
  CALIBRATION_STEP_LABELS,
  ChannelMap,
  parseChannelMap,
  saveStoredChannelMap,
  SensorMappingState,
} from "@/lib/sensor-mapping";

interface LocalBridgePanelProps {
  onConnectChange: (connected: boolean) => void;
  onFrameUpdate: (frame: SensorFrame) => void;
  onStateUpdate: (state: LocalBridgeState | null) => void;
  autoConnect?: boolean;
  defaultMode?: LocalBridgeMode;
  showPreview?: boolean;
  variant?: "full" | "imu";
}

const MODES: { id: LocalBridgeMode; label: string }[] = [
  { id: "CAMERA_ONLY", label: "Camera" },
  { id: "IOT_ONLY", label: "IMU" },
  { id: "FUSION", label: "Fusion" },
];

const RECONNECT_MS = 2000;
const WAITING_MSG =
  "รอ Python bridge — เปิดเว็บก่อนหรือหลังก็ได้ ระบบจะลองเชื่อมใหม่อัตโนมัติ";

export default function LocalBridgePanel({
  onConnectChange,
  onFrameUpdate,
  onStateUpdate,
  autoConnect = false,
  defaultMode,
  showPreview = true,
  variant = "full",
}: LocalBridgePanelProps) {
  const [bridgeUrl, setBridgeUrl] = useState(loadBridgeUrl);
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [polling, setPolling] = useState(false);
  const [seeking, setSeeking] = useState(autoConnect);
  const [state, setState] = useState<LocalBridgeState | null>(null);
  const [frameTick, setFrameTick] = useState(0);
  const [error, setError] = useState("");
  const [mapping, setMapping] = useState<SensorMappingState | null>(null);
  const [channelMap, setChannelMap] = useState<ChannelMap>(() => parseChannelMap(undefined));
  const [mapBusy, setMapBusy] = useState("");
  const [mapMessage, setMapMessage] = useState("");
  const autoRecheckAt = useRef(0);
  const connectInFlight = useRef(false);
  const channelMapRef = useRef(channelMap);
  const imuStats = variant === "imu";

  useEffect(() => {
    channelMapRef.current = channelMap;
  }, [channelMap]);

  const connect = useCallback(
    async (opts?: { quiet?: boolean }) => {
      if (connectInFlight.current) return;
      connectInFlight.current = true;
      setSeeking(true);
      if (!opts?.quiet) {
        setChecking(true);
        setError("");
      }
      saveBridgeUrl(bridgeUrl);
      try {
        const ok = await pingBridge(bridgeUrl);
        if (!ok) {
          setConnected(false);
          setPolling(false);
          onConnectChange(false);
          onStateUpdate(null);
          setError(WAITING_MSG);
          return;
        }

        if (defaultMode) {
          try {
            await setBridgeMode(bridgeUrl, defaultMode);
          } catch (err) {
            setError(err instanceof Error ? err.message : "สลับโหมด IMU ไม่สำเร็จ");
          }
        }

        setConnected(true);
        setPolling(true);
        setError("");
        onConnectChange(true);
      } finally {
        connectInFlight.current = false;
        setChecking(false);
      }
    },
    [bridgeUrl, defaultMode, onConnectChange, onStateUpdate],
  );

  // Keep retrying until Python is up (open site first or Python first — both OK).
  useEffect(() => {
    if (!seeking || connected) return;
    void connect({ quiet: true });
    const interval = window.setInterval(() => {
      void connect({ quiet: true });
    }, RECONNECT_MS);
    return () => window.clearInterval(interval);
  }, [seeking, connected, connect]);

  useEffect(() => {
    if (!polling || !connected) return;

    let cancelled = false;
    let failStreak = 0;

    const poll = async () => {
      try {
        const next = await fetchBridgeState(bridgeUrl);
        if (cancelled) return;
        failStreak = 0;
        setState(next);
        onStateUpdate(next);

        let activeMap = channelMapRef.current;
        if (next.sensor_mapping) {
          setMapping(next.sensor_mapping);
          activeMap = parseChannelMap(next.sensor_mapping.channel_map);
          setChannelMap(activeMap);
          saveStoredChannelMap(activeMap);
        } else if (next.joints?.sensor_map) {
          activeMap = parseChannelMap(next.joints.sensor_map);
          setChannelMap(activeMap);
        }

        onFrameUpdate(mapLocalJointsToFrame(next.joints, activeMap));

        if (
          imuStats &&
          next.sensor_mapping &&
          next.sensor_mapping.buffer_samples >= 15 &&
          Date.now() - autoRecheckAt.current > 30_000
        ) {
          autoRecheckAt.current = Date.now();
          void postSensorMappingAction(bridgeUrl, "auto_recheck").catch(() => undefined);
        }
        setFrameTick(Date.now());
        setError("");
      } catch {
        if (cancelled) return;
        failStreak += 1;
        // Tolerate a single blip; then drop and let reconnect loop recover.
        if (failStreak < 2) return;
        setConnected(false);
        setPolling(false);
        setSeeking(true);
        onConnectChange(false);
        setError("ขาดการเชื่อมต่อ — กำลังลองใหม่เมื่อ Python พร้อม…");
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), 400);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [polling, connected, bridgeUrl, onConnectChange, onFrameUpdate, onStateUpdate, imuStats]);

  const runMapAction = async (
    action: "reset" | "auto_recheck" | "calibrate_start" | "calibrate_next",
  ) => {
    setMapBusy(action);
    setMapMessage("");
    try {
      const data = await postSensorMappingAction(bridgeUrl, action);
      if (data.channel_map) {
        const parsed = parseChannelMap(data.channel_map as Record<string, string>);
        setChannelMap(parsed);
        saveStoredChannelMap(parsed);
      }
      setMapping(data as SensorMappingState);
      if (action === "auto_recheck") {
        setMapMessage(
          data.updated
            ? `อัปเดต mapping แล้ว (confidence ${Math.round((data.confidence as number) * 100)}%)`
            : `mapping ปัจจุบันดีอยู่ (${Math.round((data.confidence as number) * 100)}%)`,
        );
      } else if (action === "calibrate_next") {
        setMapMessage(
          data.step === "complete"
            ? "Auto-calibrate เสร็จแล้ว"
            : `ขั้นตอนถัดไป: ${CALIBRATION_STEP_LABELS[data.step as string] ?? data.step}`,
        );
      } else if (action === "calibrate_start") {
        setMapMessage(`เริ่ม calibrate — ${CALIBRATION_STEP_LABELS.neutral}`);
      } else {
        setMapMessage("รีเซ็ตเป็น firmware default แล้ว");
      }
    } catch (err) {
      setMapMessage(err instanceof Error ? err.message : "sensor map ไม่สำเร็จ");
    } finally {
      setMapBusy("");
    }
  };

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

  const handleSkeletonDebug = async (enabled: boolean) => {
    try {
      await setBridgeSkeletonDebug(bridgeUrl, enabled);
      const next = await fetchBridgeState(bridgeUrl);
      setState(next);
      onStateUpdate(next);
      setFrameTick(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "สลับ skeleton debug ไม่สำเร็จ");
    }
  };

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="cohere-card p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex-1">
              <p className="cohere-mono-label text-[11px]">
                {imuStats
                  ? "Local USB — Python bridge (ไม่ผ่าน Cloudflare)"
                  : "Local Bridge — เชื่อม Web กับ Python บนเครื่องนี้"}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  value={bridgeUrl}
                  onChange={(e) => setBridgeUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8766"
                  className="cohere-input w-full font-mono-label text-sm sm:max-w-md"
                />
                <button
                  type="button"
                  onClick={() => void connect()}
                  disabled={checking}
                  className="cohere-btn-primary px-5 py-2.5 text-sm disabled:opacity-50"
                >
                  {checking
                    ? "กำลังเชื่อม…"
                    : connected
                      ? "เชื่อมต่อแล้ว"
                      : seeking
                        ? "กำลังรอ Python…"
                        : "เชื่อมต่อเครื่องนี้"}
                </button>
              </div>
              <p className="mt-3 text-sm text-cohere-body-muted">
                {imuStats
                  ? "เสียบ Pico / ESP32 ทาง USB — เปิดเว็บหรือรัน python ก่อนก็ได้ ระบบเชื่อมใหม่อัตโนมัติ"
                  : "เปิดเว็บก่อนหรือรัน Python ก่อนก็ได้ — bridge จะลองเชื่อม 127.0.0.1:8766 เอง"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  connected
                    ? "bg-cohere-deep-green animate-pulse-soft"
                    : seeking
                      ? "bg-cohere-deep-green/40 animate-pulse-soft"
                      : "bg-cohere-hairline"
                }`}
              />
              <span className="cohere-mono-label text-[11px]">
                {connected ? "Bridge online" : seeking ? "รอ Python…" : "ยังไม่เชื่อม"}
              </span>
            </div>
          </div>

          {error && (
            <p
              className={`mt-4 animate-fade-in-only rounded-cohere-sm px-4 py-2.5 text-xs ${
                seeking && !connected
                  ? "border border-cohere-hairline bg-cohere-pale-green text-cohere-ink"
                  : "border border-cohere-error/20 bg-cohere-error/5 text-cohere-error"
              }`}
            >
              {error}
            </p>
          )}

          {!connected && !seeking && (
            <ol className="mt-5 space-y-2 border-t border-cohere-hairline pt-5 text-sm text-cohere-body-muted">
              <li>1. <code className="font-mono-label text-xs text-cohere-ink">cd rxsmart-local</code></li>
              <li>2. <code className="font-mono-label text-xs text-cohere-ink">pip install -r requirements.txt</code></li>
              <li>3. <code className="font-mono-label text-xs text-cohere-ink">python main.py</code></li>
              <li>4. กด &quot;เชื่อมต่อเครื่องนี้&quot; ด้านบน (หรือเปิดโหมดที่มี auto-connect)</li>
            </ol>
          )}
        </div>
      </FadeIn>

      {connected && state && (
        <FadeIn delay={80} className="space-y-4">
          {!imuStats && (
            <div className="flex flex-wrap items-center gap-2">
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => void handleMode(mode.id)}
                  data-active={state.mode === mode.id}
                  className="cohere-btn-pill-outline text-xs"
                >
                  {mode.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => void handleSkeletonDebug(!(state.skeleton_debug ?? false))}
                data-active={state.skeleton_debug ?? false}
                className="cohere-btn-pill-outline text-xs"
              >
                Skeleton debug
              </button>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            {imuStats ? (
              <>
                {[
                  { label: "IoT status", value: state.iot_status },
                  { label: "Poll rate", value: `${state.iot_poll_rate_hz} Hz` },
                  { label: "Latency", value: `${state.iot_latency_ms} ms` },
                  { label: "Session", value: state.joints?.session_state ?? "—" },
                  { label: "Reps", value: state.joints ? `${state.joints.rep_count ?? 0}/${state.joints.rep_target ?? 0}` : "—" },
                  { label: "Confidence", value: state.joints ? `${Math.round(state.joints.confidence * 100)}%` : "—" },
                ].map((item) => (
                  <div key={item.label} className="cohere-product-card py-3">
                    <p className="cohere-mono-label text-[10px]">{item.label}</p>
                    <p className="mt-1 font-mono-label text-sm font-medium text-cohere-ink">{item.value}</p>
                  </div>
                ))}
              </>
            ) : (
              <>
                {[
                  { label: "FPS", value: `${state.camera_fps}` },
                  { label: "Latency", value: `${state.camera_latency_ms} ms` },
                  { label: "Poses", value: `${state.pose_count ?? 0} / ${state.max_poses ?? 4}` },
                  { label: "Confidence", value: state.joints ? `${Math.round(state.joints.confidence * 100)}%` : "—" },
                  { label: "Camera", value: state.camera_status },
                  { label: "Debug", value: state.skeleton_debug ? "ON" : "OFF" },
                  {
                    label: "Palm L/R",
                    value: state.joints
                      ? `${state.joints.palm_left_ok ? "OK" : "—"}/${state.joints.palm_right_ok ? "OK" : "—"}`
                      : "—",
                  },
                ].map((item) => (
                  <div key={item.label} className="cohere-product-card py-3">
                    <p className="cohere-mono-label text-[10px]">{item.label}</p>
                    <p className="mt-1 font-mono-label text-sm font-medium text-cohere-ink">{item.value}</p>
                  </div>
                ))}
              </>
            )}
          </div>

          {showPreview && (
            <div className="overflow-hidden rounded-cohere-lg border border-cohere-hairline bg-cohere-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={bridgeFrameUrl(bridgeUrl, frameTick)}
                alt="Camera feed from local Python bridge"
                className={`aspect-video w-full object-contain animate-fade-in-only ${
                  state.skeleton_debug ? "bg-cohere-black" : "bg-cohere-primary"
                }`}
              />
              {state.skeleton_debug && (
                <p className="cohere-mono-label border-t border-cohere-primary bg-cohere-black px-4 py-2.5 text-center text-[10px] text-cohere-muted">
                  Skeleton debug — video hidden, joints only
                </p>
              )}
            </div>
          )}
          {imuStats && connected && (
            <div className="cohere-card p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="cohere-mono-label text-[11px]">
                    Sensor mapping · distal-first setup
                  </p>
                  <p className="mt-2 text-sm text-cohere-body-muted">
                    confidence{" "}
                    {mapping ? `${Math.round(mapping.confidence * 100)}%` : "—"}
                    {mapping?.calibration_step && mapping.calibration_step !== "idle"
                      ? ` · ขั้นตอน: ${CALIBRATION_STEP_LABELS[mapping.calibration_step] ?? mapping.calibration_step}`
                      : ""}
                  </p>
                  <p className="mt-1 text-xs text-cohere-muted">
                    ขยับทั้งสองข้างพร้อมกัน — ระบบเดาซ้าย–ขวาให้
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={Boolean(mapBusy)}
                    onClick={() => void runMapAction("auto_recheck")}
                    className="cohere-btn-pill-outline text-xs disabled:opacity-50"
                  >
                    {mapBusy === "auto_recheck" ? "…" : "Auto recheck"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(mapBusy)}
                    onClick={() => void runMapAction("calibrate_start")}
                    className="cohere-btn-pill-outline text-xs disabled:opacity-50"
                  >
                    เริ่ม calibrate
                  </button>
                  <button
                    type="button"
                    disabled={
                      Boolean(mapBusy) ||
                      !mapping?.calibration_step ||
                      mapping.calibration_step === "idle"
                    }
                    onClick={() => void runMapAction("calibrate_next")}
                    className="cohere-btn-primary px-4 py-2 text-xs disabled:opacity-50"
                  >
                    {mapBusy === "calibrate_next" ? "…" : "ขั้นถัดไป"}
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(mapBusy)}
                    onClick={() => void runMapAction("reset")}
                    className="cohere-btn-pill-outline border-dashed text-xs disabled:opacity-50"
                  >
                    Reset default
                  </button>
                </div>
              </div>
              {mapMessage && (
                <p className="mt-4 rounded-cohere-sm bg-cohere-pale-green px-4 py-2.5 text-xs text-cohere-ink">{mapMessage}</p>
              )}
            </div>
          )}
        </FadeIn>
      )}
    </div>
  );
}
