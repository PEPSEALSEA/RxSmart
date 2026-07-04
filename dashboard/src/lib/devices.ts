export type DevicePlatform = "esp32" | "pico2w";

export interface Device {
  device_id: string;
  wifi_ssid: string;
  last_online: string;
  platform?: DevicePlatform;
}

export function getApiUrl() {
  return process.env.NEXT_PUBLIC_API_URL || "https://rxsmart-worker.sealseapep.workers.dev";
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

export function inferDevicePlatform(deviceId: string, explicit?: string): DevicePlatform {
  const raw = String(explicit || "").toLowerCase().trim();
  if (raw === "pico2w" || raw === "pico_2w" || raw === "pico-2w") return "pico2w";
  if (raw === "esp32") return "esp32";

  const id = deviceId.toUpperCase();
  if (id.startsWith("PICO2W_")) return "pico2w";
  if (id.startsWith("ESP32_")) return "esp32";
  return "esp32";
}

export function getDevicePlatformLabel(platform: DevicePlatform): string {
  return platform === "pico2w" ? "Pico 2 W" : "ESP32";
}

export function isDeviceOnline(lastOnline: string, now = Date.now()) {
  const timestamp = new Date(lastOnline).getTime();
  if (Number.isNaN(timestamp)) return false;
  return now - timestamp < 5 * 60 * 1000;
}

export function formatLastSeen(isoString: string) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "ไม่ทราบ";
  return date.toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
