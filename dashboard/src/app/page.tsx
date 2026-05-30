"use client";

import { useState, useEffect } from 'react';

interface Device {
  device_id: string;
  wifi_ssid: string;
  last_online: string;
}

export default function Home() {
  const [loadingFix, setLoadingFix] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [devicesError, setDevicesError] = useState('');

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'https://rxsmart-worker.sealseapep.workers.dev';

  const fetchDevices = async () => {
    setLoadingDevices(true);
    setDevicesError('');
    try {
      const res = await fetch(`${apiUrl}/api/devices`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch devices');
      setDevices(data.devices || []);
    } catch (err: any) {
      setDevicesError(err.message);
    } finally {
      setLoadingDevices(false);
    }
  };

  useEffect(() => {
    fetchDevices();
    const interval = setInterval(fetchDevices, 30000); // refresh every 30 seconds
    return () => clearInterval(interval);
  }, [apiUrl]);

  const fixSheet = async () => {
    setLoadingFix(true);
    setMessage('');
    setError('');

    try {
      const res = await fetch(`${apiUrl}/api/fix-sheet`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fix sheet');
      setMessage(data.message);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingFix(false);
    }
  };

  const isOnline = (isoString: string) => {
    const lastOnline = new Date(isoString).getTime();
    const now = Date.now();
    return (now - lastOnline) < 5 * 60 * 1000; // Online if updated within last 5 minutes
  };

  const onlineCount = devices.filter(d => isOnline(d.last_online)).length;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 p-6 font-sans relative overflow-hidden">
      {/* Background Gradients */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-600 rounded-full blur-[120px] opacity-20 pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-rose-600 rounded-full blur-[120px] opacity-20 pointer-events-none"></div>

      <div className="relative z-10 max-w-5xl mx-auto space-y-8">
        
        {/* Header Section */}
        <header className="flex flex-col md:flex-row justify-between items-center bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl">
          <div className="flex items-center space-x-4 mb-4 md:mb-0">
            <div className="p-3 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-rose-400">
                IoT Control Center
              </h1>
              <p className="text-sm text-slate-400">ESP32 & Google Sheets Telemetry</p>
            </div>
          </div>

          <div className="flex items-center space-x-6">
            <div className="text-center">
              <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Total Devices</p>
              <p className="text-2xl font-bold text-white">{devices.length}</p>
            </div>
            <div className="w-px h-10 bg-white/10"></div>
            <div className="text-center">
              <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Online</p>
              <p className="text-2xl font-bold text-emerald-400 flex items-center justify-center">
                <span className="w-2 h-2 rounded-full bg-emerald-500 mr-2 animate-pulse"></span>
                {onlineCount}
              </p>
            </div>
          </div>
        </header>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Device List Section */}
          <div className="lg:col-span-2 bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-indigo-400" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z" />
                </svg>
                Connected Devices
              </h2>
              <button onClick={fetchDevices} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className={`h-4 w-4 mr-1 ${loadingDevices ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Refresh
              </button>
            </div>

            {loadingDevices && devices.length === 0 ? (
              <div className="flex justify-center items-center h-40">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
              </div>
            ) : devicesError ? (
              <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl text-sm">
                Error loading devices: {devicesError}
              </div>
            ) : devices.length === 0 ? (
              <div className="text-center text-slate-500 py-10">
                No devices found in the database.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 text-slate-400 text-sm">
                      <th className="pb-3 px-4 font-medium">Device ID</th>
                      <th className="pb-3 px-4 font-medium">WiFi Network</th>
                      <th className="pb-3 px-4 font-medium">Last Online</th>
                      <th className="pb-3 px-4 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((device, idx) => (
                      <tr key={idx} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                        <td className="py-4 px-4 font-mono text-sm">{device.device_id}</td>
                        <td className="py-4 px-4 text-sm text-slate-300">
                          <span className="bg-slate-800 px-2 py-1 rounded-md text-xs">{device.wifi_ssid}</span>
                        </td>
                        <td className="py-4 px-4 text-sm text-slate-400">
                          {new Date(device.last_online).toLocaleString()}
                        </td>
                        <td className="py-4 px-4">
                          {isOnline(device.last_online) ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              Online
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                              Offline
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Tools & Settings Section */}
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 p-6 rounded-3xl shadow-xl h-fit">
            <h2 className="text-xl font-semibold mb-6 flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-rose-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
              System Tools
            </h2>
            
            <div className="bg-slate-900/50 p-5 rounded-2xl border border-white/5">
              <h3 className="text-sm font-semibold mb-2">Google Sheets Auto-Fix</h3>
              <p className="text-xs text-slate-400 mb-5">
                Restores standard headers (Timestamp, Device_ID, Sensor_Value, Status, WiFi_SSID) to Row 1 without affecting data rows.
              </p>
              
              <button
                onClick={fixSheet}
                disabled={loadingFix}
                className={`w-full py-2.5 px-4 rounded-xl text-sm font-semibold transition-all duration-300 transform hover:scale-[1.02] active:scale-[0.98] ${
                  loadingFix 
                  ? 'bg-indigo-600/50 cursor-not-allowed' 
                  : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 shadow-lg shadow-indigo-500/25 text-white'
                }`}
              >
                {loadingFix ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Processing...
                  </span>
                ) : '✨ Run Auto-Fix'}
              </button>

              {message && (
                <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-xs flex items-start">
                  <span className="mr-1.5">✓</span>
                  {message}
                </div>
              )}
              
              {error && (
                <div className="mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs flex items-start">
                  <span className="mr-1.5">⚠</span>
                  {error}
                </div>
              )}
            </div>
          </div>
          
        </div>
      </div>
    </main>
  );
}
