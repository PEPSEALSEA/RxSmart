"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

interface Device {
  device_id: string;
  wifi_ssid: string;
  last_online: string;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export default function Home() {
  const [loadingFix, setLoadingFix] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [devicesError, setDevicesError] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "https://rxsmart-worker.sealseapep.workers.dev";
  const selectedDevice = useMemo(
    () => devices.find((device) => device.device_id === selectedDeviceId) || null,
    [devices, selectedDeviceId],
  );

  const isOnline = (isoString: string) => {
    const lastOnline = new Date(isoString).getTime();
    if (Number.isNaN(lastOnline)) return false;
    return currentTime - lastOnline < 5 * 60 * 1000;
  };

  const fetchDevices = useCallback(async () => {
    setLoadingDevices(true);
    setDevicesError("");
    setCurrentTime(Date.now());
    try {
      const res = await fetch(`${apiUrl}/api/devices`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch devices");
      setDevices(data.devices || []);
    } catch (err) {
      setDevicesError(getErrorMessage(err));
    } finally {
      setLoadingDevices(false);
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

  const openDevice = (device: Device) => {
    setSelectedDeviceId(device.device_id);
    setWifiSsid(device.wifi_ssid === "Unknown" ? "" : device.wifi_ssid);
    setWifiPassword("");
    setActionMessage("");
    setActionError("");
  };

  const fixSheet = async () => {
    setLoadingFix(true);
    setMessage("");
    setError("");

    try {
      const res = await fetch(`${apiUrl}/api/fix-sheet`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fix sheet");
      setMessage(data.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoadingFix(false);
    }
  };

  const queueCommand = async (command: "SET_WIFI" | "CLEAR_WIFI", body: Record<string, string> = {}) => {
    if (!selectedDevice) return;

    setActionLoading(command);
    setActionMessage("");
    setActionError("");

    try {
      const res = await fetch(`${apiUrl}/api/devices/${encodeURIComponent(selectedDevice.device_id)}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to queue command");
      setActionMessage(data.message || "Command queued.");
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setActionLoading("");
    }
  };

  const submitWifi = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await queueCommand("SET_WIFI", {
      wifi_ssid: wifiSsid.trim(),
      wifi_password: wifiPassword,
    });
  };

  const removeDevice = async () => {
    if (!selectedDevice) return;
    if (!confirm(`Remove ${selectedDevice.device_id} from the dashboard? This does not erase the physical board.`)) return;

    setActionLoading("REMOVE");
    setActionMessage("");
    setActionError("");

    try {
      const res = await fetch(`${apiUrl}/api/devices/${encodeURIComponent(selectedDevice.device_id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to remove board");
      setDevices((current) => current.filter((device) => device.device_id !== selectedDevice.device_id));
      setSelectedDeviceId(null);
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setActionLoading("");
    }
  };

  const checkSelectedStatus = async () => {
    await fetchDevices();
    setActionMessage("Status refreshed from the dashboard data.");
  };

  const onlineCount = devices.filter((device) => isOnline(device.last_online)).length;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 p-6 font-sans relative overflow-hidden">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-600 rounded-full blur-[120px] opacity-20 pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-rose-600 rounded-full blur-[120px] opacity-20 pointer-events-none" />

      <div className="relative z-10 max-w-6xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row justify-between items-center bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl">
          <div>
            <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-rose-400">
              IoT Control Center
            </h1>
            <p className="text-sm text-slate-400">Click a board to edit WiFi, clear WiFi, refresh status, or remove it.</p>
          </div>

          <div className="flex items-center space-x-6 mt-4 md:mt-0">
            <div className="text-center">
              <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Total Boards</p>
              <p className="text-2xl font-bold text-white">{devices.length}</p>
            </div>
            <div className="w-px h-10 bg-white/10" />
            <div className="text-center">
              <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Online</p>
              <p className="text-2xl font-bold text-emerald-400">{onlineCount}</p>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <section className="lg:col-span-2 bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Boards</h2>
              <button onClick={fetchDevices} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                {loadingDevices ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {loadingDevices && devices.length === 0 ? (
              <div className="flex justify-center items-center h-40">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
              </div>
            ) : devicesError ? (
              <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl text-sm">
                Error loading devices: {devicesError}
              </div>
            ) : devices.length === 0 ? (
              <div className="text-center text-slate-500 py-10">No boards found in the database.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {devices.map((device) => {
                  const online = isOnline(device.last_online);
                  return (
                    <button
                      key={device.device_id}
                      onClick={() => openDevice(device)}
                      className="text-left rounded-2xl border border-white/10 bg-slate-900/60 p-5 hover:bg-white/10 hover:border-indigo-400/40 transition-colors"
                    >
                      <div className="flex justify-between gap-3">
                        <p className="font-mono text-sm text-white break-all">{device.device_id}</p>
                        <span className={`shrink-0 h-fit px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                          online
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                            : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        }`}>
                          {online ? "Online" : "Offline"}
                        </span>
                      </div>
                      <div className="mt-4 space-y-2 text-sm text-slate-400">
                        <p>WiFi: <span className="text-slate-200">{device.wifi_ssid}</span></p>
                        <p>Last online: <span className="text-slate-200">{new Date(device.last_online).toLocaleString()}</span></p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl h-fit">
            <h2 className="text-xl font-semibold mb-6">System Tools</h2>
            <div className="bg-slate-900/50 p-5 rounded-2xl border border-white/5">
              <h3 className="text-sm font-semibold mb-2">Google Sheets Auto-Fix</h3>
              <p className="text-xs text-slate-400 mb-5">
                Restores telemetry headers and ensures the Devices and Commands tabs exist.
              </p>
              <button
                onClick={fixSheet}
                disabled={loadingFix}
                className="w-full py-2.5 px-4 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-60"
              >
                {loadingFix ? "Processing..." : "Run Auto-Fix"}
              </button>

              {message && <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-xs">{message}</div>}
              {error && <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">{error}</div>}
            </div>
          </section>
        </div>
      </div>

      {selectedDevice && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm p-4 flex items-center justify-center">
          <section className="w-full max-w-xl rounded-3xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">Board Controls</h2>
                <p className="font-mono text-xs text-slate-400 mt-1 break-all">{selectedDevice.device_id}</p>
              </div>
              <button onClick={() => setSelectedDeviceId(null)} className="text-slate-400 hover:text-white">Close</button>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-6">
              <div className="rounded-2xl bg-white/5 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500">Status</p>
                <p className={isOnline(selectedDevice.last_online) ? "text-emerald-400 font-semibold" : "text-rose-400 font-semibold"}>
                  {isOnline(selectedDevice.last_online) ? "Online" : "Offline"}
                </p>
              </div>
              <div className="rounded-2xl bg-white/5 p-4">
                <p className="text-xs uppercase tracking-wider text-slate-500">Current WiFi</p>
                <p className="text-slate-200 truncate">{selectedDevice.wifi_ssid}</p>
              </div>
            </div>

            <form onSubmit={submitWifi} className="mt-6 space-y-4">
              <div>
                <label className="text-sm text-slate-300" htmlFor="wifiSsid">New WiFi SSID</label>
                <input
                  id="wifiSsid"
                  value={wifiSsid}
                  onChange={(event) => setWifiSsid(event.target.value)}
                  required
                  className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm outline-none focus:border-indigo-400"
                />
              </div>
              <div>
                <label className="text-sm text-slate-300" htmlFor="wifiPassword">New WiFi Password</label>
                <input
                  id="wifiPassword"
                  value={wifiPassword}
                  onChange={(event) => setWifiPassword(event.target.value)}
                  type="password"
                  placeholder="Leave blank for open network"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm outline-none focus:border-indigo-400"
                />
              </div>
              <button
                disabled={actionLoading === "SET_WIFI"}
                className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
              >
                {actionLoading === "SET_WIFI" ? "Queueing..." : "Save New WiFi To Board"}
              </button>
            </form>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              <button onClick={checkSelectedStatus} className="rounded-xl bg-slate-800 px-4 py-3 text-sm hover:bg-slate-700">
                Check Status
              </button>
              <button
                onClick={() => queueCommand("CLEAR_WIFI")}
                disabled={actionLoading === "CLEAR_WIFI"}
                className="rounded-xl bg-amber-600/90 px-4 py-3 text-sm font-semibold hover:bg-amber-500 disabled:opacity-60"
              >
                {actionLoading === "CLEAR_WIFI" ? "Queueing..." : "Clear Board WiFi"}
              </button>
              <button
                onClick={removeDevice}
                disabled={actionLoading === "REMOVE"}
                className="rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold hover:bg-rose-500 disabled:opacity-60"
              >
                {actionLoading === "REMOVE" ? "Removing..." : "Remove Board"}
              </button>
            </div>

            <p className="mt-4 text-xs text-slate-500">
              WiFi commands apply when the board is online and checks the cloud. Clear WiFi restarts the board into setup mode.
            </p>
            {actionMessage && <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-xs">{actionMessage}</div>}
            {actionError && <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs">{actionError}</div>}
          </section>
        </div>
      )}
    </main>
  );
}
